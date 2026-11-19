import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../lib/prisma.js";
import { resolveTestDatabase } from "../testing/test-database.js";
import { seedDatabase, type SeedSummary } from "./seed.js";

const prisma = createPrismaClient(resolveTestDatabase().pooledUrl);
let summary: SeedSummary;

beforeAll(async () => {
  summary = await seedDatabase(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("sample seed", () => {
  it("inserts users, providers, listings across verticals and two trips", async () => {
    expect(summary.trips).toBeGreaterThanOrEqual(2);
    const byType = await prisma.listing.groupBy({ by: ["listingTypeCode"], _count: true });
    const types = byType.map((row) => row.listingTypeCode).sort();
    expect(types).toEqual(
      expect.arrayContaining([
        "activity",
        "bus_ticket",
        "flight_ticket",
        "guide_service",
        "hotel",
        "hotel_room",
        "tour",
      ]),
    );
  });

  it("models Inaruwa → Shree Antu as ONE trip with a bus and a homestay from different providers", async () => {
    const trip = await prisma.trip.findUniqueOrThrow({
      where: { reference: "MS-SAMPLE1" },
      include: { items: { orderBy: { listingTypeCode: "asc" } } },
    });
    expect(trip.items.map((i) => i.listingTypeCode)).toEqual(["bus_ticket", "hotel_room"]);
    expect(new Set(trip.items.map((i) => i.providerId)).size).toBe(2);
    // Mixed payment within one trip: bus prepaid online, homestay paid on arrival.
    expect(trip.items.map((i) => i.paymentStatus)).toEqual(["PAID", "PAY_AT_PROPERTY"]);
  });

  it("stores the hand-checked amounts (15% commission per item, summed on the trip)", async () => {
    const trip = await prisma.trip.findUniqueOrThrow({
      where: { reference: "MS-SAMPLE1" },
      include: { items: { orderBy: { listingTypeCode: "asc" } } },
    });
    const [bus, room] = trip.items;
    // Bus: 2 seats × Rs 1,800 = Rs 3,600; commission 15% = Rs 540.
    expect(bus).toMatchObject({
      subtotalMinor: 360_000n,
      totalMinor: 360_000n,
      commissionMinor: 54_000n,
    });
    // Homestay: Rs 3,500 + Rs 4,200 (weekend) = 7,700; +10% SC = 770; +13% VAT on 8,470 = 1,101.10.
    expect(room).toMatchObject({
      subtotalMinor: 770_000n,
      serviceChargeMinor: 77_000n,
      taxMinor: 110_110n,
      totalMinor: 957_110n,
      commissionMinor: 115_500n, // 15% of the subtotal only
    });
    expect(trip.commissionTotalMinor).toBe(54_000n + 115_500n);
    expect(trip.totalMinor).toBe(360_000n + 957_110n);
  });

  it("every sample trip's stored totals equal the sum of its items", async () => {
    // Scoped to the seed's trips: other test files create deliberately partial fixtures.
    const mismatches = await prisma.$queryRaw<{ reference: string }[]>`
      SELECT t.reference
      FROM trips t
      JOIN booking_items bi ON bi.trip_id = t.id
      WHERE t.reference LIKE 'MS-SAMPLE%'
      GROUP BY t.id
      HAVING t.subtotal_minor         <> SUM(bi.subtotal_minor)
          OR t.service_charge_minor   <> SUM(bi.service_charge_minor)
          OR t.tax_minor              <> SUM(bi.tax_minor)
          OR t.total_minor            <> SUM(bi.total_minor)
          OR t.commission_total_minor <> SUM(bi.commission_minor)`;
    expect(mismatches).toEqual([]);
  });

  it("every item's quantity and subtotal equal the sum of its per-date lines", async () => {
    const mismatches = await prisma.$queryRaw<{ id: string }[]>`
      SELECT bi.id
      FROM booking_items bi
      JOIN booking_item_slots s ON s.booking_item_id = bi.id
      JOIN trips t ON t.id = bi.trip_id
      WHERE t.reference LIKE 'MS-SAMPLE%'
      GROUP BY bi.id
      HAVING bi.quantity <> SUM(s.units) OR bi.subtotal_minor <> SUM(s.amount_minor)`;
    expect(mismatches).toEqual([]);
  });

  it("records consumed inventory", async () => {
    const bus = await prisma.listing.findUniqueOrThrow({
      where: { slug: "sample-inaruwa-shree-antu-morning-bus" },
      include: { inventorySlots: true },
    });
    expect(bus.inventorySlots[0]).toMatchObject({ capacityTotal: 35, capacityBooked: 2 });
  });

  it("has a review only on a completed booking item", async () => {
    const reviews = await prisma.review.findMany({ include: { bookingItem: true } });
    expect(reviews.length).toBeGreaterThan(0);
    for (const review of reviews) expect(review.bookingItem.status).toBe("COMPLETED");
  });

  it("refuses to run twice and changes nothing", async () => {
    const before = await prisma.trip.count();
    await expect(seedDatabase(prisma)).rejects.toThrow(/already present/);
    expect(await prisma.trip.count()).toBe(before);
  });
});
