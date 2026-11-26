import { loadEnvFileIfPresent, parseEnv, paymentsConfigFromEnv } from "../config/env.js";
import { runHoldRelease, startHoldReleaseLoop } from "../jobs/hold-release.js";
import { createLogger } from "../lib/logger.js";
import { createPrismaClient } from "../lib/prisma.js";
import { createPaymentsService } from "../modules/payments/payments.service.js";
import { createTripsService } from "../modules/trips/trips.service.js";

/**
 * Hold-release job entry point (ADR 0007, docs/development/local-setup.md).
 *
 *   npm run jobs:hold-release          run once and exit (for cron / a platform scheduler)
 *   npm run jobs:hold-release:watch    run now and every HOLD_RELEASE_INTERVAL_SECONDS (worker)
 *
 * Production (after `npm run build`): `node apps/api/dist/scripts/hold-release.js [--watch]`.
 * Needs DATABASE_URL and the payment settings (eSewa/Khalti keys, to ask the gateways about open
 * payments before their hold ends; gap 8, ADR 0017), no SESSION_SECRET. Exit code 1 if a one-off
 * run fails.
 */
async function main(): Promise<void> {
  loadEnvFileIfPresent();
  const env = parseEnv(process.env);
  const logger = createLogger(env);
  const prisma = createPrismaClient(env.DATABASE_URL);
  const trips = createTripsService({ prisma, now: () => new Date() });
  const payments = createPaymentsService({
    prisma,
    now: () => new Date(),
    config: paymentsConfigFromEnv(env),
  });
  // Gap 8 (ADR 0017): ask eSewa/Khalti about open payments of holds about to end before releasing
  // them, so money from a customer who never came back is applied or recorded, never dropped.
  const sweep = async (limit: number) => {
    const checked = await payments.checkExpiringPayments(limit);
    if (checked.applied > 0 || checked.unavailable > 0) {
      logger.info(checked, "hold-release: checked open gateway payments");
    }
    const released = await trips.expireStaleTrips(limit);
    // Gap 33 (ADR 0018): closed eSewa/Khalti payments are asked again on a schedule.
    const rechecked = await payments.recheckClosedPayments(limit);
    if (rechecked.recorded > 0 || rechecked.unavailable > 0) {
      logger.info(rechecked, "hold-release: re-checked closed gateway payments");
    }
    return released;
  };

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
