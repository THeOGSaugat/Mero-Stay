import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyRate, calculateItemCharges, type ItemCharges } from "../domain/money.js";
import { serviceStartFields } from "../domain/refunds.js";
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
    ...serviceStartFields("2026-12-20", "14:00"),
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
    { units: 1, unitPriceMinor: 350_000n },
    { units: 1, unitPriceMinor: 420_000n },
  ],
  serviceChargeRateBps: 1000,
  taxRateBps: 1300,
  commissionRateBps: 1500,
});

describe("booking item money constraints", () => {
  it("accepts an item whose amounts come from calculateItemCharges", async () => {
    const item = await prisma.bookingItem.create({ data: itemData(hotelStay) });
    expect(item.commissionMinor).toBe(115_500n);
    expect(item.totalMinor).toBe(957_110n);
  });

  it.each([
    [
      "commission off by one paisa",
      {
        commissionMinor: hotelStay.commissionMinor + 1n,
        providerPayoutMinor: hotelStay.providerPayoutMinor - 1n,
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
        totalMinor: hotelStay.totalMinor + 100n,
        providerPayoutMinor: hotelStay.providerPayoutMinor + 100n,
      },
      "booking_items_total_chk",
    ],
    [
      "wrong VAT",
      {
        taxMinor: hotelStay.taxMinor - 1n,
        totalMinor: hotelStay.totalMinor - 1n,
        providerPayoutMinor: hotelStay.providerPayoutMinor - 1n,
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
      { refundedMinor: hotelStay.totalMinor + 1n },
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

describe("64-bit money columns", () => {
  it("every *_minor column is BIGINT (no 32-bit INTEGER money left)", async () => {
    const rows = await prisma.$queryRaw<
      { table_name: string; column_name: string; data_type: string }[]
    >`
      SELECT table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name LIKE '%\_minor'
      ORDER BY table_name, column_name`;
    // + payments.captured_minor (Phase 5); + payment_reconciliations and refund_requests amount_minor (Phase 11)
    // + payouts.gross_minor, payouts.commission_minor, provider_invoice_adjustments.amount_minor (Phase 12)
    // + booking_items.cancellation_refund_minor and kept_commission_minor, payouts.deductions_minor,
    //   provider_clawbacks.amount_minor, provider_clawback_recoveries.amount_minor (Phase 14)
    expect(rows.length).toBe(31);
    expect(rows.filter((row) => row.data_type !== "bigint")).toEqual([]);
  });

  it("stores and returns a Rs 100 crore item exactly (above the old 2.1 crore limit)", async () => {
    const charges = calculateItemCharges({
      lines: [{ units: 2, unitPriceMinor: 50_000_000_000n }],
      commissionRateBps: 1500,
    });
    const item = await prisma.bookingItem.create({ data: itemData(charges) });
    expect(item.subtotalMinor).toBe(100_000_000_000n);
    expect(item.commissionMinor).toBe(15_000_000_000n);
    expect(item.providerPayoutMinor).toBe(85_000_000_000n);
  });

  it("stays exact above 2^53 and the database CHECK agrees with TypeScript there", async () => {
    // 99,999,999,999,999,999 paisa is above 2^53 (9.007 × 10^15), where JS numbers are inexact.
    const charges = calculateItemCharges({
      lines: [{ units: 1, unitPriceMinor: 99_999_999_999_999_999n }],
      commissionRateBps: 1500,
    });
    expect(charges.commissionMinor).toBe(15_000_000_000_000_000n);
    const item = await prisma.bookingItem.create({ data: itemData(charges) });
    expect(item.subtotalMinor).toBe(99_999_999_999_999_999n);
    expect(item.commissionMinor).toBe(15_000_000_000_000_000n);
    expect(item.providerPayoutMinor).toBe(84_999_999_999_999_999n);
  });

  it("still rejects a wrong commission at that size", async () => {
    const charges = calculateItemCharges({
      lines: [{ units: 1, unitPriceMinor: 99_999_999_999_999_999n }],
      commissionRateBps: 1500,
    });
    await expect(
      prisma.bookingItem.create({
        data: itemData(charges, {
          commissionMinor: charges.commissionMinor + 1n,
          providerPayoutMinor: charges.providerPayoutMinor - 1n,
        }),
      }),
    ).rejects.toThrow(/booking_items_commission_chk/);
  });
});

describe("TypeScript and SQL rounding agree", () => {
  it("applyRate matches PostgreSQL ROUND() for 2,000 amounts × rates across the whole 64-bit range, including exact halves", async () => {
    const amounts: bigint[] = [];
    const rates: number[] = [];
    // Exact half cases: amount × rate ends in 5000 (e.g. 10 × 1500 = 15,000 → 1.5).
    for (let i = 1; i <= 500; i++) {
      amounts.push(BigInt(i) * 10n);
      rates.push(1500);
    }
    // Deterministic pseudo-random amounts of every magnitude, from a few paisa up to 2^63 − 1.
    const mask63 = (1n << 63n) - 1n;
    let state = 42n;
    const next = () =>
      (state = (state * 6_364_136_223_846_793_005n + 1_442_695_040_888_963_407n) % (1n << 64n));
    for (let i = 0; i < 1500; i++) {
      amounts.push(((next() >> 1n) & mask63) >> BigInt(i % 60));
      rates.push(Number((next() >> 20n) % 10_001n));
    }
    amounts.push(mask63, mask63);
    rates.push(1500, 10_000);

    const rows = await prisma.$queryRaw<{ v: bigint }[]>`
      SELECT ROUND(t.a::numeric * t.r / 10000)::bigint AS v
      FROM unnest(${amounts.map(String)}::text[], ${rates}::int[]) WITH ORDINALITY AS t(a, r, i)
      ORDER BY t.i`;

    const fromSql = rows.map((row) => row.v);
    const fromTs = amounts.map((amount, i) => applyRate(amount, rates[i] ?? 0));
    expect(fromSql).toEqual(fromTs);
    expect(amounts.some((amount) => amount > 2n ** 53n)).toBe(true); // really exercised the big range
  });
});
