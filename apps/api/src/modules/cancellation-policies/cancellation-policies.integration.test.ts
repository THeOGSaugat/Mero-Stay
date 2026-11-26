import { randomUUID } from "node:crypto";
import { pino } from "pino";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../../app.js";
import { addDays, todayInKathmandu } from "../../domain/dates.js";
import { mapDatabaseError } from "../../lib/database-errors.js";
import type { ErrorResponseBody } from "../../lib/errors.js";
import { createPrismaClient } from "../../lib/prisma.js";
import { testAuthConfig } from "../../testing/auth-config.js";
import { resolveTestDatabase } from "../../testing/test-database.js";

/**
 * Gap 23 (ADR 0015): partners author cancellation policies; a booking item freezes the policy
 * resolved as listing → provider default → none; later edits never change existing bookings.
 * Setup that is not under test (verifying the provider, approving the listing: admin moderation is
 * Phase 12) is seeded with Prisma; everything under test goes through the API.
 */

vi.setConfig({ testTimeout: 300_000 });

const prisma = createPrismaClient(resolveTestDatabase().pooledUrl);
const app = createApp({
  logger: pino({ level: "silent" }),
  checkDatabase: () => Promise.resolve(),
  prisma,
  auth: testAuthConfig(),
});
afterAll(() => prisma.$disconnect());

interface Client {
  agent: ReturnType<typeof request.agent>;
  csrfToken: string;
  userId: string;
}
interface Partner extends Client {
  providerId: string;
}

const codeOf = (res: request.Response) => [res.status, (res.body as ErrorResponseBody).error?.code];
const dataOf = <T>(res: request.Response) => (res.body as { data: T }).data;

async function signUp(label: string): Promise<Client> {
  const agent = request.agent(app);
  const res = await agent.post("/api/v1/auth/register").send({
    email: `${label}-${randomUUID().slice(0, 8)}@test.local`,
    password: "a long test passphrase",
    fullName: `${label} Person`,
  });
  expect(res.status).toBe(201);
  const body = res.body as { data: { user: { id: string }; csrfToken: string } };
  return { agent, csrfToken: body.data.csrfToken, userId: body.data.user.id };
}

function call(who: Client, method: "get" | "post" | "patch" | "put", url: string, body?: object) {
  const req = who.agent[method](url).set("X-CSRF-Token", who.csrfToken);
  return body === undefined ? req : req.send(body);
}

/** A verified hotel partner (onboarded through the API; verification seeded). */
async function verifiedPartner(label: string): Promise<Partner> {
  const who = await signUp(label);
  const res = await call(who, "post", "/api/v1/partner/onboarding", {
    providerTypeCode: "hotel",
    legalName: `${label} Hotels Pvt. Ltd.`,
    displayName: `${label} ${randomUUID().slice(0, 6)}`,
  });
  expect(res.status).toBe(201);
  const providerId = dataOf<{ id: string }>(res).id;
  await prisma.provider.update({
    where: { id: providerId },
    data: { status: "VERIFIED", verifiedAt: new Date() },
  });
  return { ...who, providerId };
}

const day = (n: number) => addDays(todayInKathmandu(), 10 + n);

/** A public, bookable room of this partner: created through the API, approval seeded. */
async function bookableRoom(
  partner: Partner,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const created = await call(partner, "post", "/api/v1/partner/listings", {
    listingTypeCode: "hotel_room",
    title: `Room ${randomUUID().slice(0, 6)}`,
    basePriceMinor: "350000",
    details: { maxAdults: 2 },
    ...extra,
  });
  expect(created.status).toBe(201);
  const id = dataOf<{ id: string }>(created).id;
  await prisma.listing.update({ where: { id }, data: { status: "APPROVED" } });
  const slots = await call(partner, "post", `/api/v1/partner/listings/${id}/slots`, {
    startDate: day(0),
    endDate: day(8),
    capacityTotal: 10,
  });
  expect(slots.status).toBe(201);
  return id;
}

const MODERATE = {
  name: "Moderate",
  description: "Full refund up to 3 days before; half up to 1 day before.",
  rules: [
    { minHoursBeforeStart: 72, refundBps: 10_000 },
    { minHoursBeforeStart: 24, refundBps: 5_000 },
  ],
};

async function createPolicy(partner: Partner, body: object = MODERATE): Promise<string> {
  const res = await call(partner, "post", "/api/v1/partner/cancellation-policies", body);
  expect(res.status).toBe(201);
  return dataOf<{ id: string }>(res).id;
}

type PublicPolicy = { id: string; name: string; source: string; rules: unknown } | null;
async function publicPolicy(listingId: string): Promise<PublicPolicy> {
  const res = await request(app).get(`/api/v1/listings/${listingId}`);
  expect(res.status).toBe(200);
  return dataOf<{ cancellationPolicy: PublicPolicy }>(res).cancellationPolicy;
}

