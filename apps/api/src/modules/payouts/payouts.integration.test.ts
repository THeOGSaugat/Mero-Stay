import { randomUUID } from "node:crypto";
import { pino } from "pino";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../../app.js";
import { inspectDatabaseError } from "../../lib/database-errors.js";
import type { ErrorResponseBody } from "../../lib/errors.js";
import { createPrismaClient } from "../../lib/prisma.js";
import { testAuthConfig } from "../../testing/auth-config.js";
import { createWorld, type World } from "../../testing/fixtures.js";
import { moneyBoundaryViolations } from "../../testing/json-safety.js";
import { resolveTestDatabase } from "../../testing/test-database.js";
import { hashPassword } from "../auth/password.js";
import { simulatedPayments } from "../payments/payments.config.js";

/**
 * Phase 12 (ADR 0018, gap 16): payout batches by manual bank transfer, recorded. Eligibility
 * (service over in Nepal time), net = total − commission per provider and month, scheduling needs
 * a verified bank account, mark paid / failed, idempotency, audit, partner scoping, DB guards.
 */

vi.setConfig({ testTimeout: 120_000 });

const prisma = createPrismaClient(resolveTestDatabase().pooledUrl);
// One app, one clock: bookings and payments happen "today"; payouts after the services, which the
// fixtures place 30+ days ahead. Sessions last 7 days, so everyone logs in again after the jump.
let clockOffsetMs = 0;
const app = createApp({
  logger: pino({ level: "silent" }),
  checkDatabase: () => Promise.resolve(),
  prisma,
  auth: testAuthConfig(),
  payments: simulatedPayments(),
  now: () => new Date(Date.now() + clockOffsetMs),
});
const AFTER_SERVICES = 36 * 86_400_000;

interface Client {
  agent: ReturnType<typeof request.agent>;
  csrf: string;
  userId: string;
  email: string;
}
let world: World;
let otherWorld: World;
let customer: Client;
let admin: Client;
let partner: Client;
let otherPartner: Client;
const responses: unknown[] = [];
const PASSWORD = "a long test passphrase";

async function signUp(label: string): Promise<Client> {
  const agent = request.agent(app);
  const email = `${label}-${randomUUID().slice(0, 8)}@test.local`;
  const res = await agent
    .post("/api/v1/auth/register")
    .send({ email, password: PASSWORD, fullName: label });
  expect(res.status).toBe(201);
  const body = res.body as { data: { user: { id: string }; csrfToken: string } };
  return { agent, csrf: body.data.csrfToken, userId: body.data.user.id, email };
}

/** A fresh session (after the clock jump the old one has expired). */
async function relogin(client: Client): Promise<void> {
  client.agent = request.agent(app);
  const res = await client.agent
    .post("/api/v1/auth/login")
    .send({ email: client.email, password: PASSWORD });
  expect(res.status).toBe(200);
  client.csrf = (res.body as { data: { csrfToken: string } }).data.csrfToken;
}

/** Logs in a world's provider owner as a PARTNER (fixture owners have no password). */
async function partnerOf(w: World): Promise<Client> {
  const email = `owner-${w.suffix}@test.local`;
  await prisma.user.update({
    where: { id: w.users.owner.id },
    data: { email, role: "PARTNER", passwordHash: await hashPassword(PASSWORD) },
  });
  const agent = request.agent(app);
  const res = await agent.post("/api/v1/auth/login").send({ email, password: PASSWORD });
  expect(res.status).toBe(200);
  const body = res.body as { data: { user: { id: string }; csrfToken: string } };
  return { agent, csrf: body.data.csrfToken, userId: body.data.user.id, email };
}

async function call(
  as: Client,
  method: "get" | "post",
  url: string,
  body?: object,
  headers: Record<string, string> = {},
) {
  let req = as.agent[method](url).set("X-CSRF-Token", as.csrf);
  for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
  const res = body ? await req.send(body) : await req;
  responses.push(res.body);
  return res;
}

const dataOf = <T>(res: request.Response) => (res.body as { data: T }).data;
const codeOf = (res: request.Response) => [res.status, (res.body as ErrorResponseBody).error.code];
const month = (date: string) => date.slice(0, 7);

