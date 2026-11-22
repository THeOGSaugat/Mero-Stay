import { Router } from "express";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { listOfferedProviderTypes } from "./providers.service.js";

/**
 * Public: the provider types offered at onboarding (`provider_types.is_active`), each with the
 * verification documents it requires (ADR 0009). A type that is not offered (e.g. airline while
 * flights are not built) is simply absent; it stays in the schema.
 */
export function createProviderTypesRouter({ prisma }: { prisma: PrismaClient }): Router {
  const router = Router();
  router.get("/provider-types", async (_req, res) => {
    res.json({ data: await listOfferedProviderTypes(prisma) });
  });
  return router;
}
