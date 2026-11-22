import type { PublicUser, SessionPayload } from "./api-types";

/**
 * Client-side auth state (ADR 0010). The session itself is an httpOnly cookie the browser holds;
 * JavaScript never sees it. What the app keeps in memory is who is logged in and the CSRF token
 * for writes, both from GET /auth/me (or login/register). Nothing goes to localStorage.
 */

export type AuthState =
  | { status: "loading"; user: null; csrfToken: null }
  | { status: "anonymous"; user: null; csrfToken: null }
  | { status: "authenticated"; user: PublicUser; csrfToken: string };

export type AuthAction = { type: "session"; session: SessionPayload } | { type: "anonymous" };

export const INITIAL_AUTH_STATE: AuthState = { status: "loading", user: null, csrfToken: null };

export function authReducer(_state: AuthState, action: AuthAction): AuthState {
  switch (action.type) {
    case "session":
      return {
        status: "authenticated",
        user: action.session.user,
        csrfToken: action.session.csrfToken,
      };
    case "anonymous":
      return { status: "anonymous", user: null, csrfToken: null };
  }
}

/**
 * Where to go after logging in. Only same-site relative paths are allowed ("/trips", not
 * "//evil.example" or "https://…"), so the `next` parameter cannot be used as an open redirect.
 */
export function safeNextPath(next: string | null | undefined, fallback = "/search"): string {
  if (!next) return fallback;
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;
  if (/[\r\n]/.test(next)) return fallback;
  return next;
}

/** /login?next=<current page>, for pages that need a logged-in customer. */
export function loginHref(currentPath: string): string {
  return `/login?next=${encodeURIComponent(safeNextPath(currentPath, "/"))}`;
}
