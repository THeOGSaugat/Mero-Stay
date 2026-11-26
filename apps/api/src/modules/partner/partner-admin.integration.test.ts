import { randomUUID } from "node:crypto";
import { pino } from "pino";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../../app.js";
import { addDays } from "../../domain/dates.js";
import { inspectDatabaseError } from "../../lib/database-errors.js";
import type { ErrorResponseBody } from "../../lib/errors.js";
import { createPrismaClient } from "../../lib/prisma.js";
import { testAuthConfig } from "../../testing/auth-config.js";
import { seededFileFields } from "../../testing/documents.js";
import { samplePdf, testStorage, uploadDocument } from "../../testing/document-upload.js";
import { createWorld, type World } from "../../testing/fixtures.js";
import { countMoneyFields, moneyBoundaryViolations } from "../../testing/json-safety.js";
import { resolveTestDatabase } from "../../testing/test-database.js";

/**
 * Phase 6 (ADR 0008): partner onboarding/profile/documents, listings and inventory, bookings,
 * invoices, payouts and settlement; admin verification, finance views and the audit log.
 * Setup that is not under test (approving a listing, an extra provider) is seeded with Prisma.
 */

// Many sequential API calls per test; on the Neon test branch each is several round trips.
vi.setConfig({ testTimeout: 300_000 });

const prisma = createPrismaClient(resolveTestDatabase().pooledUrl);
const app = createApp({
  logger: pino({ level: "silent" }),
  checkDatabase: () => Promise.resolve(),
  prisma,
  auth: testAuthConfig(),
  payments: { gateway: "simulated" },
  storage: testStorage().storage,
});
let world: World;

interface Client {
  agent: ReturnType<typeof request.agent>;
  csrfToken: string;
  userId: string;
  email: string;
  cookieToken: string;
}

const responses: unknown[] = [];

async function signUp(label: string, extra: Record<string, string> = {}): Promise<Client> {
  const agent = request.agent(app);
  const email = `${label}-${randomUUID().slice(0, 8)}@test.local`;
  const res = await agent.post("/api/v1/auth/register").send({
    email,
    password: "a long test passphrase",
    fullName: `${label} Person`,
    ...extra,
  });
  expect(res.status).toBe(201);
  const body = res.body as { data: { user: { id: string }; csrfToken: string } };
  const cookie = ([] as string[]).concat(res.headers["set-cookie"] ?? [])[0] ?? "";
  return {
    agent,
    csrfToken: body.data.csrfToken,
    userId: body.data.user.id,
    email,
    cookieToken: cookie.split(";")[0]?.split("=")[1] ?? "",
  };
}

async function call(
  as: Client,
  method: "get" | "post" | "patch",
  url: string,
  body?: object,
  headers: Record<string, string> = {},
): Promise<request.Response> {
  let req = as.agent[method](url).set("X-CSRF-Token", as.csrfToken);
  for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
  const res = body ? await req.send(body) : await req;
  responses.push(res.body);
  return res;
}

const dataOf = <T>(res: request.Response) => (res.body as { data: T }).data;
const codeOf = (res: request.Response) => [res.status, (res.body as ErrorResponseBody).error?.code];
const key = () => `test-${randomUUID()}`;

async function auditRows(entityType: string, entityId: string) {
  return prisma.auditLog.findMany({
    where: { entityType, entityId },
    orderBy: { createdAt: "asc" },
  });
}

let partnerA: Client; // onboarded through the API
let partnerB: Client; // a second, unrelated partner
let customer: Client;
let admin: Client;
let providerA: string;
let providerB: string;
const ACCOUNT_NUMBER = "0123456789012";

beforeAll(async () => {
  world = await createWorld(prisma);
  [partnerA, partnerB, customer, admin] = await Promise.all([
    signUp("partner-a"),
    signUp("partner-b"),
    signUp("customer", { phone: `+97798${String(Math.floor(Math.random() * 9e7) + 1e7)}` }),
    signUp("admin"),
  ]);
  await prisma.user.update({ where: { id: admin.userId }, data: { role: "ADMIN" } });
});