interface PayoutBody {
  id: string;
  provider: { id: string; name: string };
  period: string;
  status: string;
  currency: string;
  currencyExponent: number;
  grossMinor: string;
  commissionMinor: string;
  netMinor: string;
  itemCount: number;
  payoutAccountLabel: string | null;
  bankReferenceMasked: string | null;
  items?: { id: string; totalMinor: string; commissionMinor: string; netMinor: string }[];
}

async function refusedBy(write: () => Promise<unknown>) {
  try {
    await write();
  } catch (err) {
    const info = inspectDatabaseError(err);
    if (info) return info;
    throw err;
  }
  throw new Error("expected the database to refuse this write");
}

let tripId: string;
let busItemId: string;
let guideItemId: string;
let roomItemId: string;
let period: string;

const generate = (as: Client = admin) =>
  call(as, "post", "/api/v1/admin/payout-batches/generate", { period });
const batchOf = (providerId: string, status?: "PENDING" | "SCHEDULED" | "PAID" | "FAILED") =>
  prisma.payout.findFirst({
    where: { providerId, ...(status ? { status } : {}) },
    orderBy: { createdAt: "desc" },
  });

beforeAll(async () => {
  world = await createWorld(prisma);
  otherWorld = await createWorld(prisma);
  customer = await signUp("payout-customer");
  admin = await signUp("payout-admin");
  await prisma.user.update({ where: { id: admin.userId }, data: { role: "ADMIN" } });
  partner = await partnerOf(world);
  otherPartner = await partnerOf(otherWorld);
  for (const [i, providerId] of [
    world.providers.busProvider.id,
    world.providers.guideProvider.id,
  ].entries()) {
    await prisma.providerPayoutAccount.create({
      data: {
        providerId,
        bankName: "Nabil Bank",
        accountName: "Test Provider",
        accountNumber: `01010000000${i}4321`,
        isDefault: true,
      },
    });
  }

  // One trip: 2 bus seats (day 1, online), the guide days 1–3 (online), a room (pay at property).
  const created = await call(customer, "post", "/api/v1/trips", { currency: "NPR" });
  tripId = dataOf<{ id: string }>(created).id;
  for (const item of [
    {
      listingId: world.listings.bus.id,
      startDate: world.day(1),
      quantity: 2,
      paymentMethod: "online",
    },
    {
      listingId: world.listings.guide.id,
      startDate: world.day(1),
      endDate: world.day(4),
      quantity: 1,
      paymentMethod: "online",
    },
    {
      listingId: world.listings.room.id,
      startDate: world.day(1),
      endDate: world.day(3),
      quantity: 1,
      paymentMethod: "pay_at_property",
    },
  ]) {
    expect((await call(customer, "post", `/api/v1/trips/${tripId}/items`, item)).status).toBe(201);
  }
  expect((await call(customer, "post", `/api/v1/trips/${tripId}/confirm`)).status).toBe(200);
  const intent = await call(customer, "post", `/api/v1/trips/${tripId}/payments/intent`, {
    gateway: "simulated",
  });
  const paymentId = dataOf<{ payment: { id: string } }>(intent).payment.id;
  expect(
    (await call(customer, "post", `/api/v1/trips/${tripId}/payments/${paymentId}/confirm`, {}))
      .status,
  ).toBe(200);
  const items = await prisma.bookingItem.findMany({
    where: { tripId },
    orderBy: { createdAt: "asc" },
  });
  [busItemId, guideItemId, roomItemId] = items.map((i) => i.id) as [string, string, string];
  expect(items.map((i) => i.paymentStatus)).toEqual(["PAID", "PAID", "PAY_AT_PROPERTY"]);
  period = month(world.day(1));
});

afterAll(async () => {
  clockOffsetMs = 0;
  await prisma.$disconnect();
});

