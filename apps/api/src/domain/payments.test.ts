import { describe, expect, it } from "vitest";
import {
  dueLines,
  intentFingerprint,
  onlinePaymentStatus,
  outstandingMinor,
  planAllocation,
  totalDue,
  type DueLine,
} from "./payments.js";

const item = (id: string, totalMinor: bigint, allocatedMinor = 0n, currency = "NPR") => ({
  id,
  currency,
  totalMinor,
  allocatedMinor,
});

describe("amount due", () => {
  it("is total − already allocated, per item", () => {
    expect(outstandingMinor(item("a", 957_110n))).toBe(957_110n);
    expect(outstandingMinor(item("a", 957_110n, 900_000n))).toBe(57_110n);
    expect(outstandingMinor(item("a", 957_110n, 957_110n))).toBe(0n);
  });

  it("refuses over-allocated or negative data instead of returning a negative amount", () => {
    expect(() => outstandingMinor(item("a", 100n, 101n))).toThrow(/over-allocated/);
    expect(() => outstandingMinor(item("a", -1n))).toThrow(RangeError);
  });

  it("lists only items still owing, in the given order, and sums them exactly", () => {
    const lines = dueLines("NPR", [
      item("bus", 360_000n),
      item("paid", 100n, 100n),
      item("guide", 900_000n, 1n),
    ]);
    expect(lines).toEqual([
      { itemId: "bus", dueMinor: 360_000n },
      { itemId: "guide", dueMinor: 899_999n },
    ]);
    expect(totalDue(lines)).toBe(1_259_999n);
  });

  it("rejects an item in another currency (one currency per trip)", () => {
    expect(() => dueLines("NPR", [item("usd", 5_000n, 0n, "USD")])).toThrow(/USD/);
  });

  it("stays exact far above Number.MAX_SAFE_INTEGER (bigint, never number)", () => {
    const big = 9_007_199_254_740_993n; // 2^53 + 1: not representable as a JS number
    expect(totalDue(dueLines("NPR", [item("a", big), item("b", big)]))).toBe(
      18_014_398_509_481_986n,
    );
  });
});

describe("partial allocation", () => {
  const lines: DueLine[] = [
    { itemId: "bus", dueMinor: 360_000n },
    { itemId: "guide", dueMinor: 900_000n },
  ];

  it("a full capture pays every line exactly", () => {
    expect(planAllocation(lines, 1_260_000n)).toEqual([
      { itemId: "bus", amountMinor: 360_000n },
      { itemId: "guide", amountMinor: 900_000n },
    ]);
  });

  it("a partial capture fills lines in order and never gives a line more than it is due", () => {
    expect(planAllocation(lines, 500_000n)).toEqual([
      { itemId: "bus", amountMinor: 360_000n },
      { itemId: "guide", amountMinor: 140_000n },
    ]);
    expect(planAllocation(lines, 100n)).toEqual([{ itemId: "bus", amountMinor: 100n }]);
  });

  it("allocations always sum to the captured amount (no paisa lost or invented)", () => {
    for (const captured of [1n, 359_999n, 360_000n, 360_001n, 1_259_999n, 1_260_000n]) {
      const sum = planAllocation(lines, captured).reduce((s, a) => s + a.amountMinor, 0n);
      expect(sum).toBe(captured);
    }
  });

  it("refuses to allocate more than is due (over-allocation)", () => {
    expect(() => planAllocation(lines, 1_260_001n)).toThrow(/exceeds/);
    expect(() => planAllocation(lines, -1n)).toThrow(RangeError);
  });
});

describe("item payment status after allocation", () => {
  it("is PAID only when the allocations equal the item total", () => {
    expect(onlinePaymentStatus(957_110n, 957_110n)).toBe("PAID");
    expect(onlinePaymentStatus(957_110n, 957_109n)).toBe("PARTIALLY_PAID");
    expect(onlinePaymentStatus(957_110n, 1n)).toBe("PARTIALLY_PAID");
    expect(onlinePaymentStatus(957_110n, 0n)).toBe("UNPAID");
  });

  it("never reports more than paid", () => {
    expect(() => onlinePaymentStatus(100n, 101n)).toThrow(RangeError);
  });
});

describe("intent fingerprint (idempotency key of an intent)", () => {
  const trip = "6f0c1d2e-0000-4000-8000-000000000001";
  const lines: DueLine[] = [
    { itemId: "b", dueMinor: 900_000n },
    { itemId: "a", dueMinor: 360_000n },
  ];

  it("is a stable 64-character hex string, independent of line order", () => {
    const fp = intentFingerprint(trip, "NPR", lines);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(intentFingerprint(trip, "NPR", [...lines].reverse())).toBe(fp);
  });

  it("changes when the trip, currency, an item or any amount changes", () => {
    const fp = intentFingerprint(trip, "NPR", lines);
    expect(intentFingerprint(trip.replace(/1$/, "2"), "NPR", lines)).not.toBe(fp);
    expect(intentFingerprint(trip, "USD", lines)).not.toBe(fp);
    expect(intentFingerprint(trip, "NPR", [lines[0]!])).not.toBe(fp);
    expect(
      intentFingerprint(trip, "NPR", [lines[0]!, { itemId: "a", dueMinor: 359_999n }]),
    ).not.toBe(fp);
  });
});
