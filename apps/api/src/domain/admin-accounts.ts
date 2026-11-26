/**
 * Admin account rules (Phase 12, gap 9, ADR 0018). Pure, unit-tested; the database repeats the
 * last-admin rule (users_keep_an_admin) and the service serialises admin changes.
 *
 * "Usable" admin = role ADMIN, status ACTIVE and a password set (an invited admin who has not used
 * the setup link yet cannot sign in, so does not count).
 */

export type AdminChangeRefusal = "SELF_LOCKOUT" | "LAST_ADMIN";

export function checkAdminSuspension(input: {
  actorId: string;
  targetId: string;
  /** Ids of every usable admin right now. */
  usableAdminIds: readonly string[];
}): { ok: true } | { ok: false; refusal: AdminChangeRefusal } {
  if (input.actorId === input.targetId) return { ok: false, refusal: "SELF_LOCKOUT" };
  const others = input.usableAdminIds.filter((id) => id !== input.targetId);
  if (input.usableAdminIds.includes(input.targetId) && others.length === 0) {
    return { ok: false, refusal: "LAST_ADMIN" };
  }
  return { ok: true };
}

/** A setup link lasts 24 hours and works once. */
export const ADMIN_SETUP_TTL_MS = 24 * 60 * 60 * 1000;

export function isSetupTokenUsable(
  token: { expiresAt: Date; usedAt: Date | null },
  now: Date,
): boolean {
  return token.usedAt === null && token.expiresAt.getTime() > now.getTime();
}