describe("generating payout batches", () => {
  it("paid items are NOT eligible before their service is over (Nepal time)", async () => {
    expect((await generate()).status).toBe(200);
    expect(await batchOf(world.providers.busProvider.id)).toBeNull();
    expect(await batchOf(world.providers.guideProvider.id)).toBeNull();
  });

  it("after the service: one PENDING batch per provider, net = total − commission; pay at property excluded", async () => {
    clockOffsetMs = AFTER_SERVICES;
    for (const client of [admin, customer, partner, otherPartner]) await relogin(client);
    const res = await generate();
    expect(res.status).toBe(200);
    for (const [providerId, itemId] of [
      [world.providers.busProvider.id, busItemId],
      [world.providers.guideProvider.id, guideItemId],
    ] as const) {
      const batch = await batchOf(providerId);
      const item = await prisma.bookingItem.findUniqueOrThrow({ where: { id: itemId } });
      expect(batch).toMatchObject({
        status: "PENDING",
        itemCount: 1,
        grossMinor: item.totalMinor,
        commissionMinor: item.commissionMinor,
        amountMinor: item.totalMinor - item.commissionMinor,
      });
      expect(item.payoutId).toBe(batch!.id);
      const body = dataOf<{ payout: PayoutBody }[]>(res).find(
        (c) => c.payout.id === batch!.id,
      )!.payout;
      expect(body).toMatchObject({
        period,
        currency: "NPR",
        currencyExponent: 2,
        grossMinor: item.totalMinor.toString(),
        commissionMinor: item.commissionMinor.toString(),
        netMinor: (item.totalMinor - item.commissionMinor).toString(),
      });
    }
    // Bus: 2 × Rs 1,800 = Rs 3,600, 15% commission = Rs 540 → Rs 3,060 net.
    expect(await batchOf(world.providers.busProvider.id)).toMatchObject({
      grossMinor: 360000n,
      commissionMinor: 54000n,
      amountMinor: 306000n,
    });
    expect(await batchOf(world.providers.hotelProvider.id)).toBeNull();
    expect(
      (await prisma.bookingItem.findUniqueOrThrow({ where: { id: roomItemId } })).payoutId,
    ).toBeNull();
  });

  it("generating again (also concurrently) changes nothing", async () => {
    const before = await prisma.payout.findMany({
      where: {
        providerId: { in: [world.providers.busProvider.id, world.providers.guideProvider.id] },
      },
    });
    const results = await Promise.all([generate(), generate(), generate()]);
    for (const res of results) expect(res.status).toBe(200);
    const after = await prisma.payout.findMany({
      where: {
        providerId: { in: [world.providers.busProvider.id, world.providers.guideProvider.id] },
      },
    });
    expect(after.map((p) => [p.id, p.itemCount, p.amountMinor])).toEqual(
      before.map((p) => [p.id, p.itemCount, p.amountMinor]),
    );
    const bus = await batchOf(world.providers.busProvider.id);
    expect(
      await prisma.auditLog.count({
        where: { entityId: bus!.id, action: { startsWith: "payout.generate" } },
      }),
    ).toBe(1);
  });

  it("only admins: customers and partners get 403", async () => {
    expect(codeOf(await generate(customer))).toEqual([403, "FORBIDDEN"]);
    expect(codeOf(await generate(partner))).toEqual([403, "FORBIDDEN"]);
    expect(
      (await call(admin, "post", "/api/v1/admin/payout-batches/generate", { period: "2026-13" }))
        .status,
    ).toBe(400);
  });
});