type Snapshot = Record<string, unknown> | null;
/** A customer books one night of the listing; returns the item's frozen policy. */
async function bookOneNight(
  listingId: string,
  night: number,
): Promise<{ tripId: string; snapshot: Snapshot }> {
  const customer = await signUp("guest");
  const trip = await call(customer, "post", "/api/v1/trips", { currency: "NPR" });
  expect(trip.status).toBe(201);
  const tripId = dataOf<{ id: string }>(trip).id;
  const added = await call(customer, "post", `/api/v1/trips/${tripId}/items`, {
    listingId,
    startDate: day(night),
    endDate: day(night + 1),
    quantity: 1,
    paymentMethod: "pay_at_property",
  });
  expect(added.status).toBe(201);
  const items = dataOf<{ items: { cancellationPolicy: Snapshot }[] }>(added).items;
  return { tripId, snapshot: items[0]?.cancellationPolicy ?? null };
}

let partnerA: Partner;
let partnerB: Partner;

beforeAll(async () => {
  partnerA = await verifiedPartner("policya");
  partnerB = await verifiedPartner("policyb");
});

describe("gap 23: authoring, attaching and showing a policy", () => {
  it("a partner creates a policy and attaches it to a listing; customers see it on the listing", async () => {
    const policyId = await createPolicy(partnerA);
    const roomId = await bookableRoom(partnerA, { defaultCancellationPolicyId: policyId });
    const shown = await publicPolicy(roomId);
    expect(shown).toMatchObject({
      id: policyId,
      name: "Moderate",
      source: "listing",
      nonRefundable: false,
      rules: MODERATE.rules,
    });

    const listed = await call(partnerA, "get", "/api/v1/partner/cancellation-policies");
    const mine = dataOf<{ policies: { id: string; usage: unknown }[] }>(listed).policies;
    expect(mine.find((p) => p.id === policyId)?.usage).toEqual({
      listings: 1,
      providerDefault: false,
    });
  });

  it("the listing's own policy overrides the provider default; without one, the default applies", async () => {
    const providerDefault = await createPolicy(partnerA, { ...MODERATE, name: "House default" });
    const strict = await createPolicy(partnerA, {
      name: "Strict",
      rules: [{ minHoursBeforeStart: 168, refundBps: 5_000 }],
    });
    const setDefault = await call(
      partnerA,
      "put",
      "/api/v1/partner/cancellation-policies/default",
      {
        policyId: providerDefault,
      },
    );
    expect(dataOf<{ changed: boolean }>(setDefault).changed).toBe(true);

    const withOwn = await bookableRoom(partnerA, { defaultCancellationPolicyId: strict });
    const withoutOwn = await bookableRoom(partnerA);
    expect(await publicPolicy(withOwn)).toMatchObject({ id: strict, source: "listing" });
    expect(await publicPolicy(withoutOwn)).toMatchObject({
      id: providerDefault,
      source: "provider",
    });

    // Clearing the default leaves that listing with no policy at all.
    await call(partnerA, "put", "/api/v1/partner/cancellation-policies/default", {
      policyId: null,
    });
    expect(await publicPolicy(withoutOwn)).toBeNull();
  });

  it("a listing with no policy (and no provider default) says so explicitly: null, and bookings carry none", async () => {
    const roomId = await bookableRoom(partnerB);
    expect(await publicPolicy(roomId)).toBeNull();
    const { snapshot } = await bookOneNight(roomId, 0);
    expect(snapshot).toBeNull();
  });

  it("non-refundable policies have no tiers, and are shown as such", async () => {
    const id = await createPolicy(partnerB, { name: "Non-refundable", nonRefundable: true });
    const roomId = await bookableRoom(partnerB, { defaultCancellationPolicyId: id });
    expect(await publicPolicy(roomId)).toMatchObject({ nonRefundable: true, rules: [] });
  });
});

