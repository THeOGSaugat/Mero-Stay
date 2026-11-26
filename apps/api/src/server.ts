import { createApp } from "./app.js";
import type { AuthConfig } from "./modules/auth/auth.config.js";
import {
  authConfigFromEnv,
  loadEnvFileIfPresent,
  parseEnv,
  paymentsConfigFromEnv,
  storageConfigFromEnv,
  trustProxyConfigFromEnv,
  type Env,
} from "./config/env.js";
import { createLogger } from "./lib/logger.js";
import { createDocumentStorage } from "./lib/storage/index.js";
import { checkDatabaseConnection, createPrismaClient } from "./lib/prisma.js";

const SHUTDOWN_TIMEOUT_MS = 10_000;

function readConfig(): { env: Env; auth: AuthConfig } {
  loadEnvFileIfPresent();
  try {
    const env = parseEnv(process.env);
    return { env, auth: authConfigFromEnv(env) };
  } catch (err) {
    // The logger is not available yet because it depends on this config.
    // eslint-disable-next-line no-console
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

const { env, auth } = readConfig();
const logger = createLogger(env);
const prisma = createPrismaClient(env.DATABASE_URL);
const trustProxy = trustProxyConfigFromEnv(env);
const storageConfig = storageConfigFromEnv(env);
const storage = createDocumentStorage(storageConfig);

const app = createApp({
  logger,
  checkDatabase: () => checkDatabaseConnection(prisma),
  prisma,
  auth,
  payments: paymentsConfigFromEnv(env),
  trustProxy,
  storage,
});

const server = app.listen(env.PORT, (error) => {
  if (error) {
    logger.fatal({ err: error }, "MeroStay API failed to start");
    process.exit(1);
  }
  logger.info(
    {
      port: env.PORT,
      env: env.NODE_ENV,
      paymentGateway: env.PAYMENT_GATEWAY ?? "none",
      trustProxy: { hops: trustProxy.hops, addresses: trustProxy.addresses.join(",") },
      // The driver only: never a directory, bucket credential or key.
      documentStorage: storageConfig.driver,
    },
    "MeroStay API listening",
  );
});

let shuttingDown = false;

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Shutting down MeroStay API");

  const forceExit = setTimeout(() => {
    logger.error("Graceful shutdown timed out; forcing exit");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  server.close((closeError) => {
    prisma
      .$disconnect()
      .catch((err: unknown) => logger.error({ err }, "Error disconnecting Prisma"))
      .finally(() => {
        if (closeError) logger.error({ err: closeError }, "Error closing HTTP server");
        process.exit(closeError ? 1 : 0);
      });
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
