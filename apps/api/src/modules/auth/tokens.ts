import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Session and CSRF tokens (ADR 0006).
 * - Session token: 256 random bits, base64url, sent only in an httpOnly cookie. The database stores
 *   its SHA-256 (hex), so a leaked sessions table cannot be replayed as cookies.
 * - CSRF token: HMAC-SHA256(SESSION_SECRET, session token hash). Stateless, bound to the session,
 *   returned in response bodies and sent back by clients in the X-CSRF-Token header.
 */

export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function csrfTokenFor(secret: string, sessionTokenHash: string): string {
  return createHmac("sha256", secret).update(`csrf:${sessionTokenHash}`).digest("base64url");
}

export function isValidCsrfToken(
  secret: string,
  sessionTokenHash: string,
  presented: string,
): boolean {
  const expected = Buffer.from(csrfTokenFor(secret, sessionTokenHash));
  const actual = Buffer.from(presented);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Minimal Cookie header parser (no dependency). First occurrence of a name wins. */
export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    let value = part.slice(index + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (!cookies.has(name)) {
      try {
        cookies.set(name, decodeURIComponent(value));
      } catch {
        // Malformed percent-encoding: ignore this cookie.
      }
    }
  }
  return cookies;
}
