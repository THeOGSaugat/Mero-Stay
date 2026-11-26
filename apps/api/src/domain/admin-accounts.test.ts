import { describe, expect, it } from "vitest";
import { ADMIN_SETUP_TTL_MS, checkAdminSuspension, isSetupTokenUsable } from "./admin-accounts.js";

describe("admin accounts (ADR 0018, gap 9)", () => {
  it("never suspends yourself, never the last usable admin", () => {
    expect(
      checkAdminSuspension({ actorId: "a", targetId: "a", usableAdminIds: ["a", "b"] }),
    ).toEqual({
      ok: false,
      refusal: "SELF_LOCKOUT",
    });
    expect(checkAdminSuspension({ actorId: "a", targetId: "b", usableAdminIds: ["b"] })).toEqual({
      ok: false,
      refusal: "LAST_ADMIN",
    });
    expect(
      checkAdminSuspension({ actorId: "a", targetId: "b", usableAdminIds: ["a", "b"] }),
    ).toEqual({
      ok: true,
    });
    // An invited admin who never set a password is not "usable": suspending them is fine.
    expect(checkAdminSuspension({ actorId: "a", targetId: "c", usableAdminIds: ["a"] })).toEqual({
      ok: true,
    });
  });

  it("a setup link works once, for 24 hours", () => {
    const now = new Date("2026-11-26T12:00:00Z");
    const fresh = { expiresAt: new Date(now.getTime() + ADMIN_SETUP_TTL_MS), usedAt: null };
    expect(ADMIN_SETUP_TTL_MS).toBe(86_400_000);
    expect(isSetupTokenUsable(fresh, now)).toBe(true);
    expect(isSetupTokenUsable({ ...fresh, usedAt: now }, now)).toBe(false);
    expect(isSetupTokenUsable(fresh, new Date(fresh.expiresAt.getTime()))).toBe(false);
  });
});
