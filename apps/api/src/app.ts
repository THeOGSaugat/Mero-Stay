import { randomUUID } from "node:crypto";
import express, { Router, type Express } from "express";
import helmet from "helmet";
import type { Logger } from "pino";
import { pinoHttp } from "pino-http";
import type { PrismaClient } from "./generated/prisma/client.js";
import type { AuthConfig } from "./modules/auth/auth.config.js";
import { createAuthMiddleware } from "./modules/auth/auth.middleware.js";
import { createAuthRouter } from "./modules/auth/auth.routes.js";
import { createAuthService } from "./modules/auth/auth.service.js";
import { errorHandler } from "./middleware/error-handler.js";
import { notFoundHandler } from "./middleware/not-found.js";
import { createHealthRouter } from "./modules/health/health.routes.js";
import { createListingsRouter } from "./modules/listings/listings.routes.js";
import { createTripsRouter } from "./modules/trips/trips.routes.js";
import { createTripsService } from "./modules/trips/trips.service.js";

export interface AppDependencies {
  logger: Logger;
  /** Resolves when the database is reachable; rejects otherwise. */
  checkDatabase: () => Promise<void>;
  /** Timeout for the readiness database check. Defaults to 3 seconds. */
  healthCheckTimeoutMs?: number;
  /** Database client for the /api/v1 endpoints. Without it only the health endpoints exist. */
  prisma?: PrismaClient;
  /** Session/CSRF/rate-limit settings (ADR 0006). Required together with `prisma`. */
  auth?: AuthConfig;
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
    if (!deps.auth) throw new Error("createApp: `auth` config is required when `prisma` is given");
    const now = deps.now ?? (() => new Date());
    const authService = createAuthService({ prisma: deps.prisma, config: deps.auth, now });
    const authMiddleware = createAuthMiddleware(authService, deps.auth);

    const v1 = Router();
    // Public: browsing and search need no account.
    v1.use(createListingsRouter({ prisma: deps.prisma, now }));
    // Accounts and sessions.
    v1.use(
      createAuthRouter({
        service: authService,
        middleware: authMiddleware,
        config: deps.auth,
        now,
      }),
    );
    // Always authenticated; owner-scoped.
    v1.use(
      createTripsRouter({
        service: createTripsService({ prisma: deps.prisma, now }),
        auth: authMiddleware,
      }),
    );
    app.use("/api/v1", v1);
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
