import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import {
  ADMIN_SETUP_TTL_MS,
  checkAdminSuspension,
  isSetupTokenUsable,
} from "../../domain/admin-accounts.js";
import { AppError } from "../../lib/errors.js";
import { uuidSchema } from "../../lib/validation.js";
import { recordAudit, type AuditContext } from "../audit/audit.js";
import { emailSchema, newPasswordSchema } from "../auth/auth.schemas.js";
import { hashPassword } from "../auth/password.js";

/**
 * Admin accounts (Phase 12, gap 9, ADR 0018).
 *
 * - An admin creates another admin (email + name). The new account has NO password: the response
 *   carries a one-time setup link (random 32 bytes, only its SHA-256 stored, 24 h), shown once.
 *   With no email system yet (Notifications phase), the creating admin hands the link over out of
 *   band. Nobody ever chooses or sees another person's password.
 * - Admins are suspended and reactivated, never deleted. You cannot suspend yourself, and the last
 *   usable admin (active + password) can never be suspended; the database repeats that rule and
 *   admin changes are serialised by an advisory lock, so two admins cannot suspend each other at
 *   once. Suspending also ends the account's sessions.
 * - Every change is audited; tokens and passwords never reach an audit row or a response.
 */

export const createAdminSchema = z
  .object({ email: emailSchema, fullName: z.string().trim().min(1).max(200) })
  .strict();
export const adminSetupSchema = z
  .object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), password: newPasswordSchema })
  .strict();
export const adminIdParamsSchema = z.object({ id: uuidSchema }).strict();

const ADMIN_SELECT = {
  id: true,
  email: true,
  fullName: true,
  status: true,
  passwordHash: true,
  lastLoginAt: true,
  createdAt: true,
} as const;

type AdminRow = Prisma.UserGetPayload<{ select: typeof ADMIN_SELECT }>;

/** What responses show: never the hash, only whether a password was set. */
export interface AdminView {
  id: string;
  email: string | null;
  fullName: string;
  status: "ACTIVE" | "SUSPENDED";
  setupPending: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
}

function view(row: AdminRow): AdminView {
  return {
    id: row.id,
    email: row.email,
    fullName: row.fullName,
    status: row.status,
    setupPending: row.passwordHash === null,
    lastLoginAt: row.lastLoginAt,
    createdAt: row.createdAt,
  };
}

const hashToken = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");
const adminNotFound = () => new AppError(404, "ADMIN_NOT_FOUND", "Admin not found.");

export interface SetupLink {
  /** Web path; the token is in the fragment so it never reaches a server log or a Referer. */
  setupPath: string;
  expiresAt: Date;
}

