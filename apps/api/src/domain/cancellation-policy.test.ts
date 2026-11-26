import { describe, expect, it } from "vitest";
import {
  cancellationRuleProblems,
  cancellationSnapshot,
  resolveCancellationPolicy,
  type PolicyRecord,
} from "./cancellation-policy.js";

const policy = (id: string, overrides: Partial<PolicyRecord> = {}): PolicyRecord => ({
  id,
  name: `Policy ${id}`,
  description: "",
  rules: [{ minHoursBeforeStart: 24, refundBps: 10_000 }],
  nonRefundable: false,
  isActive: true,
  ...overrides,
});

describe("cancellation rule (gap 23, ADR 0015)", () => {
  it("accepts ordered tiers and a non-refundable policy without tiers", () => {
    expect(
      cancellationRuleProblems({
        nonRefundable: false,
        tiers: [
          { minHoursBeforeStart: 72, refundBps: 10_000 },
          { minHoursBeforeStart: 24, refundBps: 5_000 },
          { minHoursBeforeStart: 0, refundBps: 1 },
        ],
      }),
    ).toEqual([]);
    expect(cancellationRuleProblems({ nonRefundable: true, tiers: [] })).toEqual([]);
  });

  it.each([
    ["no tiers, not non-refundable", { nonRefundable: false, tiers: [] }],
    [
      "non-refundable with a tier",
      { nonRefundable: true, tiers: [{ minHoursBeforeStart: 1, refundBps: 1 }] },
    ],
    [
      "hours not decreasing",
      {
        nonRefundable: false,
        tiers: [
          { minHoursBeforeStart: 24, refundBps: 5_000 },
          { minHoursBeforeStart: 24, refundBps: 1_000 },
        ],
      },
    ],
    [
      "refund increasing with less notice",
      {
        nonRefundable: false,
        tiers: [
          { minHoursBeforeStart: 72, refundBps: 5_000 },
          { minHoursBeforeStart: 24, refundBps: 6_000 },
        ],
      },
    ],
    ["0% tier", { nonRefundable: false, tiers: [{ minHoursBeforeStart: 1, refundBps: 0 }] }],
    ["over 100%", { nonRefundable: false, tiers: [{ minHoursBeforeStart: 1, refundBps: 10_001 }] }],
    [
      "fractional hours",
      { nonRefundable: false, tiers: [{ minHoursBeforeStart: 1.5, refundBps: 1 }] },
    ],
    ["over a year", { nonRefundable: false, tiers: [{ minHoursBeforeStart: 8761, refundBps: 1 }] }],
    [
      "eleven tiers",
      {
        nonRefundable: false,
        tiers: Array.from({ length: 11 }, (_, i) => ({
          minHoursBeforeStart: 100 - i,
          refundBps: 100,
        })),
      },
    ],
  ])("refuses %s", (_label, rule) => {
    expect(cancellationRuleProblems(rule).length).toBeGreaterThan(0);
  });
});

describe("resolution: listing → provider default → none", () => {
  it("prefers the listing's own policy, then the provider default, then nothing", () => {
    const own = policy("own");
    const def = policy("default");
    expect(resolveCancellationPolicy(own, def)).toEqual({ policy: own, source: "listing" });
    expect(resolveCancellationPolicy(null, def)).toEqual({ policy: def, source: "provider" });
    expect(resolveCancellationPolicy(undefined, undefined)).toBeNull();
  });

  it("never returns an inactive policy (second line of defence; the DB keeps them detached)", () => {
    const off = policy("off", { isActive: false });
    const def = policy("default");
    expect(resolveCancellationPolicy(off, def)).toEqual({ policy: def, source: "provider" });
    expect(resolveCancellationPolicy(off, policy("off2", { isActive: false }))).toBeNull();
  });

  it("the snapshot freezes the terms and where they came from, and nothing else", () => {
    const at = new Date("2026-12-01T06:15:00.000Z");
    const snapshot = cancellationSnapshot({ policy: policy("p1"), source: "provider" }, at);
    expect(snapshot).toEqual({
      policyId: "p1",
      name: "Policy p1",
      description: "",
      nonRefundable: false,
      rules: [{ minHoursBeforeStart: 24, refundBps: 10_000 }],
      source: "provider",
      capturedAt: "2026-12-01T06:15:00.000Z",
    });
  });
});
