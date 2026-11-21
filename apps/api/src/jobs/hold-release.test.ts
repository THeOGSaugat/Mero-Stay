import { afterEach, describe, expect, it, vi } from "vitest";
import { runHoldRelease, startHoldReleaseLoop } from "./hold-release.js";

const silent = { info: vi.fn(), error: vi.fn(), debug: vi.fn() };

afterEach(() => {
  vi.useRealTimers();
});

describe("runHoldRelease", () => {
  it("sweeps in batches until a batch is not full", async () => {
    const sweep = vi.fn<(limit: number) => Promise<number>>();
    sweep.mockResolvedValueOnce(2).mockResolvedValueOnce(2).mockResolvedValueOnce(1);
    expect(await runHoldRelease(sweep, { batchSize: 2 })).toEqual({ released: 5, batches: 3 });
    expect(sweep).toHaveBeenCalledWith(2);
  });

  it("stops at maxBatches so one run cannot hold a worker forever", async () => {
    const sweep = vi.fn(() => Promise.resolve(10));
    expect(await runHoldRelease(sweep, { batchSize: 10, maxBatches: 3 })).toEqual({
      released: 30,
      batches: 3,
    });
  });

  it("an idle run does one cheap batch", async () => {
    const sweep = vi.fn(() => Promise.resolve(0));
    expect(await runHoldRelease(sweep)).toEqual({ released: 0, batches: 1 });
  });
});

describe("startHoldReleaseLoop", () => {
  it("runs immediately, then on every interval, and never overlaps itself", async () => {
    vi.useFakeTimers();
    let running = 0;
    let maxConcurrent = 0;
    const sweep = vi.fn(async () => {
      running += 1;
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise((resolve) => setTimeout(resolve, 250)); // slower than the interval
      running -= 1;
      return 0;
    });

    const loop = startHoldReleaseLoop({ sweep, intervalMs: 100, logger: silent });
    await vi.advanceTimersByTimeAsync(1_000);
    await loop.stop();

    // Each run takes 250 ms and the next starts 100 ms after it ends: about 1000 / 350 runs.
    expect(loop.runs()).toBeGreaterThanOrEqual(2);
    expect(loop.runs()).toBeLessThanOrEqual(4);
    expect(maxConcurrent).toBe(1);
  });

  it("logs a failed run and keeps going", async () => {
    vi.useFakeTimers();
    const sweep = vi
      .fn<(limit: number) => Promise<number>>()
      .mockRejectedValueOnce(new Error("database blip"))
      .mockResolvedValue(3);
    const logger = { info: vi.fn(), error: vi.fn(), debug: vi.fn() };

    const loop = startHoldReleaseLoop({ sweep, intervalMs: 50, logger });
    await vi.advanceTimersByTimeAsync(120);
    await loop.stop();

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      { released: 3, batches: 1 },
      "hold-release: released stale trips",
    );
    expect(loop.runs()).toBeGreaterThanOrEqual(2);
  });

  it("stop() waits for the run in progress and schedules nothing afterwards", async () => {
    vi.useFakeTimers();
    const sweep = vi.fn(() => Promise.resolve(0));
    const loop = startHoldReleaseLoop({ sweep, intervalMs: 50, logger: silent });
    await loop.stop();
    const calls = sweep.mock.calls.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(sweep.mock.calls.length).toBe(calls);
  });
});
