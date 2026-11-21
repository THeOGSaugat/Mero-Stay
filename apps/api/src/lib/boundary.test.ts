import { describe, expect, it } from "vitest";
import {
  addDays,
  enumerateServiceDates,
  InvalidDateRangeError,
  isIsoDate,
  todayInKathmandu,
} from "../domain/dates.js";
import { mapDatabaseError } from "./database-errors.js";
import { currencyExponent, minorToString, toJsonSafe } from "./money-json.js";

/** Shape Prisma 7's pg adapter really produces (captured from a live database in Phase 3). */
function checkViolation(constraint: string) {
  return Object.assign(new Error("Database error"), {
    name: "PrismaClientKnownRequestError",
    code: "P2039",
    meta: {
      driverAdapterError: {
        name: "DriverAdapterError",
        cause: {
          originalCode: "23514",
          originalMessage: `new row for relation "x" violates check constraint "${constraint}"`,
          detail: "Failing row contains (secret-uuid, 2027-01-01, 1, 2, ...).",
        },
      },
    },
  });
}

describe("money at the JSON boundary", () => {
  it("serializes bigint minor units as digit strings, exactly, at any size", () => {
    expect(minorToString(115_500n)).toBe("115500");
    expect(minorToString(9_223_372_036_854_775_807n)).toBe("9223372036854775807");
    expect(minorToString(0n)).toBe("0");
  });

  it("refuses to serialize a JS number as money", () => {
    expect(() => minorToString(115500 as unknown as bigint)).toThrow(TypeError);
  });

  it("documents why: JSON.stringify throws on bigint, and numbers lose precision", () => {
    expect(() => JSON.stringify({ totalMinor: 1n })).toThrow(TypeError);
    // A client parsing a numeric money field silently gets a different amount:
    const parsed = JSON.parse('{"totalMinor": 9007199254740993}') as { totalMinor: number };
    expect(String(parsed.totalMinor)).toBe("9007199254740992");
  });

  it("knows each currency's minor-unit exponent", () => {
    expect(currencyExponent("NPR")).toBe(2);
    expect(currencyExponent("USD")).toBe(2);
    expect(currencyExponent("JPY")).toBe(0);
  });

  it("toJsonSafe makes non-money data JSON-safe (Date, Decimal-like, bigint, nested)", () => {
    const decimalLike = { toFixed: () => "27.7", toString: () => "27.700000" };
    const out = toJsonSafe({
      at: new Date("2027-01-01T00:00:00Z"),
      lat: decimalLike,
      n: 5n,
      nested: [{ ok: true }],
    });
    expect(out).toEqual({
      at: "2027-01-01T00:00:00.000Z",
      lat: "27.700000",
      n: "5",
      nested: [{ ok: true }],
    });
    expect(() => JSON.stringify(out)).not.toThrow();
  });
});

describe("service dates", () => {
  it("validates real calendar dates", () => {
    expect(isIsoDate("2027-02-28")).toBe(true);
    expect(isIsoDate("2027-02-30")).toBe(false);
    expect(isIsoDate("27-02-01")).toBe(false);
  });

  it("enumerates [start, end) or a single date", () => {
    expect(enumerateServiceDates("2027-01-30", "2027-02-02")).toEqual([
      "2027-01-30",
      "2027-01-31",
      "2027-02-01",
    ]);
    expect(enumerateServiceDates("2027-01-30")).toEqual(["2027-01-30"]);
    expect(enumerateServiceDates("2027-01-30", null)).toEqual(["2027-01-30"]);
  });

  it("rejects empty, reversed and too-long ranges", () => {
    expect(() => enumerateServiceDates("2027-01-30", "2027-01-30")).toThrow(InvalidDateRangeError);
    expect(() => enumerateServiceDates("2027-01-30", "2027-01-29")).toThrow(InvalidDateRangeError);
    expect(() => enumerateServiceDates("2027-01-01", addDays("2027-01-01", 31))).toThrow(
      /at most 30/,
    );
    expect(enumerateServiceDates("2027-01-01", addDays("2027-01-01", 30))).toHaveLength(30);
  });

  it("uses Nepal's date for 'today' (UTC+05:45)", () => {
    // 18:30 UTC on 1 Jan is already 00:15 on 2 Jan in Kathmandu.
    expect(todayInKathmandu(new Date("2027-01-01T18:30:00Z"))).toBe("2027-01-02");
    expect(todayInKathmandu(new Date("2027-01-01T18:00:00Z"))).toBe("2027-01-01");
  });
});

describe("database error mapping", () => {
  it("overbooking CHECK → 409 INSUFFICIENT_AVAILABILITY", () => {
    const mapped = mapDatabaseError(checkViolation("inventory_slots_no_overbooking_chk"));
    expect(mapped).toMatchObject({ statusCode: 409, code: "INSUFFICIENT_AVAILABILITY" });
  });

  it("money CHECKs → 422 PRICING_INVARIANT_VIOLATED", () => {
    for (const constraint of [
      "booking_items_commission_chk",
      "booking_items_total_chk",
      "trips_total_chk",
      "booking_item_slots_amount_chk",
    ]) {
      expect(mapDatabaseError(checkViolation(constraint))).toMatchObject({
        statusCode: 422,
        code: "PRICING_INVARIANT_VIOLATED",
      });
    }
  });

  it("payment/allocation/invoice guards → 422 PAYMENT_INVARIANT_VIOLATED (Phase 5)", () => {
    for (const constraint of [
      "payment_allocations_within_payment_chk",
      "payment_allocations_within_item_chk",
      "payments_finished_immutable_chk",
      "provider_invoices_amount_matches_items_chk",
      "booking_items_payment_matches_allocations_chk",
      "booking_items_paid_never_expires_chk",
      "booking_items_invoice_link_chk",
      "booking_items_invoiced_has_invoice_chk",
    ]) {
      expect(mapDatabaseError(checkViolation(constraint))).toMatchObject({
        statusCode: 422,
        code: "PAYMENT_INVARIANT_VIOLATED",
      });
    }
  });

  it("finds a guard trigger's constraint from its message (the adapter drops the field)", () => {
    const raised = Object.assign(new Error("x"), {
      code: "P2010",
      meta: {
        driverAdapterError: {
          cause: {
            originalCode: "23514",
            originalMessage:
              'violates check constraint "payment_allocations_within_item_chk": allocations exceed the item total',
          },
        },
      },
    });
    expect(mapDatabaseError(raised)).toMatchObject({ code: "PAYMENT_INVARIANT_VIOLATED" });
    expect(JSON.stringify(mapDatabaseError(raised))).not.toMatch(/violates|allocations exceed/);
  });

  it("never copies the raw PostgreSQL text (failing row) into the API error", () => {
    const mapped = mapDatabaseError(checkViolation("booking_items_commission_chk"));
    expect(JSON.stringify(mapped)).not.toMatch(/Failing row|secret-uuid|violates/);
    expect(mapped?.message).not.toMatch(/Failing row|violates/);
  });

  it("unique violation → 409 CONFLICT; unknown errors → null (generic 500)", () => {
    const unique = Object.assign(new Error("x"), {
      code: "P2002",
      meta: {
        driverAdapterError: {
          cause: { originalCode: "23505", constraint: { index: "trips_reference_key" } },
        },
      },
    });
    expect(mapDatabaseError(unique)).toMatchObject({ statusCode: 409, code: "CONFLICT" });
    expect(mapDatabaseError(new Error("boom"))).toBeNull();
    expect(mapDatabaseError("not an error")).toBeNull();
  });
});
