import type { Request } from "express";
import type { Prisma } from "../../generated/prisma/client.js";
import type { UserRole } from "../../generated/prisma/enums.js";
import { maskAccountNumber } from "../../domain/masking.js";
import { toJsonSafe } from "../../lib/money-json.js";
import { currentUser } from "../auth/auth-context.js";

/**
 * Audit log (ADR 0008): who did what to which entity, with a before/after snapshot.
 *
 * Every admin write and every sensitive partner write calls `recordAudit` INSIDE the transaction
 * that makes the change, so an audit row exists exactly when the change was committed (never for
 * a rolled-back change, never twice). Rows are append-only (a trigger refuses UPDATE/DELETE).
 *
 * Snapshots pass through `redactForAudit`: secrets are dropped and bank account numbers masked.
 * A database CHECK (`audit_log_no_secrets_chk`) refuses any row that still has a secret-looking key.
 */

export interface AuditContext {
  actorUserId: string;
  actorRole: UserRole;
  ip: string | null;
  requestId: string | null;
}

export interface AuditEntry {
  /** Dotted, lower-case: "<entity>.<verb>[.<detail>]", e.g. "provider.verification.approve". */
  action: string;
  entityType: string;
  entityId: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}

/** The acting user and request, taken from the authenticated request. */
export function auditContextOf(req: Request): AuditContext {
  const user = currentUser(req);
  const requestId = (req as { id?: unknown }).id;
  return {
    actorUserId: user.id,
    actorRole: user.role,
    ip: req.ip ?? null,
    requestId: typeof requestId === "string" ? requestId : null,
  };
}

/** Keys whose values are never stored in an audit row (compared case-insensitively, no `_`). */
const DROPPED_KEYS = new Set([
  "password",
  "passwordhash",
  "token",
  "tokenhash",
  "sessiontoken",
  "csrftoken",
  "sessionsecret",
  "secret",
]);
const ACCOUNT_NUMBER_KEYS = new Set(["accountnumber"]);

const normalise = (key: string) => key.toLowerCase().replaceAll("_", "");

/**
 * A JSON-safe copy without secrets: secret keys are removed, bank account numbers are replaced by
 * `accountNumberMasked` (last 4). Applied recursively to nested objects and arrays.
 */
export function redactForAudit(value: unknown): unknown {
  const safe = toJsonSafe(value);
  return redact(safe);
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    const k = normalise(key);
    if (DROPPED_KEYS.has(k)) continue;
    if (ACCOUNT_NUMBER_KEYS.has(k)) {
      out.accountNumberMasked = typeof inner === "string" ? maskAccountNumber(inner) : null;
      continue;
    }
    out[key] = redact(inner);
  }
  return out;
}

function snapshot(
  value: Record<string, unknown> | null | undefined,
): Prisma.InputJsonObject | undefined {
  if (value === null || value === undefined) return undefined;
  return redactForAudit(value) as Prisma.InputJsonObject;
}

/** Writes one audit row in the caller's transaction. */
export async function recordAudit(
  tx: Prisma.TransactionClient,
  ctx: AuditContext,
  entry: AuditEntry,
): Promise<void> {
  await tx.auditLog.create({
    data: {
      actorUserId: ctx.actorUserId,
      actorRole: ctx.actorRole,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      before: snapshot(entry.before),
      after: snapshot(entry.after),
      ip: ctx.ip,
      requestId: ctx.requestId,
    },
  });
}
