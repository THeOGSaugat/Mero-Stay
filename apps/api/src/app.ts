import { randomUUID } from "node:crypto";
import express, { Router, type Express } from "express";
import helmet from "helmet";
import type { Logger } from "pino";
import { pinoHttp } from "pino-http";
import type { PrismaClient } from "./generated/prisma/client.js";
import { errorHandler } from "./middleware/error-handler.js";
import { notFoundHandler } from "./middleware/not-found.js";
import { createHealthRouter } from "./modules/health/health.routes.js";
import { createListingsRouter } from "./modules/listings/listings.routes.js";

export interface AppDependencies {
  logger: Logger;
  /** Resolves when the database is reachable; rejects otherwise. */
  checkDatabase: () => Promise<void>;
  /** Timeout for the readiness database check. Defaults to 3 seconds. */
  healthCheckTimeoutMs?: number;
  /** Database client for the /api/v1 endpoints. Without it only the health endpoints exist. */
  prisma?: PrismaClient;
  /** Clock, injectable for tests (hold expiry, "today" in Nepal). */
  now?: () => Date;
}

/**
 * Builds the Express application. Dependencies are injected so tests can run
 * the real app without a database, and so `server.ts` stays the only place that
 * wires up real infrastructure.
 */
export function createApp(deps: AppDependencies): Express {
  const app = express();

  // Security headers (also removes X-Powered-By).
  app.use(helmet());

  // Structured request logging with a per-request ID returned to the client.
  app.use(
    pinoHttp({
      logger: deps.logger,
      genReqId: (_req, res) => {
        const id = randomUUID();
        res.setHeader("X-Request-Id", id);
        return id;
      },
      // Liveness probes run constantly; logging each one is noise.
      autoLogging: { ignore: (req) => req.url === "/api/health" },
    }),
  );

  app.use(express.json({ limit: "100kb" }));

  app.use(
    "/api/health",
    createHealthRouter({
      checkDatabase: deps.checkDatabase,
      timeoutMs: deps.healthCheckTimeoutMs ?? 3_000,
    }),
  );

  if (deps.prisma) {
    const now = deps.now ?? (() => new Date());
    const v1 = Router();
    v1.use(createListingsRouter({ prisma: deps.prisma, now }));
    app.use("/api/v1", v1);
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
