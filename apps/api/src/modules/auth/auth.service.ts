import type { PrismaClient } from "../../generated/prisma/client.js";
import { inspectDatabaseError } from "../../lib/database-errors.js";
import { AppError } from "../../lib/errors.js";
import type { AuthConfig } from "./auth.config.js";
import type { AuthContext } from "./auth-context.js";
import {
  createUser,
  deleteSession,
  findPublicUser,
  findSessionByTokenHash,
  findUserForLogin,
  insertSession,
  recordLogin,
  type PublicUser,
} from "./auth.repository.js";
import type { LoginInput, RegisterInput } from "./auth.schemas.js";
import { dummyPasswordHash, hashPassword, verifyPassword } from "./password.js";
import { csrfTokenFor, generateSessionToken, hashSessionToken } from "./tokens.js";

export interface AuthServiceDeps {
  prisma: PrismaClient;
  config: AuthConfig;
  now: () => Date;
}

export interface IssuedSession {
  user: PublicUser;
  /** Raw token for the cookie. Never stored, never logged, never in a response body. */
  token: string;
  csrfToken: string;
  expiresAt: Date;
}

/** One generic message for every failed login, whatever the reason (no account enumeration). */
export const INVALID_CREDENTIALS = new AppError(
  401,
  "INVALID_CREDENTIALS",
  "Email or password is incorrect.",
);

export function createAuthService({ prisma, config, now }: AuthServiceDeps) {
  async function issueSession(user: PublicUser): Promise<IssuedSession> {
    const token = generateSessionToken();
    const tokenHash = hashSessionToken(token);
    const expiresAt = new Date(now().getTime() + config.sessionTtlMs);
    await insertSession(prisma, { userId: user.id, tokenHash, expiresAt });
    return { user, token, csrfToken: csrfTokenFor(config.sessionSecret, tokenHash), expiresAt };
  }

  async function register(input: RegisterInput): Promise<IssuedSession> {
    // Hash before the uniqueness check so a duplicate email costs the same time as a new one.
    const passwordHash = await hashPassword(input.password);
    let user: PublicUser;
    try {
      user = await createUser(prisma, {
        email: input.email,
        passwordHash,
        fullName: input.fullName,
        ...(input.phone ? { phone: input.phone } : {}),
      });
    } catch (err) {
      const info = inspectDatabaseError(err);
      if (info?.sqlState === "23505" && info.constraint === "users_email_key") {
        throw new AppError(409, "EMAIL_TAKEN", "An account with this email already exists.");
      }
      if (info?.sqlState === "23505" && info.constraint === "users_phone_key") {
        throw new AppError(409, "PHONE_TAKEN", "An account with this phone number already exists.");
      }
      throw err;
    }
    return issueSession(user);
  }

  async function login(input: LoginInput, previousSessionId?: string): Promise<IssuedSession> {
    const account = await findUserForLogin(prisma, input.email);

    // Always run one Argon2 verification, even for unknown emails or accounts without a
    // password, so timing does not reveal whether the account exists.
    const valid = account?.passwordHash
      ? await verifyPassword(input.password, account.passwordHash)
      : (await verifyPassword(input.password, await dummyPasswordHash()), false);
    if (!account || !valid) throw INVALID_CREDENTIALS;

    if (account.status !== "ACTIVE") {
      // Only revealed after a correct password.
      throw new AppError(403, "ACCOUNT_DISABLED", "This account is disabled.");
    }

    // Session fixation hygiene: a login always gets a brand-new session.
    if (previousSessionId) await deleteSession(prisma, previousSessionId);
    await recordLogin(prisma, account.id, now());
    const user = await findPublicUser(prisma, account.id);
    if (!user) throw INVALID_CREDENTIALS;
    return issueSession(user);
  }

  /** The session for a cookie token, or null if unknown, expired, or the user is not ACTIVE. */
  async function resolveSession(token: string): Promise<AuthContext | null> {
    if (token.length < 20 || token.length > 200) return null;
    const session = await findSessionByTokenHash(prisma, hashSessionToken(token));
    if (!session) return null;
    if (session.expiresAt.getTime() <= now().getTime()) {
      await deleteSession(prisma, session.id); // lazy cleanup
      return null;
    }
    if (session.user.status !== "ACTIVE") return null;
    return {
      user: session.user,
      session: { id: session.id, tokenHash: session.tokenHash, expiresAt: session.expiresAt },
    };
  }

  async function logout(sessionId: string): Promise<void> {
    await deleteSession(prisma, sessionId);
  }

  function csrfToken(context: AuthContext): string {
    return csrfTokenFor(config.sessionSecret, context.session.tokenHash);
  }

  return { register, login, resolveSession, logout, csrfToken };
}

export type AuthService = ReturnType<typeof createAuthService>;
