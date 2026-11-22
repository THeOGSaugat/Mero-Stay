import type { Request, RequestHandler } from "express";
import type { PrismaClient } from "../../generated/prisma/client.js";
import type { ProviderStatus } from "../../generated/prisma/enums.js";
import { AppError } from "../../lib/errors.js";
import { uuidSchema } from "../../lib/validation.js";
import { currentUser } from "../auth/auth-context.js";

/**
 * Partner scoping (ADR 0008). Every /partner request acts for exactly ONE provider owned by the
 * session user, resolved here once:
 *
 * - The user owns one provider → that one.
 * - The user owns several (e.g. a homestay and a tour company) → the `X-Provider-Id` header picks
 *   one; without it → 400 PROVIDER_ID_REQUIRED.
 * - `X-Provider-Id` names a provider the user does not own (or that does not exist) → 404, the same
 *   answer for both, so provider existence never leaks across partners.
 *
 * Services then filter every query by `providerId`: another provider's listing, slot, booking or
 * invoice is a 404, never a 403.
 */
export interface PartnerContext {
  providerId: string;
  providerStatus: ProviderStatus;
}

declare global {
  // Express's documented extension point for typing request properties.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      partner?: PartnerContext;
    }
  }
}

export function createPartnerContext(prisma: PrismaClient): RequestHandler {
  return async (req, _res, next) => {
    const user = currentUser(req);
    const owned = await prisma.provider.findMany({
      where: { ownerUserId: user.id },
      select: { id: true, status: true },
      orderBy: { createdAt: "asc" },
    });
    const header = req.get("x-provider-id");
    if (header !== undefined && header !== "") {
      if (!uuidSchema.safeParse(header).success) {
        throw new AppError(400, "VALIDATION_ERROR", "X-Provider-Id must be a UUID.");
      }
      const chosen = owned.find((p) => p.id === header);
      if (!chosen) throw new AppError(404, "PROVIDER_NOT_FOUND", "Provider not found.");
      req.partner = { providerId: chosen.id, providerStatus: chosen.status };
      next();
      return;
    }
    if (owned.length === 0) {
      throw new AppError(
        409,
        "PARTNER_NOT_ONBOARDED",
        "Create your provider first (POST /api/v1/partner/onboarding).",
      );
    }
    if (owned.length > 1) {
      throw new AppError(
        400,
        "PROVIDER_ID_REQUIRED",
        "You manage several providers; choose one with the X-Provider-Id header.",
        { providerIds: owned.map((p) => p.id) },
      );
    }
    const only = owned[0]!;
    req.partner = { providerId: only.id, providerStatus: only.status };
    next();
  };
}

/** The provider this partner request acts for. Throws 403 if the route forgot the middleware. */
export function currentPartner(req: Request): PartnerContext {
  if (!req.partner) throw new AppError(403, "FORBIDDEN", "Your account cannot use this endpoint.");
  return req.partner;
}

/** A suspended provider can read its data but not change it. */
export function assertProviderWritable(status: ProviderStatus): void {
  if (status === "SUSPENDED") {
    throw new AppError(
      403,
      "PROVIDER_SUSPENDED",
      "This provider is suspended; changes are disabled.",
    );
  }
}
