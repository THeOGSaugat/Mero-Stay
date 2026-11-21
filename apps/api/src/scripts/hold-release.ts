import { loadEnvFileIfPresent, parseEnv } from "../config/env.js";
import { runHoldRelease, startHoldReleaseLoop } from "../jobs/hold-release.js";
import { createLogger } from "../lib/logger.js";
import { createPrismaClient } from "../lib/prisma.js";
import { createTripsService } from "../modules/trips/trips.service.js";

/**
 * Hold-release job entry point (ADR 0007, docs/development/local-setup.md).
 *
 *   npm run jobs:hold-release          run once and exit (for cron / a platform scheduler)
 *   npm run jobs:hold-release:watch    run now and every HOLD_RELEASE_INTERVAL_SECONDS (worker)
 *
 * Production (after `npm run build`): `node apps/api/dist/scripts/hold-release.js [--watch]`.
 * Needs only DATABASE_URL (no SESSION_SECRET). Exit code 1 if a one-off run fails.
 */
async function main(): Promise<void> {
  loadEnvFileIfPresent();
  const env = parseEnv(process.env);
  const logger = createLogger(env);
  const prisma = createPrismaClient(env.DATABASE_URL);
  const trips = createTripsService({ prisma, now: () => new Date() });
  const sweep = (limit: number) => trips.expireStaleTrips(limit);

  if (!process.argv.includes("--watch")) {
    try {
      const result = await runHoldRelease(sweep);
      logger.info(result, "hold-release: done");
    } catch (err) {
      logger.error({ err }, "hold-release: failed");
      process.exitCode = 1;
    } finally {
      await prisma.$disconnect();
    }
    return;
  }

  const intervalMs = env.HOLD_RELEASE_INTERVAL_SECONDS * 1000;
  logger.info(
    { intervalSeconds: env.HOLD_RELEASE_INTERVAL_SECONDS },
    "hold-release: worker started",
  );
  const loop = startHoldReleaseLoop({ sweep, intervalMs, logger });

  const shutdown = (signal: NodeJS.Signals): void => {
    logger.info({ signal }, "hold-release: stopping");
    void loop
      .stop()
      .then(() => prisma.$disconnect())
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

await main();
