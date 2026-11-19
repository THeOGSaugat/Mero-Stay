import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyRate, calculateItemCharges, type ItemCharges } from "../domain/money.js";
import { createPrismaClient } from "../lib/prisma.js";
import { resolveTestDatabase } from "../testing/test-database.js";

/**
 * The database is the last line of defence: even if application code computes a
 * wrong amount, PostgreSQL CHECK constraints refuse to store it.
 */
const prisma = createPrismaClient(resolveTestDatabase().pooledUrl);

const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);
const uid = (): string => randomUUID().slice(0, 8);

let customerId: string;
let providerId: string;
let listingId: string;
let tripId: string;

beforeAll(async () => {
  const suffix = uid();
  const owner = await prisma.user.create({
    data: {
      email: `owner-${suffix}@test.local`,
      fullName: "Constraint Test Owner",
      role: "PARTNER",
    },
  });
  const customer = await prisma.user.create({
    data: {
      phone: `+97798${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
      fullName: "Constraint Test Customer",
    },
  });
  const provider = await prisma.provider.create({
    data: {
      providerTypeCode: "hotel",
      ownerUserId: owner.id,
      legalName: "Test Hotel",
      displayName: "Test Hotel",
    },
  });
  const listing = await prisma.listing.create({
    data: {
      providerId: provider.id,
      listingTypeCode: "hotel_room",
      title: "Test room",
      slug: `test-room-${suffix}`,
      basePriceMinor: 350_000,
    },
  });
  const trip = await prisma.trip.create({
    data: { reference: `MS-T${suffix}`, customerId: customer.id },
  });
  customerId = customer.id;
  providerId = provider.id;
  listingId = listing.id;
  tripId = trip.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

function itemData(charges: ItemCharges, overrides: Record<string, unknown> = {}) {
  return {
    tripId,
    listingId,
    providerId,
    listingTypeCode: "hotel_room",
    startDate: day("2026-12-20"),
    endDate: day("2026-12-22"),
    quantity: charges.quantity,
    subtotalMinor: charges.subtotalMinor,
    serviceChargeRateBps: charges.serviceChargeRateBps,
    serviceChargeMinor: charges.serviceChargeMinor,
    taxRateBps: charges.taxRateBps,
    taxMinor: charges.taxMinor,
    totalMinor: charges.totalMinor,
    commissionRateBps: charges.commissionRateBps,
    commissionMinor: charges.commissionMinor,
    providerPayoutMinor: charges.providerPayoutMinor,
    ...overrides,
  };
}

const hotelStay = calculateItemCharges({
  lines: [
    { units: 1, unitPriceMinor: 350_000 },
    { units: 1, unitPriceMinor: 420_000 },
  ],
  serviceChargeRateBps: 1000,
  taxRateBps: 1300,
  commissionRateBps: 1500,
});

describe("booking item money constraints", () => {
  it("accepts an item whose amounts come from calculateItemCharges", async () => {
    const item = await prisma.bookingItem.create({ data: itemData(hotelStay) });
    expect(item.commissionMinor).toBe(115_500);
    expect(item.totalMinor).toBe(957_110);
  });

  it.each([
    [
      "commission off by one paisa",
      {
        commissionMinor: hotelStay.commissionMinor + 1,
        providerPayoutMinor: hotelStay.providerPayoutMinor - 1,
      },
      "booking_items_commission_chk",
    ],
    [
      "commission computed on the total instead of the subtotal",
      {
        commissionMinor: applyRate(hotelStay.totalMinor, 1500),
        providerPayoutMinor: hotelStay.totalMinor - applyRate(hotelStay.totalMinor, 1500),
      },
      "booking_items_commission_chk",
    ],
    [
      "total that does not add up",
      {
        totalMinor: hotelStay.totalMinor + 100,
        providerPayoutMinor: hotelStay.providerPayoutMinor + 100,
      },
      "booking_items_total_chk",
    ],
    [
      "wrong VAT",
      {
        taxMinor: hotelStay.taxMinor - 1,
        totalMinor: hotelStay.totalMinor - 1,
        providerPayoutMinor: hotelStay.providerPayoutMinor - 1,
      },
      "booking_items_tax_chk",
    ],
    [
      "wrong provider payout",
      { providerPayoutMinor: hotelStay.totalMinor },
      "booking_items_payout_chk",
    ],
    [
      "refund larger than the total",
      { refundedMinor: hotelStay.totalMinor + 1 },
      "booking_items_refund_chk",
    ],
    ["check-out before check-in", { endDate: day("2026-12-19") }, "booking_items_dates_chk"],
    ["lower-case currency", { currency: "npr" }, "booking_items_currency_chk"],
    ["commission rate above 100%", { commissionRateBps: 10_001 }, "booking_items_rates_chk"],
  ])("rejects %s", async (_label, overrides, constraint) => {
    await expect(
      prisma.bookingItem.create({ data: itemData(hotelStay, overrides) }),
    ).rejects.toThrow(new RegExp(constraint));
  });

  it("rejects a per-date line whose amount is not units × unit price", async () => {
    const item = await prisma.bookingItem.create({ data: itemData(hotelStay) });
    await expect(
      prisma.bookingItemSlot.create({
        data: {
          bookingItemId: item.id,
          serviceDate: day("2026-12-20"),
          units: 2,
          unitPriceMinor: 350_000,
          amountMinor: 350_000,
        },
      }),
    ).rejects.toThrow(/booking_item_slots_amount_chk/);
  });
});

describe("inventory constraints", () => {
  it("refuses to book more than capacity (no overbooking at the database level)", async () => {
    const slot = await prisma.inventorySlot.create({
      data: { listingId, serviceDate: day("2027-01-05"), capacityTotal: 2 },
    });
    await prisma.inventorySlot.update({
      where: { id: slot.id },
      data: { capacityBooked: { increment: 2 } },
    });

    await expect(
      prisma.inventorySlot.update({
        where: { id: slot.id },
        data: { capacityBooked: { increment: 1 } },
      }),
    ).rejects.toThrow(/inventory_slots_no_overbooking_chk/);

    const after = await prisma.inventorySlot.findUniqueOrThrow({ where: { id: slot.id } });
    expect(after.capacityBooked).toBe(2);
  });

  it("allows only one inventory row per listing per date", async () => {
    await prisma.inventorySlot.create({
      data: { listingId, serviceDate: day("2027-01-06"), capacityTotal: 1 },
    });
    await expect(
      prisma.inventorySlot.create({
        data: { listingId, serviceDate: day("2027-01-06"), capacityTotal: 1 },
      }),
    ).rejects.toThrow(/Unique constraint/i);
  });
});

describe("other integrity rules", () => {
  it("requires a user to have an email or a phone number", async () => {
    await expect(prisma.user.create({ data: { fullName: "Nobody" } })).rejects.toThrow(
      /users_email_or_phone_chk/,
    );
  });

  it("keeps trip totals internally consistent", async () => {
    await expect(
      prisma.trip.create({
        data: { reference: `MS-X${uid()}`, customerId, subtotalMinor: 1000, totalMinor: 999 },
      }),
    ).rejects.toThrow(/trips_total_chk/);
  });

  it("limits review ratings to 1–5", async () => {
    const item = await prisma.bookingItem.create({ data: itemData(hotelStay) });
    await expect(
      prisma.review.create({
        data: { bookingItemId: item.id, authorId: customerId, listingId, providerId, rating: 6 },
      }),
    ).rejects.toThrow(/reviews_rating_chk/);
  });

  it("refuses to delete a provider that still has listings (no cascading loss of records)", async () => {
    await expect(prisma.provider.delete({ where: { id: providerId } })).rejects.toThrow();
  });
});

describe("TypeScript and SQL rounding agree", () => {
  it("applyRate matches PostgreSQL ROUND() for 2,000 amounts × rates, including exact halves", async () => {
    const amounts: number[] = [];
    const rates: number[] = [];
    // Exact half cases: amount × rate ends in 5000 (e.g. 10 × 1500 = 15,000 → 1.5).
    for (let i = 1; i <= 500; i++) {
      amounts.push(i * 10);
      rates.push(1500);
    }
    // Pseudo-random amounts up to Rs 2 crore and all sorts of rates (deterministic seed).
    let state = 42;
    const next = () => (state = (state * 1_103_515_245 + 12_345) % 2_147_483_648);
    for (let i = 0; i < 1500; i++) {
      amounts.push(next() % 2_000_000_000);
      rates.push(next() % 10_001);
    }

    const rows = await prisma.$queryRaw<{ v: bigint }[]>`
      SELECT ROUND(t.a::numeric * t.r / 10000)::bigint AS v
      FROM unnest(${amounts}::int[], ${rates}::int[]) WITH ORDINALITY AS t(a, r, i)
      ORDER BY t.i`;

    const fromSql = rows.map((row) => Number(row.v));
    const fromTs = amounts.map((amount, i) => applyRate(amount, rates[i] ?? 0));
    expect(fromSql).toEqual(fromTs);
  });
});
