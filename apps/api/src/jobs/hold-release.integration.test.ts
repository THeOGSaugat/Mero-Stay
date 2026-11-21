import { randomUUID } from "node:crypto";
import { pino } from "pino";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { createPrismaClient } from "../lib/prisma.js";
import { createTripsService } from "../modules/trips/trips.service.js";
import { testAuthConfig } from "../testing/auth-config.js";
import { createWorld, type World } from "../testing/fixtures.js";
import { resolveTestDatabase } from "../testing/test-database.js";
import { runHoldRelease, startHoldReleaseLoop } from "./hold-release.js";

/**
 * The scheduled hold-release job (ADR 0007) against a real database: abandoned holds are released
 * on schedule; confirmed, paid and partly paid bookings keep theirs; concurrent runs release each
 * hold exactly once.
 */

// These scenarios make dozens of sequential API calls, each several database round trips. On the
// Neon test branch (~100–300 ms per round trip) some exceed the default 30 s, so this file allows
// 300 s per test. Assertions are unchanged; locally the tests take milliseconds.
vi.setConfig({ testTimeout: 300_000 });

const prisma = createPrismaClient(resolveTestDatabase().pooledUrl);
const app = createApp({
  logger: pino({ level: "silent" }),
  checkDatabase: () => Promise.resolve(),
  prisma,
  auth: testAuthConfig(),
  payments: { gateway: "simulated" },
});
const silent = pino({ level: "silent" });
let world: World;
let agent: ReturnType<typeof request.agent>;
let csrf: string;

const post = async (url: string, body: object = {}) => {
  const res = await agent.post(url).set("X-CSRF-Token", csrf).send(body);
  expect(res.status).toBeLessThan(300);
  return (res.body as { data: Record<string, unknown> }).data;
};

type Spec = {
  listing: "room" | "bus" | "guide";
  start: number;
  end?: number;
  quantity?: number;
  paymentMethod: "online" | "pay_at_property";
};

async function trip(items: Spec[], confirm: boolean): Promise<{ id: string; itemIds: string[] }> {
  const { id } = (await post("/api/v1/trips", { currency: "NPR" })) as { id: string };
  for (const item of items) {
    await post(`/api/v1/trips/${id}/items`, {
      listingId: world.listings[item.listing].id,
      startDate: world.day(item.start),
      ...(item.end === undefined ? {} : { endDate: world.day(item.end) }),
      quantity: item.quantity ?? 1,
      paymentMethod: item.paymentMethod,
    });
  }
  if (confirm) await post(`/api/v1/trips/${id}/confirm`);
  const created = await prisma.bookingItem.findMany({
    where: { tripId: id },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  return { id, itemIds: created.map((i) => i.id) };
}

async function pay(tripId: string, capturedAmountMinor?: string): Promise<string> {
  const intent = (await post(`/api/v1/trips/${tripId}/payments/intent`)) as {
    payment: { id: string };
  };
  await post(
    `/api/v1/trips/${tripId}/payments/${intent.payment.id}/confirm`,
    capturedAmountMinor ? { capturedAmountMinor } : {},
  );
  return intent.payment.id;
}

const state = (id: string) =>
  prisma.trip.findUniqueOrThrow({
    where: { id },
    include: { items: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] }, payments: true },
  });

/** This world's inventory rows whose held units differ from its active booking items' units. */
async function holdLeaks() {
  return prisma.$queryRaw<{ listing_id: string }[]>`
    SELECT s.listing_id::text
    FROM inventory_slots s
    JOIN listings l ON l.id = s.listing_id
    LEFT JOIN booking_item_slots bis ON bis.inventory_slot_id = s.id
    LEFT JOIN booking_items bi ON bi.id = bis.booking_item_id
    WHERE l.location_id IN (${world.locations.town.id}::uuid, ${world.locations.village.id}::uuid)
    GROUP BY s.id
    HAVING s.capacity_booked <> COALESCE(SUM(bis.units) FILTER (WHERE bi.status NOT IN ('CANCELLED', 'EXPIRED')), 0)`;
}

