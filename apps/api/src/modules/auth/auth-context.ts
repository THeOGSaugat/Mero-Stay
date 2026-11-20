import type { Request } from "express";
import { AppError } from "../../lib/errors.js";
import type { PublicUser } from "./auth.repository.js";

/** The authenticated user and session for the current request, set by the loadSession middleware. */
export interface AuthContext {
  user: PublicUser;
  session: { id: string; tokenHash: string; expiresAt: Date };
}

declare global {
  // Express's documented extension point for typing request properties.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

/** The authenticated user. Throws 401 if the route forgot requireAuth (fails closed). */
export function currentUser(req: Request): PublicUser {
  if (!req.auth) throw new AppError(401, "UNAUTHENTICATED", "Log in to continue.");
  return req.auth.user;
}
