import { describe, expect, it } from "vitest";
import { nextRecheckAt, RECHECK_OFFSETS_MINUTES, RECHECK_WINDOW_MS } from "./gateway-recheck.js";

describe("re-checking closed gateway payments (ADR 0018, gap 33)", () => {
  const closed = new Date("2026-11-26T10:00:00Z");

  it("asks at 5 min, 65 min, 6 h and 25 h after closing, then stops", () => {
    expect(RECHECK_OFFSETS_MINUTES).toEqual([5, 65, 360, 1500]);
    expect(nextRecheckAt(closed, 0)?.toISOString()).toBe("2026-11-26T10:05:00.000Z");
    expect(nextRecheckAt(closed, 1)?.toISOString()).toBe("2026-11-26T11:05:00.000Z");
    expect(nextRecheckAt(closed, 2)?.toISOString()).toBe("2026-11-26T16:00:00.000Z");
    expect(nextRecheckAt(closed, 3)?.toISOString()).toBe("2026-11-27T11:00:00.000Z");
    expect(nextRecheckAt(closed, 4)).toBeNull();
  });

  it("the pick-up window covers the last check (65 min is past Khalti's 60-min link)", () => {
    const last = RECHECK_OFFSETS_MINUTES.at(-1)! * 60_000;
    expect(RECHECK_WINDOW_MS).toBeGreaterThan(last);
    expect(RECHECK_OFFSETS_MINUTES[1]).toBeGreaterThan(60);
  });
});