async function waitFor(
  check: () => Promise<boolean>,
  failures: () => unknown[] = () => [],
  timeoutMs = 90_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    const failed = failures();
    if (failed.length > 0) throw new Error(`hold-release run failed: ${JSON.stringify(failed[0])}`);
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

beforeAll(async () => {
  world = await createWorld(prisma);
  agent = request.agent(app);
  const res = await agent.post("/api/v1/auth/register").send({
    email: `jobs-${randomUUID().slice(0, 8)}@test.local`,
    password: "a long test passphrase",
    fullName: "Jobs Tester",
  });
  csrf = (res.body as { data: { csrfToken: string } }).data.csrfToken;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("scheduled hold release", () => {
  it("the worker loop releases abandoned holds on schedule and keeps every booking with money or a confirmation", async () => {
    // Independent trips, built concurrently (each is many sequential calls; Neon latency adds up).
    const [abandonedDraft, abandonedStay, confirmedStay, mixed, paid, partly] = await Promise.all([
      trip([{ listing: "bus", start: 1, quantity: 3, paymentMethod: "online" }], false),
      trip([{ listing: "room", start: 0, end: 2, paymentMethod: "pay_at_property" }], false),
      trip([{ listing: "room", start: 2, end: 4, paymentMethod: "pay_at_property" }], true),
      // Hotel at the property (confirmed + invoiced) + bus online, never paid; an intent is open.
      trip(
        [
          { listing: "room", start: 0, end: 2, paymentMethod: "pay_at_property" },
          { listing: "bus", start: 1, quantity: 2, paymentMethod: "online" },
        ],
        true,
      ).then(async (t) => {
        await post(`/api/v1/trips/${t.id}/payments/intent`);
        return t;
      }),
      trip([{ listing: "bus", start: 1, paymentMethod: "online" }], true).then(async (t) => {
        await pay(t.id);
        return t;
      }),
      // Bus fully paid + guide partly paid (Rs 10 of Rs 9,000).
      trip(
        [
          { listing: "bus", start: 1, paymentMethod: "online" },
          { listing: "guide", start: 0, end: 3, paymentMethod: "online" },
        ],
        true,
      ).then(async (t) => {
        await pay(t.id, "181000");
        return t;
      }),
    ]);
    const heldBefore = (await state(partly.id)).items.map((i) => i.status);
    expect(heldBefore).toEqual(["CONFIRMED", "PENDING"]);

    // The job runs with a clock 31 minutes ahead: every hold above has passed.
    const later = () => new Date(Date.now() + 31 * 60_000);
    const sweeper = createTripsService({ prisma, now: later });
    // A failed run is logged and retried by the loop; record failures so the test reports them
    // instead of waiting for a release that never comes.
    const failures: unknown[] = [];
    const loop = startHoldReleaseLoop({
      sweep: (limit) => sweeper.expireStaleTrips(limit),
      intervalMs: 50,
      logger: { ...silent, error: (obj: unknown) => void failures.push(obj) } as typeof silent,
    });
    try {
      await waitFor(
        async () => (await state(abandonedDraft.id)).status === "EXPIRED",
        () => failures,
      );
      await waitFor(
        () => Promise.resolve(loop.runs() >= 3),
        () => failures,
      ); // keeps running on schedule
    } finally {
      await loop.stop();
    }
    expect(failures).toEqual([]);

    // Abandoned drafts: everything released.
    for (const id of [abandonedDraft.id, abandonedStay.id]) {
      const t = await state(id);
      expect([t.status, t.totalMinor, t.items.map((i) => i.status)]).toEqual([
        "EXPIRED",
        0n,
        ["EXPIRED"],
      ]);
    }
    // Confirmed pay-at-property stay: untouched.
    expect((await state(confirmedStay.id)).items.map((i) => i.status)).toEqual(["CONFIRMED"]);
    // Mixed: the hotel and its invoice stay; the unpaid bus is released; the open intent is cancelled.
    const m = await state(mixed.id);
    expect([m.status, m.items.map((i) => i.status), m.payments.map((p) => p.status)]).toEqual([
      "CONFIRMED",
      ["CONFIRMED", "EXPIRED"],
      ["CANCELLED"],
    ]);
    expect(m.totalMinor).toBe(m.items[0]!.totalMinor);
    const invoice = await prisma.providerInvoice.findFirstOrThrow({ where: { tripId: mixed.id } });
    expect(invoice.status).toBe("ISSUED");
    // Fully paid trip: untouched.
    expect((await state(paid.id)).items.map((i) => [i.status, i.paymentStatus])).toEqual([
      ["CONFIRMED", "PAID"],
    ]);
    // Partly paid: the customer's money keeps the guide booked; the trip waits for the rest.
    const p = await state(partly.id);
    expect([p.status, p.expiresAt, p.items.map((i) => [i.status, i.paymentStatus])]).toEqual([
      "PENDING",
      null,
      [
        ["CONFIRMED", "PAID"],
        ["PENDING", "PARTIALLY_PAID"],
      ],
    ]);
    // ...and the customer can still pay the remainder.
    const rest = (await post(`/api/v1/trips/${partly.id}/payments/intent`)) as {
      payment: { amountMinor: string };
    };
    expect(rest.payment.amountMinor).toBe("899000");

    // Every released unit is accounted for: holds equal active booking items exactly.
    expect(await holdLeaks()).toEqual([]);
    // Nothing stale is left, so another run is a no-op.
    expect(await runHoldRelease((limit) => sweeper.expireStaleTrips(limit))).toEqual({
      released: 0,
      batches: 1,
    });
  });

  it("four concurrent runs release each abandoned hold exactly once", async () => {
    const drafts = await Promise.all(
      Array.from({ length: 6 }, () =>
        trip([{ listing: "bus", start: 1, paymentMethod: "online" }], false),
      ),
    );
    const at = new Date(Date.now() + 31 * 60_000);
    const [{ stale }] = (await prisma.$queryRaw<{ stale: bigint }[]>`
      SELECT COUNT(*)::bigint AS stale FROM trips
      WHERE status IN ('DRAFT', 'PENDING') AND expires_at <= ${at}`) as [{ stale: bigint }];
    expect(stale).toBeGreaterThanOrEqual(6n);
    const seatsBefore = (
      await prisma.inventorySlot.findUniqueOrThrow({
        where: {
          listingId_serviceDate: {
            listingId: world.listings.bus.id,
            serviceDate: new Date(`${world.day(1)}T00:00:00Z`),
          },
        },
      })
    ).capacityBooked;

    const sweeper = createTripsService({ prisma, now: () => at });
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        runHoldRelease((limit) => sweeper.expireStaleTrips(limit), { batchSize: 2 }),
      ),
    );
    // Each stale trip was released by exactly one run: the counts add up to the stale total.
    expect(BigInt(results.reduce((sum, r) => sum + r.released, 0))).toBe(stale);

    for (const draft of drafts) expect((await state(draft.id)).status).toBe("EXPIRED");
    const seatsAfter = (
      await prisma.inventorySlot.findUniqueOrThrow({
        where: {
          listingId_serviceDate: {
            listingId: world.listings.bus.id,
            serviceDate: new Date(`${world.day(1)}T00:00:00Z`),
          },
        },
      })
    ).capacityBooked;
    expect(seatsBefore - seatsAfter).toBe(6); // six seats back, not twelve
    expect(await holdLeaks()).toEqual([]);
  });
});