describe("gap 23: the booking freezes the resolved policy", () => {
  it("a later edit (rules and name) does not change an existing booking; a new booking gets the new terms", async () => {
    const policyId = await createPolicy(partnerA, { ...MODERATE, name: "Frozen test" });
    const roomId = await bookableRoom(partnerA, { defaultCancellationPolicyId: policyId });
    const first = await bookOneNight(roomId, 1);
    expect(first.snapshot).toMatchObject({
      policyId,
      name: "Frozen test",
      source: "listing",
      nonRefundable: false,
      rules: MODERATE.rules,
    });
    // Only the structured rule is stored: no refund amount is computed (refunds: Phase 14).
    expect(Object.keys(first.snapshot ?? {}).sort()).toEqual(
      ["capturedAt", "description", "name", "nonRefundable", "policyId", "rules", "source"].sort(),
    );

    const edited = await call(
      partnerA,
      "patch",
      `/api/v1/partner/cancellation-policies/${policyId}`,
      {
        name: "Frozen test (stricter)",
        rules: [{ minHoursBeforeStart: 168, refundBps: 2_500 }],
      },
    );
    expect(edited.status).toBe(200);

    const stored = await prisma.bookingItem.findFirstOrThrow({
      where: { tripId: first.tripId },
      select: { cancellationPolicySnapshot: true },
    });
    expect(stored.cancellationPolicySnapshot).toMatchObject({
      name: "Frozen test",
      rules: MODERATE.rules,
    });

    const second = await bookOneNight(roomId, 2);
    expect(second.snapshot).toMatchObject({
      name: "Frozen test (stricter)",
      rules: [{ minHoursBeforeStart: 168, refundBps: 2_500 }],
    });
  });

  it("a booking of a listing without its own policy freezes the provider default (source: provider)", async () => {
    const def = await createPolicy(partnerB, { ...MODERATE, name: "B default" });
    await call(partnerB, "put", "/api/v1/partner/cancellation-policies/default", { policyId: def });
    const roomId = await bookableRoom(partnerB);
    const { snapshot } = await bookOneNight(roomId, 3);
    expect(snapshot).toMatchObject({ policyId: def, source: "provider" });
    await call(partnerB, "put", "/api/v1/partner/cancellation-policies/default", {
      policyId: null,
    });
  });
});