describe("schedule → paid", () => {
  let busBatchId: string;

  it("scheduling needs a VERIFIED default bank account", async () => {
    busBatchId = (await batchOf(world.providers.busProvider.id))!.id;
    expect(
      codeOf(await call(admin, "post", `/api/v1/admin/payout-batches/${busBatchId}/schedule`)),
    ).toEqual([409, "PAYOUT_ACCOUNT_NOT_VERIFIED"]);
    const verify = await call(
      admin,
      "post",
      `/api/v1/admin/providers/${world.providers.busProvider.id}/payout-account/verify`,
    );
    expect(dataOf<{ changed: boolean; payoutAccountLabel: string }>(verify)).toMatchObject({
      changed: true,
      payoutAccountLabel: "Nabil Bank · ••••4321",
    });
    expect(JSON.stringify(verify.body)).not.toContain("0101000000004321");
    const again = await call(
      admin,
      "post",
      `/api/v1/admin/providers/${world.providers.busProvider.id}/payout-account/verify`,
    );
    expect(dataOf<{ changed: boolean }>(again).changed).toBe(false);
  });

  it("schedules once: amounts fixed, masked account snapshot; a repeat is a no-op", async () => {
    const res = await call(admin, "post", `/api/v1/admin/payout-batches/${busBatchId}/schedule`);
    expect(dataOf<{ changed: boolean; payout: PayoutBody }>(res)).toMatchObject({
      changed: true,
      payout: {
        status: "SCHEDULED",
        payoutAccountLabel: "Nabil Bank · ••••4321",
        netMinor: "306000",
      },
    });
    const again = await call(admin, "post", `/api/v1/admin/payout-batches/${busBatchId}/schedule`);
    expect(dataOf<{ changed: boolean }>(again).changed).toBe(false);
    // The database refuses changing a scheduled batch's money or its items.
    expect(
      await refusedBy(() =>
        prisma.payout.update({
          where: { id: busBatchId },
          data: { amountMinor: 1n, grossMinor: 55001n },
        }),
      ),
    ).toEqual({ sqlState: "23514", constraint: "payouts_scheduled_immutable_chk" });
    expect(
      await refusedBy(() =>
        prisma.bookingItem.update({ where: { id: busItemId }, data: { payoutId: null } }),
      ),
    ).toEqual({ sqlState: "23514", constraint: "booking_items_payout_link_chk" });
  });

  it("mark paid once: items paid out, commission collected; same reference = no-op, another = 409", async () => {
    const markPaid = (ref: string) =>
      call(admin, "post", `/api/v1/admin/payout-batches/${busBatchId}/mark-paid`, {
        bankReference: ref,
      });
    const res = await markPaid("NABIL-TRF-0007788");
    expect(dataOf<{ changed: boolean; payout: PayoutBody }>(res)).toMatchObject({
      changed: true,
      payout: { status: "PAID", bankReferenceMasked: "••••7788" },
    });
    expect(JSON.stringify(res.body)).not.toContain("NABIL-TRF-0007788");
    const item = await prisma.bookingItem.findUniqueOrThrow({ where: { id: busItemId } });
    expect([item.payoutStatus, item.commissionStatus]).toEqual(["PAID", "PAID"]);
    const results = await Promise.all([
      markPaid("NABIL-TRF-0007788"),
      markPaid("NABIL-TRF-0007788"),
    ]);
    for (const r of results) expect(dataOf<{ changed: boolean }>(r).changed).toBe(false);
    expect(codeOf(await markPaid("OTHER-REF-1"))).toEqual([409, "PAYOUT_ALREADY_PAID"]);

    const audits = await prisma.auditLog.findMany({
      where: { entityId: busBatchId },
      orderBy: { createdAt: "asc" },
    });
    expect(audits.map((a) => a.action)).toEqual([
      "payout.generate.create",
      "payout.schedule",
      "payout.mark_paid",
    ]);
    expect(JSON.stringify(audits)).not.toContain("NABIL-TRF-0007788");
    expect(JSON.stringify(audits)).toContain("••••7788");
  });

  it("the database keeps a paid batch and its items fixed", async () => {
    expect(await refusedBy(() => prisma.payout.delete({ where: { id: busBatchId } }))).toEqual({
      sqlState: "23514",
      constraint: "payouts_kept_chk",
    });
    expect(
      await refusedBy(() =>
        prisma.payout.update({ where: { id: busBatchId }, data: { reference: "CHANGED-REF" } }),
      ),
    ).toEqual({ sqlState: "23514", constraint: "payouts_scheduled_immutable_chk" });
    expect(
      await refusedBy(() =>
        prisma.payout.update({ where: { id: busBatchId }, data: { status: "PENDING" } }),
      ),
    ).toMatchObject({ sqlState: "23514" });
    expect(
      await refusedBy(() =>
        prisma.bookingItem.update({ where: { id: busItemId }, data: { payoutStatus: "PENDING" } }),
      ),
    ).toEqual({ sqlState: "23514", constraint: "booking_items_payout_paid_chk" });
    // Paid out without a paid batch: refused.
    expect(
      await refusedBy(() =>
        prisma.bookingItem.update({ where: { id: guideItemId }, data: { payoutStatus: "PAID" } }),
      ),
    ).toEqual({ sqlState: "23514", constraint: "booking_items_payout_paid_chk" });
  });
});

