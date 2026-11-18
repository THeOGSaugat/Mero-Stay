import { Router } from "express";
import { withTimeout } from "../../lib/with-timeout.js";

export const SERVICE_NAME = "merostay-api";

export type DependencyStatus = "up" | "down";

/** GET /api/health: liveness. The process is running and serving HTTP. */
export interface LivenessResponse {
  status: "ok";
  service: typeof SERVICE_NAME;
  uptimeSeconds: number;
  timestamp: string;
}

/** GET /api/health/ready: readiness. Dependencies (database) are reachable. */
export interface ReadinessResponse {
  status: "ok" | "unavailable";
  service: typeof SERVICE_NAME;
  checks: { database: DependencyStatus };
  timestamp: string;
}

export interface HealthRouterDependencies {
  /** Resolves when the database answers; rejects otherwise. */
  checkDatabase: () => Promise<void>;
  /** Maximum time to wait for the database check. */
  timeoutMs: number;
}

/**
 * Liveness and readiness are separate on purpose: a temporary database outage
 * should mark the API "not ready" without making orchestrators restart it.
 */
export function createHealthRouter(deps: HealthRouterDependencies): Router {
  const router = Router();

  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  router.get("/", (_req, res) => {
    const body: LivenessResponse = {
      status: "ok",
      service: SERVICE_NAME,
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    };
    res.json(body);
  });

  router.get("/ready", async (req, res) => {
    let database: DependencyStatus = "up";
    try {
      await withTimeout(deps.checkDatabase(), deps.timeoutMs, "Database health check timed out");
    } catch (err) {
      database = "down";
      // Log the cause server-side; never expose it to clients.
      req.log.warn({ err }, "Readiness check: database unavailable");
    }

    const ready = database === "up";
    const body: ReadinessResponse = {
      status: ready ? "ok" : "unavailable",
      service: SERVICE_NAME,
      checks: { database },
      timestamp: new Date().toISOString(),
    };
    res.status(ready ? 200 : 503).json(body);
  });

  return router;
}
