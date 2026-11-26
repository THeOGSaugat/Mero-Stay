import { Router } from "express";
import { clientIp } from "../../lib/client-ip.js";
import { limitPerClient } from "../../lib/limit-per-client.js";
import { adminSetupSchema, type AdminAccountsService } from "./admin-accounts.service.js";

/**
 * POST /api/v1/auth/admin-setup (Phase 12, gap 9, ADR 0018): an invited admin sets their password
 * with the one-time link. No session (they have no password yet); rate limited per client
 * (10 per 15 minutes); the token is checked against its stored SHA-256 only.
 */
export function createAdminSetupRouter({ service }: { service: AdminAccountsService }): Router {
  const router = Router();
  router.post(
    "/auth/admin-setup",
    limitPerClient({ limit: 10, windowMs: 15 * 60_000 }),
    async (req, res) => {
      const input = adminSetupSchema.parse(req.body ?? {});
      const requestId = (req as { id?: unknown }).id;
      await service.completeSetup(
        { ip: clientIp(req) ?? null, requestId: typeof requestId === "string" ? requestId : null },
        input,
      );
      res.setHeader("Cache-Control", "no-store");
      res.status(204).end();
    },
  );
  return router;
}
