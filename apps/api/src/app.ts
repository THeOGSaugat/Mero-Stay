import { randomUUID } from "node:crypto";
import express, { Router, type Express } from "express";
import helmet from "helmet";
import type { Logger } from "pino";
import { pinoHttp } from "pino-http";
import type { PrismaClient } from "./generated/prisma/client.js";
import { createProxyTrust, NO_TRUSTED_PROXY, type TrustProxyConfig } from "./lib/client-ip.js";
import type { DocumentStorage } from "./lib/storage/index.js";
import { createCancellationPoliciesService } from "./modules/cancellation-policies/cancellation-policies.service.js";
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
import { createAdminRouter } from "./modules/admin/admin.routes.js";
import { createAuditLogService } from "./modules/audit/audit-log.service.js";
import { createProviderBookingsService } from "./modules/bookings/provider-bookings.service.js";
import { createFinanceService } from "./modules/finance/finance.service.js";
import { createInventoryService } from "./modules/inventory/inventory.service.js";
import { createListingManagementService } from "./modules/listings/listing-management.service.js";
import { createPartnerRouter } from "./modules/partner/partner.routes.js";
import { createProviderTypesRouter } from "./modules/providers/provider-types.routes.js";
import { createLocationsRouter } from "./modules/locations/locations.routes.js";
import { createProvidersService } from "./modules/providers/providers.service.js";
import { NO_PAYMENTS, type PaymentsConfig } from "./modules/payments/payments.config.js";
import { createPaymentsRouter } from "./modules/payments/payments.routes.js";
import { createPaymentsService } from "./modules/payments/payments.service.js";

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
  /** Online payment gateway (ADR 0007). Default: none (payment intents/confirm return 503). */
  payments?: PaymentsConfig;
  /** Clock, injectable for tests (hold expiry, "today" in Nepal). */
  now?: () => Date;
  /**
   * Which proxies' X-Forwarded-For entries are believed for the client IP (ADR 0014). Default:
   * none, so `req.ip` is the socket peer. Never Express's `true`.
   */
  trustProxy?: TrustProxyConfig;
  /**
   * Private storage for verification documents (ADR 0016). Without it the document file endpoints
   * answer 503 STORAGE_UNAVAILABLE (tests that do not touch files can omit it).
   */
  storage?: DocumentStorage;
}

/**
 * Builds the Express application. Dependencies are injected so tests can run
 * the real app without a database, and so `server.ts` stays the only place that
 * wires up real infrastructure.
 */
export function createApp(deps: AppDependencies): Express {
  const app = express();

  // Client IP (rate limits, audit rows): believe X-Forwarded-For only from the configured proxy
  // addresses and only for the configured number of hops (ADR 0014, gap 5).
  app.set("trust proxy", createProxyTrust(deps.trustProxy ?? NO_TRUSTED_PROXY));

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
    v1.use(createProviderTypesRouter({ prisma: deps.prisma }));
    v1.use(createLocationsRouter({ prisma: deps.prisma }));
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
    const paymentsService = createPaymentsService({
      prisma: deps.prisma,
      now,
      config: deps.payments ?? NO_PAYMENTS,
    });
    // Always authenticated; owner-scoped (ADR 0007).
    v1.use(createPaymentsRouter({ service: paymentsService, auth: authMiddleware }));
    const providersService = createProvidersService({
      prisma: deps.prisma,
      now,
      ...(deps.storage ? { storage: deps.storage } : {}),
    });
    const policiesService = createCancellationPoliciesService({ prisma: deps.prisma });
    const financeService = createFinanceService({ prisma: deps.prisma });
    // Partners: role PARTNER, scoped to their own provider (ADR 0008). Onboarding: any logged-in customer.
    v1.use(
      createPartnerRouter({
        prisma: deps.prisma,
        auth: authMiddleware,
        providers: providersService,
        listings: createListingManagementService({ prisma: deps.prisma }),
        inventory: createInventoryService({ prisma: deps.prisma }),
        bookings: createProviderBookingsService({ prisma: deps.prisma, now }),
        finance: financeService,
        policies: policiesService,
      }),
    );
    // MeroStay staff only: role ADMIN on the session user; writes audited.
    v1.use(
      createAdminRouter({
        prisma: deps.prisma,
        auth: authMiddleware,
        payments: paymentsService,
        providers: providersService,
        finance: financeService,
        auditLog: createAuditLogService({ prisma: deps.prisma }),
        policies: policiesService,
      }),
    );
    app.use("/api/v1", v1);
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