afterAll(async () => {
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------------------------
describe("onboarding, profile and verification documents", () => {
  it("a customer onboards a provider and becomes a partner; a retry with the same key creates nothing", async () => {
    const body = {
      providerTypeCode: "hotel",
      legalName: "Test Lakeside Homestay Pvt. Ltd.",
      displayName: "Lakeside Homestay",
      contactPhone: "+9779800000001",
      panNumber: "123456789",
    };
    const idem = key();
    const first = await call(partnerA, "post", "/api/v1/partner/onboarding", body, {
      "Idempotency-Key": idem,
    });
    expect(first.status).toBe(201);
    providerA = dataOf<{ id: string; status: string }>(first).id;
    expect(dataOf<{ status: string }>(first).status).toBe("DRAFT");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: partnerA.userId } })).role).toBe(
      "PARTNER",
    );

    const retry = await call(partnerA, "post", "/api/v1/partner/onboarding", body, {
      "Idempotency-Key": idem,
    });
    expect([
      retry.status,
      retry.headers["idempotent-replayed"],
      dataOf<{ id: string }>(retry).id,
    ]).toEqual([201, "true", providerA]);
    expect(await prisma.provider.count({ where: { ownerUserId: partnerA.userId } })).toBe(1);
    expect((await auditRows("provider", providerA)).map((r) => r.action)).toEqual([
      "provider.create",
    ]);

    const reused = await call(
      partnerA,
      "post",
      "/api/v1/partner/onboarding",
      { ...body, displayName: "Another" },
      { "Idempotency-Key": idem },
    );
    expect(codeOf(reused)).toEqual([422, "IDEMPOTENCY_KEY_REUSED"]);

    const b = await call(partnerB, "post", "/api/v1/partner/onboarding", {
      providerTypeCode: "tour_operator",
      legalName: "B Treks",
      displayName: "B Treks",
    });
    providerB = dataOf<{ id: string }>(b).id;
  });

  it("bank details: stored, but only ever returned masked; a change is unverified and audited once", async () => {
    const account = {
      bankName: "Nabil Bank",
      accountName: "Lakeside Homestay",
      accountNumber: ACCOUNT_NUMBER,
    };
    const res = await call(partnerA, "patch", "/api/v1/partner/profile", {
      payoutAccount: account,
    });
    expect(res.status).toBe(200);
    expect(dataOf<{ payoutAccount: unknown }>(res).payoutAccount).toMatchObject({
      bankName: "Nabil Bank",
      accountNumberMasked: "••••9012",
      verified: false,
    });
    expect(JSON.stringify(res.body)).not.toContain(ACCOUNT_NUMBER);
    const again = await call(partnerA, "patch", "/api/v1/partner/profile", {
      payoutAccount: account,
    });
    expect(JSON.stringify(again.body)).not.toContain(ACCOUNT_NUMBER);
    expect(await prisma.providerPayoutAccount.count({ where: { providerId: providerA } })).toBe(1);
    const audit = (await auditRows("provider", providerA)).filter(
      (r) => r.action === "provider.payout_account.change",
    );
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0])).toContain("••••9012");
    expect(JSON.stringify(audit[0])).not.toContain(ACCOUNT_NUMBER);
  });

  it("documents: request, upload and confirm (server-chosen private key); submit for verification once", async () => {
    // Phase 10 (ADR 0016): the file is really uploaded; the client never chooses a storage key.
    const pdf = samplePdf("owner-id");
    const doc = {
      documentType: "OWNER_ID",
      fileName: "owner-id.pdf",
      mimeType: "application/pdf",
      sizeBytes: pdf.length,
      documentNumber: "12-01-75-01234",
    };
    const idem = key();
    const created = await call(partnerA, "post", "/api/v1/partner/verification-documents", doc, {
      "Idempotency-Key": idem,
    });
    expect([created.status, dataOf<{ status: string }>(created).status]).toEqual([
      201,
      "AWAITING_UPLOAD",
    ]);
    const retry = await call(partnerA, "post", "/api/v1/partner/verification-documents", doc, {
      "Idempotency-Key": idem,
    });
    expect(retry.headers["idempotent-replayed"]).toBe("true");
    expect(await prisma.providerDocument.count({ where: { providerId: providerA } })).toBe(1);
    const clientKey = await call(partnerA, "post", "/api/v1/partner/verification-documents", {
      ...doc,
      storageKey: "https://public.example.com/id.pdf",
    });
    expect(codeOf(clientKey)).toEqual([400, "VALIDATION_ERROR"]);
    const id = dataOf<{ id: string }>(created).id;
    const put = await partnerA.agent
      .put(`/api/v1/partner/verification-documents/${id}/file`)
      .set("X-CSRF-Token", partnerA.csrfToken)
      .set("Content-Type", "application/pdf")
      .send(pdf);
    expect([put.status, dataOf<{ status: string }>(put).status]).toEqual([200, "UPLOADED"]);
    const confirmed = await call(
      partnerA,
      "post",
      `/api/v1/partner/verification-documents/${id}/confirm`,
      {},
    );
    expect(dataOf<{ document: { status: string } }>(confirmed).document.status).toBe("PENDING");
    // Gap 18: a hotel needs identity AND a registration (business or homestay); owner ID alone is
    // incomplete, so the submission is refused and the provider stays DRAFT.
    const incomplete = await call(partnerA, "post", "/api/v1/partner/verification/submit", {});
    expect(codeOf(incomplete)).toEqual([409, "REQUIRED_DOCUMENTS_MISSING"]);
    expect((incomplete.body as ErrorResponseBody).error.details).toEqual({
      missing: [
        {
          requirement: "registration",
          acceptedDocumentTypes: ["BUSINESS_REGISTRATION", "LOCAL_GOVERNMENT_REGISTRATION"],
        },
      ],
    });
    expect((await prisma.provider.findUniqueOrThrow({ where: { id: providerA } })).status).toBe(
      "DRAFT",
    );
    const registration = await uploadDocument(partnerA.agent, partnerA.csrfToken, {
      documentType: "LOCAL_GOVERNMENT_REGISTRATION",
    });
    expect(registration.requested.status).toBe(201);
    const list = await call(partnerA, "get", "/api/v1/partner/verification-documents");
    expect(dataOf<unknown[]>(list)).toHaveLength(2);

    const submit = await call(partnerA, "post", "/api/v1/partner/verification/submit", {});
    expect(dataOf<{ changed: boolean; provider: { status: string } }>(submit)).toMatchObject({
      changed: true,
      provider: { status: "PENDING_VERIFICATION" },
    });
    const resubmit = await call(partnerA, "post", "/api/v1/partner/verification/submit", {});
    expect(dataOf<{ changed: boolean }>(resubmit).changed).toBe(false);
    const locked = await call(partnerA, "patch", "/api/v1/partner/profile", {
      legalName: "Changed",
    });
    expect(codeOf(locked)).toEqual([409, "PROVIDER_IDENTITY_LOCKED"]);
    expect((await auditRows("provider", providerA)).map((r) => r.action)).toEqual([
      "provider.create",
      "provider.payout_account.change",
      "provider.verification.submit",
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
describe("provider types offered at onboarding (gap 19, data-driven)", () => {
  type Offered = { code: string; requiredDocuments: { requirement: string }[] }[];

  it("a type that is not offered is absent and cannot be onboarded; toggling the flag exposes it", async () => {
    const offered = dataOf<Offered>(await request(app).get("/api/v1/provider-types"));
    const inactive = await prisma.providerType.findMany({ where: { isActive: false } });
    expect(inactive.length).toBeGreaterThanOrEqual(1);
    const hidden = inactive[0]!.code; // from data (the migration hides flights' provider type)
    expect(offered.map((t) => t.code)).not.toContain(hidden);
    expect(offered.length).toBeGreaterThanOrEqual(5);
    for (const type of offered) {
      expect(type.requiredDocuments.map((r) => r.requirement)).toContain("identity");
    }

    const newcomer = await signUp("newcomer");
    const body = { providerTypeCode: hidden, legalName: "Hidden Type Ltd", displayName: "Hidden" };
    expect(codeOf(await call(newcomer, "post", "/api/v1/partner/onboarding", body))).toEqual([
      422,
      "PROVIDER_TYPE_NOT_OFFERED",
    ]);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: newcomer.userId } })).role).toBe(
      "CUSTOMER",
    );

    await prisma.providerType.update({ where: { code: hidden }, data: { isActive: true } });
    try {
      const now = dataOf<Offered>(await request(app).get("/api/v1/provider-types"));
      expect(now.map((t) => t.code)).toContain(hidden);
      expect((await call(newcomer, "post", "/api/v1/partner/onboarding", body)).status).toBe(201);
    } finally {
      await prisma.providerType.update({ where: { code: hidden }, data: { isActive: false } });
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe("admin verification decisions (audited exactly once)", () => {
  it("customers and partners are refused before any data is read", async () => {
    for (const who of [customer, partnerA]) {
      expect(codeOf(await call(who, "get", "/api/v1/admin/providers"))).toEqual([403, "FORBIDDEN"]);
      expect(
        codeOf(
          await call(who, "post", `/api/v1/admin/providers/${providerA}/verification/approve`, {}),
        ),
      ).toEqual([403, "FORBIDDEN"]);
    }
    expect((await prisma.provider.findUniqueOrThrow({ where: { id: providerA } })).status).toBe(
      "PENDING_VERIFICATION",
    );
  });

  it("admin lists pending providers (bank masked) and approves once; a repeat is 409", async () => {
    const list = await call(
      admin,
      "get",
      "/api/v1/admin/providers?status=PENDING_VERIFICATION&pageSize=100",
    );
    const rows =
      dataOf<{ id: string; payoutAccount: { accountNumberMasked: string } | null }[]>(list);
    expect(rows.find((r) => r.id === providerA)?.payoutAccount?.accountNumberMasked).toBe(
      "••••9012",
    );
    expect((list.body as { page: { total: number } }).page.total).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(list.body)).not.toContain(ACCOUNT_NUMBER);

    const results = await Promise.all([
      call(admin, "post", `/api/v1/admin/providers/${providerA}/verification/approve`, {}),
      call(admin, "post", `/api/v1/admin/providers/${providerA}/verification/approve`, {}),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const provider = await prisma.provider.findUniqueOrThrow({
      where: { id: providerA },
      include: { documents: true, payoutAccounts: true },
    });
    expect(provider.status).toBe("VERIFIED");
    expect(provider.documents.map((d) => [d.status, d.reviewedById])).toEqual([
      ["APPROVED", admin.userId],
      ["APPROVED", admin.userId],
    ]);
    expect(provider.payoutAccounts[0]?.verifiedAt).not.toBeNull();
    const approvals = (await auditRows("provider", providerA)).filter(
      (r) => r.action === "provider.verification.approve",
    );
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ actorUserId: admin.userId, actorRole: "ADMIN" });
  });

  it("reject needs a reason, sets REJECTED and the documents' reason", async () => {
    await prisma.provider.update({
      where: { id: providerB },
      data: { status: "PENDING_VERIFICATION" },
    });
    await prisma.providerDocument.create({
      data: {
        providerId: providerB,
        documentType: "OWNER_ID",
        storageKey: "k/b",
        mimeType: "application/pdf",
        sizeBytes: 10,
        status: "PENDING",
        ...seededFileFields("reject-owner-id"),
      },
    });
    // Gap 18: a tour operator also needs a business registration and a PAN certificate, so the
    // admin cannot approve this provider; nothing changes and no audit row is written.
    const blocked = await call(
      admin,
      "post",
      `/api/v1/admin/providers/${providerB}/verification/approve`,
      {},
    );
    expect(codeOf(blocked)).toEqual([409, "REQUIRED_DOCUMENTS_MISSING"]);
    expect(
      (
        (blocked.body as ErrorResponseBody).error.details as {
          missing: { requirement: string }[];
        }
      ).missing.map((m) => m.requirement),
    ).toEqual(["registration", "tax"]);
    expect((await prisma.provider.findUniqueOrThrow({ where: { id: providerB } })).status).toBe(
      "PENDING_VERIFICATION",
    );
    expect(
      (await auditRows("provider", providerB)).filter(
        (r) => r.action === "provider.verification.approve",
      ),
    ).toEqual([]);

    const noReason = await call(
      admin,
      "post",
      `/api/v1/admin/providers/${providerB}/verification/reject`,
      {},
    );
    expect(codeOf(noReason)).toEqual([400, "VALIDATION_ERROR"]);
    const rejected = await call(
      admin,
      "post",
      `/api/v1/admin/providers/${providerB}/verification/reject`,
      {
        reason: "ID document is unreadable",
      },
    );
    expect(dataOf<{ status: string; rejectionReason: string }>(rejected)).toMatchObject({
      status: "REJECTED",
      rejectionReason: "ID document is unreadable",
    });
    expect(
      (await auditRows("provider", providerB)).filter(
        (r) => r.action === "provider.verification.reject",
      ),
    ).toHaveLength(1);
    // Verified now so partner B can be used for the scoping tests below.
    await prisma.provider.update({ where: { id: providerB }, data: { status: "VERIFIED" } });
  });
});

// ---------------------------------------------------------------------------------------------
let hotelId: string;
let roomId: string;

describe("partner listings and inventory", () => {
  it("creates a hotel and a room (type-specific details); providerId/commission cannot be sent", async () => {
    const hotel = await call(partnerA, "post", "/api/v1/partner/listings", {
      listingTypeCode: "hotel",
      title: "Lakeside Homestay",
      locationId: world.locations.town.id,
      basePriceMinor: "0",
      details: { accommodationKind: "HOMESTAY", checkInTime: "13:00", checkOutTime: "11:00" },
    });
    expect(hotel.status).toBe(201);
    hotelId = dataOf<{ id: string }>(hotel).id;

    const idem = key();
    const roomBody = {
      listingTypeCode: "hotel_room",
      title: "Lake View Double",
      parentId: hotelId,
      locationId: world.locations.village.id,
      basePriceMinor: "350000",
      serviceChargeRateBps: 1000,
      taxRateBps: 1300,
      details: { maxAdults: 2, bedType: "double" },
    };
    const room = await call(partnerA, "post", "/api/v1/partner/listings", roomBody, {
      "Idempotency-Key": idem,
    });
    expect(room.status).toBe(201);
    roomId = dataOf<{ id: string }>(room).id;
    expect(dataOf<Record<string, unknown>>(room)).toMatchObject({
      status: "DRAFT",
      basePriceMinor: "350000",
      currency: "NPR",
      currencyExponent: 2,
      details: { maxAdults: 2, maxChildren: 0, bedCount: 1, bedType: "double" },
    });
    const retry = await call(partnerA, "post", "/api/v1/partner/listings", roomBody, {
      "Idempotency-Key": idem,
    });
    expect([retry.headers["idempotent-replayed"], dataOf<{ id: string }>(retry).id]).toEqual([
      "true",
      roomId,
    ]);

    for (const bad of [
      { ...roomBody, providerId: providerB },
      { ...roomBody, commissionRateBps: 0 },
      { ...roomBody, basePriceMinor: 350000 },
    ]) {
      expect(codeOf(await call(partnerA, "post", "/api/v1/partner/listings", bad))).toEqual([
        400,
        "VALIDATION_ERROR",
      ]);
    }
    expect(
      codeOf(
        await call(partnerA, "post", "/api/v1/partner/listings", {
          ...roomBody,
          listingTypeCode: "flight_ticket",
        }),
      ),
    ).toEqual([422, "LISTING_TYPE_NOT_OFFERED"]);
    const { details: _details, ...withoutDetails } = roomBody;
    expect(
      codeOf(await call(partnerA, "post", "/api/v1/partner/listings", withoutDetails)),
    ).toEqual([422, "DETAILS_REQUIRED"]);
    // Another provider's listing as the parent is unknown. (Partner B is a tour operator, so it
    // uses a type it may list: since Phase 8 a hotel room would be refused by the type rule first.)
    expect(
      codeOf(
        await call(partnerB, "post", "/api/v1/partner/listings", {
          listingTypeCode: "activity",
          title: "Lake kayaking",
          basePriceMinor: "300000",
          parentId: hotelId,
        }),
      ),
    ).toEqual([422, "UNKNOWN_PARENT_LISTING"]);
  });

  it("a type without a detail table needs no endpoint change: attributes only (activity)", async () => {
    const res = await call(partnerB, "post", "/api/v1/partner/listings", {
      listingTypeCode: "activity",
      title: "Sunrise Paragliding",
      basePriceMinor: "800000",
      attributes: { durationMinutes: 30, minWeightKg: 35 },
    });
    expect([res.status, dataOf<{ details: unknown }>(res).details]).toEqual([201, null]);
  });

  it("status moves: submit for review yes, self-approval never; other partners get 404", async () => {
    const submit = await call(partnerA, "patch", `/api/v1/partner/listings/${roomId}`, {
      status: "PENDING_REVIEW",
    });
    expect(dataOf<{ status: string }>(submit).status).toBe("PENDING_REVIEW");
    expect(
      codeOf(
        await call(partnerA, "patch", `/api/v1/partner/listings/${roomId}`, { status: "APPROVED" }),
      ),
    ).toEqual([400, "VALIDATION_ERROR"]);
    expect(codeOf(await call(partnerB, "get", `/api/v1/partner/listings/${roomId}`))).toEqual([
      404,
      "LISTING_NOT_FOUND",
    ]);
    expect(
      codeOf(
        await call(partnerB, "patch", `/api/v1/partner/listings/${roomId}`, { title: "Hijacked" }),
      ),
    ).toEqual([404, "LISTING_NOT_FOUND"]);
    const own = await call(partnerA, "get", "/api/v1/partner/listings?pageSize=50");
    expect(
      dataOf<{ id: string }[]>(own)
        .map((l) => l.id)
        .sort(),
    ).toEqual([hotelId, roomId].sort());
    const others = await call(partnerB, "get", "/api/v1/partner/listings");
    expect(dataOf<{ id: string }[]>(others).some((l) => l.id === roomId)).toBe(false);
    // Listing approval is an admin action of a later phase: seeded here so bookings can happen.
    await prisma.listing.updateMany({
      where: { id: { in: [hotelId, roomId] } },
      data: { status: "APPROVED" },
    });
  });

  it("slots: create a range (retry-safe), refuse conflicts and containers, 404 for others", async () => {
    const d0 = world.day(0);
    const body = { startDate: d0, endDate: world.day(3), capacityTotal: 2 };
    const created = await call(partnerA, "post", `/api/v1/partner/listings/${roomId}/slots`, body);
    expect([created.status, dataOf<{ created: number }>(created).created]).toEqual([201, 3]);
    const retry = await call(partnerA, "post", `/api/v1/partner/listings/${roomId}/slots`, body);
    expect([retry.status, dataOf<{ created: number; unchanged: number }>(retry)]).toMatchObject([
      200,
      { created: 0, unchanged: 3 },
    ]);
    expect(
      codeOf(
        await call(partnerA, "post", `/api/v1/partner/listings/${roomId}/slots`, {
          ...body,
          capacityTotal: 5,
        }),
      ),
    ).toEqual([409, "SLOT_EXISTS"]);
    expect(
      codeOf(await call(partnerA, "post", `/api/v1/partner/listings/${hotelId}/slots`, body)),
    ).toEqual([422, "LISTING_NOT_BOOKABLE"]);
    expect(
      codeOf(
        await call(
          partnerB,
          "get",
          `/api/v1/partner/listings/${roomId}/slots?startDate=${d0}&endDate=${world.day(3)}`,
        ),
      ),
    ).toEqual([404, "LISTING_NOT_FOUND"]);
    // A second month, for the payout periods below.
    const later = addDays(world.day(0), 40);
    const next = await call(partnerA, "post", `/api/v1/partner/listings/${roomId}/slots`, {
      startDate: later,
      endDate: addDays(later, 1),
      capacityTotal: 2,
      priceOverrideMinor: "400000",
    });
    expect(
      dataOf<{ slots: { priceOverrideMinor: string | null; effectivePriceMinor: string }[] }>(next)
        .slots[0],
    ).toMatchObject({
      priceOverrideMinor: "400000",
      effectivePriceMinor: "400000",
    });
  });
});

// ---------------------------------------------------------------------------------------------
async function bookRoom(opts: {
  start: string;
  end: string;
  method: "online" | "pay_at_property";
  quantity?: number;
}) {
  const trip = dataOf<{ id: string }>(
    await call(customer, "post", "/api/v1/trips", {
      currency: "NPR",
      contact: { name: "Sita Sharma", email: "sita.sharma@example.com", phone: "+9779812345678" },
    }),
  );
  const added = await call(customer, "post", `/api/v1/trips/${trip.id}/items`, {
    listingId: roomId,
    startDate: opts.start,
    endDate: opts.end,
    quantity: opts.quantity ?? 1,
    paymentMethod: opts.method,
  });
  const itemId = (added.body as { data?: { items: { id: string }[] } }).data?.items[0]?.id ?? "";
  return { tripId: trip.id, added, itemId };
}

let papItem: string;
let onlineTrip: string;

describe("overbooking, partner bookings and settlement", () => {
  it("capacity cannot go below what is booked; booking past capacity is a clean 409", async () => {
    const both = await bookRoom({
      start: world.day(0),
      end: world.day(1),
      method: "online",
      quantity: 2,
    });
    expect(both.added.status).toBe(201);
    const lower = await call(partnerA, "patch", `/api/v1/partner/listings/${roomId}/slots`, {
      startDate: world.day(0),
      endDate: world.day(1),
      capacityTotal: 1,
    });
    expect(codeOf(lower)).toEqual([409, "CAPACITY_BELOW_BOOKED"]);
    const extra = await bookRoom({ start: world.day(0), end: world.day(1), method: "online" });
    expect(codeOf(extra.added)).toEqual([409, "INSUFFICIENT_AVAILABILITY"]);
  });

  it("a pay-at-property stay: the partner sees it (name only), other partners get 404", async () => {
    const stay = await bookRoom({
      start: world.day(1),
      end: world.day(3),
      method: "pay_at_property",
    });
    papItem = stay.itemId;
    expect((await call(customer, "post", `/api/v1/trips/${stay.tripId}/confirm`)).status).toBe(200);
    // A draft trip's item is not shown to the partner.
    const draft = await bookRoom({
      start: world.day(2),
      end: world.day(3),
      method: "pay_at_property",
    });

    const list = await call(partnerA, "get", "/api/v1/partner/bookings?pageSize=100");
    const items = dataOf<{ id: string; customer: Record<string, string | null> }[]>(list);
    const mine = items.find((i) => i.id === papItem);
    expect(mine?.customer).toEqual({
      name: "Sita Sharma",
      emailMasked: "s•••@e•••.com",
      phoneMasked: "+977••••••5678",
    });
    expect(items.some((i) => i.id === draft.itemId)).toBe(false);
    expect(JSON.stringify(list.body)).not.toMatch(/sita\.sharma@example\.com|9812345678/);

    const detail = await call(partnerA, "get", `/api/v1/partner/bookings/${papItem}`);
    expect(dataOf<Record<string, unknown>>(detail)).toMatchObject({
      paymentMethod: "pay_at_property",
      paymentStatus: "PAY_AT_PROPERTY",
      commissionStatus: "INVOICED",
      money: {
        subtotalMinor: "700000",
        commissionMinor: "105000",
        totalMinor: "870100",
        providerPayoutMinor: "765100",
      },
    });
    expect(codeOf(await call(partnerB, "get", `/api/v1/partner/bookings/${papItem}`))).toEqual([
      404,
      "BOOKING_NOT_FOUND",
    ]);
    expect(
      dataOf<{ id: string }[]>(await call(partnerB, "get", "/api/v1/partner/bookings")).some(
        (i) => i.id === papItem,
      ),
    ).toBe(false);
  });

  it("settle-at-property: key required; retries (also concurrent) apply once and audit once", async () => {
    const url = `/api/v1/partner/bookings/${papItem}/settle-at-property`;
    expect(codeOf(await call(partnerA, "post", url, {}))).toEqual([
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
    ]);
    expect(codeOf(await call(partnerB, "post", url, {}, { "Idempotency-Key": key() }))).toEqual([
      404,
      "BOOKING_NOT_FOUND",
    ]);

    type Settled = { settledAt: string | null; settledBy: { role: string; name: string } | null };
    const before = dataOf<Settled>(
      await call(partnerA, "get", `/api/v1/partner/bookings/${papItem}`),
    );
    expect([before.settledAt, before.settledBy]).toEqual([null, null]);

    const idem = key();
    const results = await Promise.all(
      [1, 2, 3].map(() => call(partnerA, "post", url, {}, { "Idempotency-Key": idem })),
    );
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(results.filter((r) => r.headers["idempotent-replayed"] === "true")).toHaveLength(2);
    for (const r of results) {
      expect(dataOf<{ booking: { paymentStatus: string } }>(r).booking.paymentStatus).toBe(
        "PAID_AT_PROPERTY",
      );
    }
    const other = await call(partnerA, "post", url, {}, { "Idempotency-Key": key() });
    expect(other.status).toBe(200); // already settled: unchanged
    // Who and when are shown to the partner (Phase 7 Track B): their own account's name.
    const settled = dataOf<{ booking: Settled }>(other).booking;
    expect(settled.settledBy).toEqual({ role: "PARTNER", name: "partner-a Person" });
    expect(settled.settledAt).toBe(dataOf<{ booking: Settled }>(results[0]!).booking.settledAt);

    const item = await prisma.bookingItem.findUniqueOrThrow({ where: { id: papItem } });
    expect([item.paymentStatus, item.paymentSettledById, item.commissionStatus]).toEqual([
      "PAID_AT_PROPERTY",
      partnerA.userId,
      "INVOICED",
    ]);
    expect((await auditRows("booking_item", papItem)).map((r) => r.action)).toEqual([
      "booking_item.settle_at_property",
    ]);
  });

  it("an online item cannot be settled at the property", async () => {
    // The partner raises capacity (PATCH) so the next booking fits.
    const raised = await call(partnerA, "patch", `/api/v1/partner/listings/${roomId}/slots`, {
      startDate: world.day(1),
      endDate: world.day(3),
      capacityTotal: 3,
    });
    expect(dataOf<{ updated: number; missingDates: string[] }>(raised)).toMatchObject({
      updated: 2,
      missingDates: [],
    });
    const trip = await bookRoom({ start: world.day(2), end: world.day(3), method: "online" });
    expect(trip.added.status).toBe(201);
    onlineTrip = trip.tripId;
    await call(customer, "post", `/api/v1/trips/${trip.tripId}/confirm`);
    expect(
      codeOf(
        await call(
          partnerA,
          "post",
          `/api/v1/partner/bookings/${trip.itemId}/settle-at-property`,
          {},
          { "Idempotency-Key": key() },
        ),
      ),
    ).toEqual([422, "ITEM_NOT_PAY_AT_PROPERTY"]);
  });
});

// ---------------------------------------------------------------------------------------------
describe("invoices and payout summaries", () => {
  it("partners see only their own invoices; admins filter across providers", async () => {
    const mine = dataOf<{ amountMinor: string; provider: { id: string } }[]>(
      await call(partnerA, "get", "/api/v1/partner/invoices"),
    );
    expect(mine.length).toBeGreaterThanOrEqual(1);
    expect(mine.every((i) => i.provider.id === providerA)).toBe(true);
    expect(mine.map((i) => i.amountMinor)).toContain("105000");
    expect(dataOf<unknown[]>(await call(partnerB, "get", "/api/v1/partner/invoices"))).toEqual([]);
    const adminView = await call(
      admin,
      "get",
      `/api/v1/admin/invoices?providerId=${providerA}&status=ISSUED`,
    );
    expect(
      dataOf<{ provider: { id: string } }[]>(adminView).every((i) => i.provider.id === providerA),
    ).toBe(true);
    expect(
      codeOf(await call(partnerA, "get", `/api/v1/partner/invoices?providerId=${providerB}`)),
    ).toEqual([400, "VALIDATION_ERROR"]);
  });

  it("payout summary: online-paid items, total − commission per item, grouped per month", async () => {
    // Pay the online stay (night of day 2), and book + pay one night in the next month (day 40).
    const intent = dataOf<{ payment: { id: string } }>(
      await call(customer, "post", `/api/v1/trips/${onlineTrip}/payments/intent`, {}),
    );
    await call(
      customer,
      "post",
      `/api/v1/trips/${onlineTrip}/payments/${intent.payment.id}/confirm`,
      {},
    );
    const later = addDays(world.day(0), 40);
    const next = await bookRoom({ start: later, end: addDays(later, 1), method: "online" });
    await call(customer, "post", `/api/v1/trips/${next.tripId}/confirm`);
    const nextIntent = dataOf<{ payment: { id: string } }>(
      await call(customer, "post", `/api/v1/trips/${next.tripId}/payments/intent`, {}),
    );
    await call(
      customer,
      "post",
      `/api/v1/trips/${next.tripId}/payments/${nextIntent.payment.id}/confirm`,
      {},
    );

    const res = await call(partnerA, "get", "/api/v1/partner/payouts");
    const rows = dataOf<Record<string, unknown>[]>(res);
    const expected = await prisma.$queryRaw<
      { period: string; payout: bigint; total: bigint; commission: bigint; subtotal: bigint }[]
    >`
      SELECT to_char(start_date, 'YYYY-MM') AS period, SUM(provider_payout_minor)::bigint AS payout,
             SUM(total_minor)::bigint AS total, SUM(commission_minor)::bigint AS commission,
             SUM(subtotal_minor)::bigint AS subtotal
      FROM booking_items WHERE provider_id = ${providerA}::uuid AND payment_status = 'PAID'
      GROUP BY 1 ORDER BY 1`;
    expect(
      rows.map((r) => [
        r.period,
        r.providerPayoutMinor,
        r.totalMinor,
        r.commissionMinor,
        r.subtotalMinor,
      ]),
    ).toEqual(
      expected.map((e) => [
        e.period,
        e.payout.toString(),
        e.total.toString(),
        e.commission.toString(),
        e.subtotal.toString(),
      ]),
    );
    expect(rows).toHaveLength(2); // two service months
    for (const row of rows) {
      // Commission is 15% of the subtotal; the payout is total − commission (SC + VAT go to the provider).
      expect(BigInt(row.commissionMinor as string)).toBe(
        (BigInt(row.subtotalMinor as string) * 15n) / 100n,
      );
      expect(BigInt(row.providerPayoutMinor as string)).toBe(
        BigInt(row.totalMinor as string) - BigInt(row.commissionMinor as string),
      );
      expect(row).toMatchObject({
        payoutStatus: "PENDING",
        executed: false,
        provider: { id: providerA },
      });
    }
    expect(rows[0]).toMatchObject({
      subtotalMinor: "350000",
      commissionMinor: "52500",
      totalMinor: "435050",
      providerPayoutMinor: "382550",
    });
    expect(dataOf<unknown[]>(await call(partnerB, "get", "/api/v1/partner/payouts"))).toEqual([]);
    const all = await call(admin, "get", `/api/v1/admin/payouts?providerId=${providerA}`);
    expect(dataOf<unknown[]>(all)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------------------
describe("audit log", () => {
  it("admin reads it newest first, filters and paginates; others are refused", async () => {
    const res = await call(
      admin,
      "get",
      `/api/v1/admin/audit-log?entityType=provider&entityId=${providerA}`,
    );
    const rows = dataOf<{ action: string; actor: { userId: string; role: string } }[]>(res);
    expect(rows.map((r) => r.action)).toEqual([
      "provider.verification.approve",
      "provider.verification.submit",
      "provider.payout_account.change",
      "provider.create",
    ]);
    // Phase 8 (gap 25): the actor's name is shown next to the id.
    expect(rows[0]?.actor).toEqual({ userId: admin.userId, role: "ADMIN", name: "admin Person" });
    const page = await call(
      admin,
      "get",
      `/api/v1/admin/audit-log?entityType=provider&entityId=${providerA}&pageSize=1&page=2`,
    );
    expect([
      dataOf<{ action: string }[]>(page).map((r) => r.action),
      (page.body as { page: unknown }).page,
    ]).toEqual([
      ["provider.verification.submit"],
      { page: 2, pageSize: 1, total: 4, totalPages: 4 },
    ]);
    const byActor = await call(
      admin,
      "get",
      `/api/v1/admin/audit-log?actorUserId=${partnerA.userId}&action=booking_item.settle_at_property`,
    );
    expect(dataOf<unknown[]>(byActor)).toHaveLength(1);
    for (const who of [customer, partnerA]) {
      expect(codeOf(await call(who, "get", "/api/v1/admin/audit-log"))).toEqual([403, "FORBIDDEN"]);
    }
    expect(codeOf(await request(app).get("/api/v1/admin/audit-log"))).toEqual([
      401,
      "UNAUTHENTICATED",
    ]);
  });

  it("no secrets in any audit row; the database refuses secret keys and any change to a row", async () => {
    const rows = await prisma.auditLog.findMany();
    const text = JSON.stringify(rows);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: partnerA.userId } });
    for (const secret of [
      ACCOUNT_NUMBER,
      user.passwordHash ?? "-",
      partnerA.cookieToken,
      partnerA.csrfToken,
      "12-01-75-01234",
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toMatch(/"(password|passwordHash|token|tokenHash|accountNumber)"/i);

    const refused = async (write: () => Promise<unknown>) => {
      try {
        await write();
      } catch (err) {
        return inspectDatabaseError(err)?.constraint;
      }
      return "not refused";
    };
    expect(
      await refused(() =>
        prisma.auditLog.create({
          data: {
            actorUserId: admin.userId,
            actorRole: "ADMIN",
            action: "test.leak",
            entityType: "user",
            entityId: "x",
            after: { passwordHash: "$argon2id$x" },
          },
        }),
      ),
    ).toBe("audit_log_no_secrets_chk");
    const any = rows[0]!;
    expect(
      await refused(
        () => prisma.$executeRaw`UPDATE audit_log SET action = 'x.y' WHERE id = ${any.id}::uuid`,
      ),
    ).toBe("audit_log_append_only_chk");
    expect(
      await refused(() => prisma.$executeRaw`DELETE FROM audit_log WHERE id = ${any.id}::uuid`),
    ).toBe("audit_log_append_only_chk");
  });

  it("the Phase 5 admin settle is audited now too (one row per call)", async () => {
    const stay = await bookRoom({
      start: addDays(world.day(0), 40),
      end: addDays(world.day(0), 41),
      method: "pay_at_property",
    });
    await call(customer, "post", `/api/v1/trips/${stay.tripId}/confirm`);
    const url = `/api/v1/admin/trips/${stay.tripId}/payments/at-property/settle`;
    await call(admin, "post", url, { itemIds: [stay.itemId] });
    await call(admin, "post", url, { itemIds: [stay.itemId] }); // unchanged → no second row
    expect((await auditRows("trip", stay.tripId)).map((r) => [r.action, r.actorUserId])).toEqual([
      ["trip.settle_at_property", admin.userId],
    ]);
    // The partner sees that MeroStay recorded it, without the staff member's name.
    const seen = dataOf<{ settledBy: unknown }>(
      await call(partnerA, "get", `/api/v1/partner/bookings/${stay.itemId}`),
    );
    expect(seen.settledBy).toEqual({ role: "ADMIN", name: "MeroStay" });
  });
});

// ---------------------------------------------------------------------------------------------
describe("access and the money boundary across every response", () => {
  it("customers and admins cannot use partner endpoints; anonymous requests are 401", async () => {
    for (const who of [customer, admin]) {
      expect(codeOf(await call(who, "get", "/api/v1/partner/profile"))).toEqual([403, "FORBIDDEN"]);
      expect(codeOf(await call(who, "get", "/api/v1/partner/bookings"))).toEqual([
        403,
        "FORBIDDEN",
      ]);
    }
    expect(
      codeOf(
        await call(admin, "post", "/api/v1/partner/onboarding", {
          providerTypeCode: "hotel",
          legalName: "X",
          displayName: "X",
        }),
      ),
    ).toEqual([403, "FORBIDDEN"]);
    expect(codeOf(await request(app).get("/api/v1/partner/profile"))).toEqual([
      401,
      "UNAUTHENTICATED",
    ]);
    const noCsrf = await partnerA.agent.patch("/api/v1/partner/profile").send({ displayName: "X" });
    expect(codeOf(noCsrf)).toEqual([403, "CSRF_TOKEN_INVALID"]);
  });

  it("every money field was a digit string (or null) with its currency; no secrets in any response", () => {
    expect(responses.reduce<number>((n, body) => n + countMoneyFields(body), 0)).toBeGreaterThan(
      100,
    );
    expect(responses.flatMap((body) => moneyBoundaryViolations(body))).toEqual([]);
    const all = JSON.stringify(responses);
    expect(all).not.toContain(ACCOUNT_NUMBER);
    expect(all).not.toMatch(/argon2id|passwordHash|tokenHash/);
  });
});