describe("a failed transfer", () => {
  it("releases the items, which a new batch then picks up", async () => {
    await call(
      admin,
      "post",
      `/api/v1/admin/providers/${world.providers.guideProvider.id}/payout-account/verify`,
    );
    const first = (await batchOf(world.providers.guideProvider.id, "PENDING"))!;
    await call(admin, "post", `/api/v1/admin/payout-batches/${first.id}/schedule`);
    expect(
      codeOf(await call(admin, "post", `/api/v1/admin/payout-batches/${first.id}/mark-failed`, {})),
    ).toEqual([400, "VALIDATION_ERROR"]);
    const failed = await call(
      admin,
      "post",
      `/api/v1/admin/payout-batches/${first.id}/mark-failed`,
      {
        reason: "Account closed (bank returned the transfer)",
      },
    );
    expect(dataOf<{ changed: boolean; payout: PayoutBody }>(failed)).toMatchObject({
      changed: true,
      payout: { status: "FAILED" },
    });
    expect(
      (await prisma.bookingItem.findUniqueOrThrow({ where: { id: guideItemId } })).payoutId,
    ).toBeNull();
    const again = await call(
      admin,
      "post",
      `/api/v1/admin/payout-batches/${first.id}/mark-failed`,
      { reason: "x" },
    );
    expect(dataOf<{ changed: boolean }>(again).changed).toBe(false);
    expect(
      codeOf(
        await call(admin, "post", `/api/v1/admin/payout-batches/${first.id}/mark-paid`, {
          bankReference: "REF-123",
        }),
      ),
    ).toEqual([409, "PAYOUT_NOT_SCHEDULED"]);

    await generate();
    const second = (await batchOf(world.providers.guideProvider.id, "PENDING"))!;
    expect(second.id).not.toBe(first.id);
    expect(
      (await prisma.bookingItem.findUniqueOrThrow({ where: { id: guideItemId } })).payoutId,
    ).toBe(second.id);
  });
});

describe("partners see only their own payouts", () => {
  const asBus = { "X-Provider-Id": "" };
  beforeAll(() => {
    asBus["X-Provider-Id"] = world.providers.busProvider.id;
  });

  it("lists and opens own batches (read-only, money as strings, reference masked)", async () => {
    const list = await call(partner, "get", "/api/v1/partner/payout-batches", undefined, asBus);
    expect(list.status).toBe(200);
    const rows = dataOf<PayoutBody[]>(list);
    expect(rows.map((r) => r.provider.id)).toEqual([world.providers.busProvider.id]);
    expect(rows[0]).toMatchObject({
      status: "PAID",
      netMinor: "306000",
      bankReferenceMasked: "••••7788",
    });
    const detail = await call(
      partner,
      "get",
      `/api/v1/partner/payout-batches/${rows[0]!.id}`,
      undefined,
      asBus,
    );
    expect(dataOf<PayoutBody>(detail).items).toEqual([
      expect.objectContaining({
        id: busItemId,
        totalMinor: "360000",
        commissionMinor: "54000",
        netMinor: "306000",
      }),
    ]);
  });

  it("another provider's batch is a 404, also for the same owner's other business", async () => {
    const guideBatch = (await batchOf(world.providers.guideProvider.id, "PENDING"))!;
    expect(
      codeOf(
        await call(
          partner,
          "get",
          `/api/v1/partner/payout-batches/${guideBatch.id}`,
          undefined,
          asBus,
        ),
      ),
    ).toEqual([404, "PAYOUT_NOT_FOUND"]);
    const other = { "X-Provider-Id": otherWorld.providers.busProvider.id };
    expect(
      codeOf(
        await call(
          otherPartner,
          "get",
          `/api/v1/partner/payout-batches/${guideBatch.id}`,
          undefined,
          other,
        ),
      ),
    ).toEqual([404, "PAYOUT_NOT_FOUND"]);
    expect(
      dataOf<unknown[]>(
        await call(otherPartner, "get", "/api/v1/partner/payout-batches", undefined, other),
      ),
    ).toEqual([]);
    expect((await call(customer, "get", "/api/v1/partner/payout-batches")).status).toBe(403);
    expect(
      (await call(partner, "post", `/api/v1/admin/payout-batches/${guideBatch.id}/schedule`))
        .status,
    ).toBe(403);
  });
});

it("money stays a digit string in every response (ADR 0005)", () => {
  expect(moneyBoundaryViolations(responses)).toEqual([]);
});