describe("gap 23: rules, ownership and the active flag (API and database)", () => {
  it("bad rules are refused with nothing written", async () => {
    const before = await prisma.cancellationPolicy.count({
      where: { providerId: partnerA.providerId },
    });
    const cases = [
      { name: "x", rules: [] }, // no tiers and not non-refundable
      { name: "x", nonRefundable: true, rules: [{ minHoursBeforeStart: 24, refundBps: 10_000 }] },
      {
        name: "x",
        rules: [
          { minHoursBeforeStart: 24, refundBps: 5_000 },
          { minHoursBeforeStart: 72, refundBps: 10_000 }, // hours must decrease
        ],
      },
      {
        name: "x",
        rules: [
          { minHoursBeforeStart: 72, refundBps: 5_000 },
          { minHoursBeforeStart: 24, refundBps: 10_000 }, // refund must not increase
        ],
      },
      { name: "x", rules: [{ minHoursBeforeStart: 24, refundBps: 0 }] },
      { name: "x", rules: [{ minHoursBeforeStart: 24.5, refundBps: 100 }] },
      { name: "  ", rules: [{ minHoursBeforeStart: 24, refundBps: 100 }] },
    ];
    for (const body of cases) {
      const res = await call(partnerA, "post", "/api/v1/partner/cancellation-policies", body);
      expect(codeOf(res)).toEqual([400, "VALIDATION_ERROR"]);
    }
    expect(
      await prisma.cancellationPolicy.count({ where: { providerId: partnerA.providerId } }),
    ).toBe(before);
  });

  it("another provider's policy is not found (404) and cannot be attached or made the default (422)", async () => {
    const aPolicy = await createPolicy(partnerA, { ...MODERATE, name: "A only" });
    expect(
      codeOf(await call(partnerB, "get", `/api/v1/partner/cancellation-policies/${aPolicy}`)),
    ).toEqual([404, "CANCELLATION_POLICY_NOT_FOUND"]);
    expect(
      codeOf(
        await call(partnerB, "patch", `/api/v1/partner/cancellation-policies/${aPolicy}`, {
          name: "Taken over",
        }),
      ),
    ).toEqual([404, "CANCELLATION_POLICY_NOT_FOUND"]);
    expect(
      codeOf(
        await call(partnerB, "put", "/api/v1/partner/cancellation-policies/default", {
          policyId: aPolicy,
        }),
      ),
    ).toEqual([422, "UNKNOWN_CANCELLATION_POLICY"]);
    const listing = await call(partnerB, "post", "/api/v1/partner/listings", {
      listingTypeCode: "hotel_room",
      title: "Borrowing a policy",
      basePriceMinor: "100000",
      details: { maxAdults: 2 },
      defaultCancellationPolicyId: aPolicy,
    });
    expect(codeOf(listing)).toEqual([422, "UNKNOWN_CANCELLATION_POLICY"]);
    expect(
      (await prisma.cancellationPolicy.findUniqueOrThrow({ where: { id: aPolicy } })).name,
    ).toBe("A only");
  });

  it("an attached policy cannot be switched off (409, where it is used); a switched-off one cannot be attached (422)", async () => {
    const policyId = await createPolicy(partnerA, { ...MODERATE, name: "In use" });
    const roomId = await bookableRoom(partnerA, { defaultCancellationPolicyId: policyId });
    const off = await call(partnerA, "patch", `/api/v1/partner/cancellation-policies/${policyId}`, {
      isActive: false,
    });
    expect(codeOf(off)).toEqual([409, "CANCELLATION_POLICY_IN_USE"]);
    expect((off.body as ErrorResponseBody).error.details).toEqual({
      listings: 1,
      providerDefault: false,
    });

    // Detach, then switch off: allowed. Attaching it again is refused while it is off.
    expect(
      (
        await call(partnerA, "patch", `/api/v1/partner/listings/${roomId}`, {
          defaultCancellationPolicyId: null,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call(partnerA, "patch", `/api/v1/partner/cancellation-policies/${policyId}`, {
          isActive: false,
        })
      ).status,
    ).toBe(200);
    expect(
      codeOf(
        await call(partnerA, "patch", `/api/v1/partner/listings/${roomId}`, {
          defaultCancellationPolicyId: policyId,
        }),
      ),
    ).toEqual([422, "CANCELLATION_POLICY_INACTIVE"]);
    expect(
      codeOf(
        await call(partnerA, "put", "/api/v1/partner/cancellation-policies/default", { policyId }),
      ),
    ).toEqual([422, "CANCELLATION_POLICY_INACTIVE"]);
    expect(await publicPolicy(roomId)).toBeNull();
  });

  it("the database enforces the same rules on every write path", async () => {
    const dbCode = async (write: Promise<unknown>) => {
      try {
        await write;
        return "written";
      } catch (err) {
        return mapDatabaseError(err)?.code ?? "unmapped";
      }
    };
    expect(
      await dbCode(
        prisma.cancellationPolicy.create({
          data: {
            providerId: partnerA.providerId,
            name: "Raw",
            description: "",
            rules: [{ minHoursBeforeStart: 24, refundBps: 20_000 }],
          },
        }),
      ),
    ).toBe("INVALID_CANCELLATION_RULES");

    const aPolicy = await createPolicy(partnerA, { ...MODERATE, name: "DB guard" });
    // Another provider's policy cannot be attached, even directly.
    expect(
      await dbCode(
        prisma.provider.update({
          where: { id: partnerB.providerId },
          data: { defaultCancellationPolicyId: aPolicy },
        }),
      ),
    ).toBe("CANCELLATION_POLICY_NOT_USABLE");
    // An attached policy cannot be switched off, even directly.
    await prisma.provider.update({
      where: { id: partnerA.providerId },
      data: { defaultCancellationPolicyId: aPolicy },
    });
    expect(
      await dbCode(
        prisma.cancellationPolicy.update({ where: { id: aPolicy }, data: { isActive: false } }),
      ),
    ).toBe("CANCELLATION_POLICY_IN_USE");
    // ... nor move to another provider.
    expect(
      await dbCode(
        prisma.cancellationPolicy.update({
          where: { id: aPolicy },
          data: { providerId: partnerB.providerId },
        }),
      ),
    ).toBe("CONSTRAINT_VIOLATED");
    await prisma.provider.update({
      where: { id: partnerA.providerId },
      data: { defaultCancellationPolicyId: null },
    });
  });
});

describe("gap 23: admins read, everything is audited", () => {
  it("an admin sees a provider's policies read-only; others are refused", async () => {
    const admin = await signUp("policyadmin");
    await prisma.user.update({ where: { id: admin.userId }, data: { role: "ADMIN" } });
    const res = await call(
      admin,
      "get",
      `/api/v1/admin/providers/${partnerA.providerId}/cancellation-policies`,
    );
    expect(res.status).toBe(200);
    const { policies } = dataOf<{ policies: { name: string; usage: object }[] }>(res);
    expect(policies.length).toBeGreaterThan(3);
    expect(policies.every((p) => typeof p.usage === "object")).toBe(true);
    expect(
      (
        await call(
          partnerA,
          "get",
          `/api/v1/admin/providers/${partnerA.providerId}/cancellation-policies`,
        )
      ).status,
    ).toBe(403);
    expect(
      codeOf(
        await call(admin, "get", `/api/v1/admin/providers/${randomUUID()}/cancellation-policies`),
      ),
    ).toEqual([404, "PROVIDER_NOT_FOUND"]);
  });

  it("create, update and default changes each wrote one audit row", async () => {
    const rows = await prisma.auditLog.findMany({
      where: {
        OR: [
          { entityType: "cancellation_policy" },
          {
            entityType: "provider",
            entityId: partnerA.providerId,
            action: "provider.cancellation_policy.default",
          },
        ],
        actorUserId: partnerA.userId,
      },
      select: { action: true },
    });
    const actions = new Set(rows.map((r) => r.action));
    expect(actions).toEqual(
      new Set([
        "cancellation_policy.create",
        "cancellation_policy.update",
        "provider.cancellation_policy.default",
      ]),
    );
  });
});