export function createAdminAccountsService({
  prisma,
  now,
}: {
  prisma: PrismaClient;
  now: () => Date;
}) {
  async function lockAdminChanges(tx: Prisma.TransactionClient): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('merostay.admin_accounts'))`;
  }

  async function issueLink(
    tx: Prisma.TransactionClient,
    userId: string,
    createdById: string,
  ): Promise<SetupLink> {
    const at = now();
    // Older unused links of this account stop working.
    await tx.adminSetupToken.updateMany({
      where: { userId, usedAt: null },
      data: { expiresAt: at },
    });
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(at.getTime() + ADMIN_SETUP_TTL_MS);
    await tx.adminSetupToken.create({
      data: { userId, tokenHash: hashToken(token), expiresAt, createdById, createdAt: at },
    });
    return { setupPath: `/admin-setup#token=${token}`, expiresAt };
  }

  async function list(): Promise<AdminView[]> {
    const rows = await prisma.user.findMany({
      where: { role: "ADMIN" },
      select: ADMIN_SELECT,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    return rows.map(view);
  }

  async function create(
    ctx: AuditContext,
    input: z.infer<typeof createAdminSchema>,
  ): Promise<{ admin: AdminView; link: SetupLink }> {
    return prisma.$transaction(async (tx) => {
      await lockAdminChanges(tx);
      const taken = await tx.user.findUnique({
        where: { email: input.email },
        select: { id: true },
      });
      if (taken) {
        throw new AppError(409, "EMAIL_TAKEN", "An account with this email already exists.");
      }
      const user = await tx.user.create({
        data: { email: input.email, fullName: input.fullName, role: "ADMIN", status: "ACTIVE" },
        select: ADMIN_SELECT,
      });
      const link = await issueLink(tx, user.id, ctx.actorUserId);
      await recordAudit(tx, ctx, {
        action: "admin.create",
        entityType: "user",
        entityId: user.id,
        after: {
          role: "ADMIN",
          email: user.email,
          fullName: user.fullName,
          setupLinkExpiresAt: link.expiresAt,
        },
      });
      return { admin: view(user), link };
    });
  }

  /** A fresh link for an invited admin who has not set a password yet (the old one stops working). */
  async function newSetupLink(ctx: AuditContext, id: string): Promise<SetupLink> {
    return prisma.$transaction(async (tx) => {
      await lockAdminChanges(tx);
      const user = await tx.user.findFirst({ where: { id, role: "ADMIN" }, select: ADMIN_SELECT });
      if (!user) throw adminNotFound();
      if (user.passwordHash !== null) {
        throw new AppError(409, "ADMIN_ALREADY_SET_UP", "This admin has already set a password.");
      }
      const link = await issueLink(tx, id, ctx.actorUserId);
      await recordAudit(tx, ctx, {
        action: "admin.setup_link.reissue",
        entityType: "user",
        entityId: id,
        after: { setupLinkExpiresAt: link.expiresAt },
      });
      return link;
    });
  }

  async function setStatus(
    ctx: AuditContext,
    id: string,
    status: "ACTIVE" | "SUSPENDED",
  ): Promise<{ admin: AdminView; changed: boolean }> {
    return prisma.$transaction(async (tx) => {
      await lockAdminChanges(tx);
      const user = await tx.user.findFirst({ where: { id, role: "ADMIN" }, select: ADMIN_SELECT });
      if (!user) throw adminNotFound();
      if (user.status === status) return { admin: view(user), changed: false };
      if (status === "SUSPENDED") {
        const usable = await tx.user.findMany({
          where: { role: "ADMIN", status: "ACTIVE", passwordHash: { not: null } },
          select: { id: true },
        });
        const check = checkAdminSuspension({
          actorId: ctx.actorUserId,
          targetId: id,
          usableAdminIds: usable.map((u) => u.id),
        });
        if (!check.ok) {
          throw check.refusal === "SELF_LOCKOUT"
            ? new AppError(409, "ADMIN_SELF_LOCKOUT", "You cannot suspend your own account.")
            : new AppError(409, "LAST_ADMIN", "At least one active admin must remain.");
        }
      }
      const updated = await tx.user.update({
        where: { id },
        data: { status },
        select: ADMIN_SELECT,
      });
      if (status === "SUSPENDED") await tx.session.deleteMany({ where: { userId: id } });
      await recordAudit(tx, ctx, {
        action: status === "SUSPENDED" ? "admin.suspend" : "admin.reactivate",
        entityType: "user",
        entityId: id,
        before: { status: user.status },
        after: { status },
      });
      return { admin: view(updated), changed: true };
    });
  }

  /**
   * Public (no session): the invited admin sets their password with the link. One use; expired,
   * used or unknown tokens all give the same answer.
   */
  async function completeSetup(
    meta: { ip: string | null; requestId: string | null },
    input: z.infer<typeof adminSetupSchema>,
  ): Promise<void> {
    const passwordHash = await hashPassword(input.password);
    await prisma.$transaction(async (tx) => {
      await lockAdminChanges(tx);
      const token = await tx.adminSetupToken.findUnique({
        where: { tokenHash: hashToken(input.token) },
        include: { user: { select: { id: true, role: true, status: true, passwordHash: true } } },
      });
      const at = now();
      if (
        !token ||
        !isSetupTokenUsable(token, at) ||
        token.user.role !== "ADMIN" ||
        token.user.status !== "ACTIVE" ||
        token.user.passwordHash !== null
      ) {
        throw new AppError(
          400,
          "SETUP_LINK_INVALID",
          "This setup link is invalid or has expired. Ask an admin for a new one.",
        );
      }
      await tx.adminSetupToken.update({ where: { id: token.id }, data: { usedAt: at } });
      await tx.user.update({
        where: { id: token.user.id },
        data: { passwordHash },
        select: { id: true },
      });
      await recordAudit(
        tx,
        { actorUserId: token.user.id, actorRole: "ADMIN", ip: meta.ip, requestId: meta.requestId },
        {
          action: "admin.setup.complete",
          entityType: "user",
          entityId: token.user.id,
          after: { setupPending: false },
        },
      );
    });
  }

  return { list, create, newSetupLink, setStatus, completeSetup };
}

export type AdminAccountsService = ReturnType<typeof createAdminAccountsService>;

export function serializeAdmin(admin: AdminView) {
  return {
    id: admin.id,
    email: admin.email,
    fullName: admin.fullName,
    status: admin.status,
    setupPending: admin.setupPending,
    lastLoginAt: admin.lastLoginAt?.toISOString() ?? null,
    createdAt: admin.createdAt.toISOString(),
  };
}

export function serializeSetupLink(link: SetupLink) {
  return { setupPath: link.setupPath, expiresAt: link.expiresAt.toISOString() };
}
