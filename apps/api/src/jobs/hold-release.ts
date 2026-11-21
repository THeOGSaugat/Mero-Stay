import type { Logger } from "pino";

/**
 * The scheduled hold-release job (ADR 0007): gives back the inventory held by abandoned trips by
 * running the trips service's set-based sweeper until nothing stale is left.
 *
 * Safe to run on a schedule, by several workers at once, and alongside live requests: the sweeper
 * locks the trips it processes with `FOR UPDATE SKIP LOCKED` (concurrent runs get disjoint trips)
 * and a released trip no longer matches, so a hold is released exactly once. No external lock or
 * job store is needed.
 */

export type Sweep = (limit: number) => Promise<number>;

export interface HoldReleaseResult {
  /** Trips released in this run. */
  released: number;
  batches: number;
}

export const DEFAULT_BATCH_SIZE = 500;
/** Upper bound per run so one run cannot hold a worker forever; the next run continues. */
export const DEFAULT_MAX_BATCHES = 20;

/** Runs the sweeper in batches until a batch comes back smaller than the batch size. */
export async function runHoldRelease(
  sweep: Sweep,
  { batchSize = DEFAULT_BATCH_SIZE, maxBatches = DEFAULT_MAX_BATCHES } = {},
): Promise<HoldReleaseResult> {
  let released = 0;
  let batches = 0;
  while (batches < maxBatches) {
    const count = await sweep(batchSize);
    batches += 1;
    released += count;
    if (count < batchSize) break;
  }
  return { released, batches };
}

export interface HoldReleaseLoop {
  /** Stops scheduling; resolves after the run in progress (if any) has finished. */
  stop: () => Promise<void>;
  /** Number of completed runs (successful or failed). */
  runs: () => number;
}

/**
 * Runs the job now and then every `intervalMs`, never overlapping itself: the next run is
 * scheduled only after the previous one finished. A failed run is logged and retried on the next
 * tick (e.g. a database blip), so the worker keeps going.
 */
export function startHoldReleaseLoop({
  sweep,
  intervalMs,
  logger,
}: {
  sweep: Sweep;
  intervalMs: number;
  logger: Pick<Logger, "info" | "error" | "debug">;
}): HoldReleaseLoop {
  let stopped = false;
  let completed = 0;
  let timer: NodeJS.Timeout | undefined;
  let current: Promise<void> = Promise.resolve();

  const tick = (): void => {
    current = (async () => {
      try {
        const result = await runHoldRelease(sweep);
        if (result.released > 0) logger.info(result, "hold-release: released stale trips");
        else logger.debug(result, "hold-release: nothing to release");
      } catch (err) {
        logger.error({ err }, "hold-release: run failed; retrying on the next tick");
      } finally {
        completed += 1;
        if (!stopped) timer = setTimeout(tick, intervalMs);
      }
    })();
  };
  tick();

  return {
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await current;
    },
    runs: () => completed,
  };
}
