# Phase 04: Authentication & Ownership

- **Status:** Approved pending merge (Neon verification passed 2026-11-20)
- **Branch:** `phase/04-authentication`
- **Date:** 2026-11-20

## Scope (as approved)

Real accounts and ownership so the trips API can be always on: register, login, logout, me;
every trip owned by a user; the temporary `userId` and the unauthenticated-trips flag removed.
**Not built:** UI, payments, refunds, payouts, reviews, notifications, partner/admin dashboards,
OAuth, 2FA, email verification, password reset.

## What was built

- **Mechanism** ([ADR 0006](../architecture/decisions/0006-authentication.md)): opaque random session
  token in an `httpOnly`, `SameSite=Lax` cookie (`Secure` + `__Host-` in production); only its
  SHA-256 is stored in a new `sessions` table; 7-day absolute lifetime; logout deletes the row.
- **Endpoints:** `POST /auth/register`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`.
  Responses contain only `id, email, phone, fullName, role, status, createdAt` plus a CSRF token.
- **Passwords:** Argon2id from `node:crypto` (m = 19 MiB, t = 2, p = 1). No new dependency.
- **CSRF:** `X-CSRF-Token` = HMAC(`SESSION_SECRET`, session) on state-changing requests with a
  session; login/register JSON-only (415 otherwise).
- **Enumeration/brute force:** one generic `401 INVALID_CREDENTIALS`, dummy Argon2 check for
  unknown emails; in-memory rate limits (login per email and per IP, registration per IP) → 429.
- **Trips:** always authenticated; owner taken from the session; reads and row locks filter by
  `customer_id`, so another user's trip is **404, identical to a missing trip**; `userId` in the body
  is rejected (400); responses are the **customer view** (no commission/payout fields).
- **Flag removed:** env variable, guard, 403 path, startup warning and current docs. A test fails if
  it reappears outside the two historical records (ADR 0005, Phase 3 report, both marked superseded).
- **Migration** `20261120090000_add_authentication` (new; no applied migration edited): `users.
  password_hash`, `status`, `last_login_at`, `sessions` table; CHECKs: normalized email,
  Argon2id-only password hashes, hex token hashes, expiry after creation. Applied to dev Neon
  (zero drift).
- **Config:** `SESSION_SECRET` (required; server refuses to start without it), `SESSION_TTL_HOURS`,
  `SESSION_COOKIE_SECURE` (cannot be false in production).

## Verification (real results)

| Check | Result |
|---|---|
| `lint` / `typecheck` / `format:check` / `build` | Pass |
| Unit tests | API 153/153 (12 files), web 16/16 |
| Integration, throwaway PostgreSQL 17 | **118/118** (7 files: auth, trips incl. ownership, listings, Phase 2 schema/constraints/seed) |
| **Integration, Neon `test` branch** | **118/118 (7 files), 548 s**, on branch `ep-fragrant-dream-…` (separate from dev `ep-muddy-sunset-…`). Afterwards: dev branch untouched (0 users/sessions/trips), test branch holds the test data. |
| Migration on dev Neon | Applied; status up to date; drift check 0 |
| Mutation checks | Owner filter removed from reads/locks → 8 failures; CSRF check disabled → 2 failures |
| Built server smoke test | Refuses to start without `SESSION_SECRET`; anonymous trip 401; register 201 (HttpOnly cookie); trip write without CSRF 403, with CSRF 201; logout 204; `/auth/me` then 401; old flag set to `true` has no effect |

### Neon verification history

1. First attempt: blocked before any test ran. Neon rejected the old test-branch credentials (`28P01`).
2. Second attempt: **refused by the test-database guard** because the new `TEST_DATABASE_URL` pointed at
   the dev database (same host, database and credentials; the Neon Connect dialog defaults to the main
   branch). No test ran and nothing was wiped. This is the guard working as designed.
3. Third attempt, with the `test` branch's own connection strings: guard passed (pooled and direct on
   the same database, different from dev), **118/118 passed**.

## Security checklist

- [x] No password, hash or session token in any response (asserted over every auth and trips response)
- [x] Database refuses non-Argon2id password hashes
- [x] No secrets committed; `SESSION_SECRET` placeholder is empty on purpose
- [x] Another user's trip is indistinguishable from a missing one

## Operational gaps

Closed: temporary `userId`; trips API off until auth. Added: no email verification, no password
reset, no 2FA, in-memory rate limits, `trust proxy`, expired-session cleanup
([operational-gaps.md](../development/operational-gaps.md)).

## Known limitations / follow-ups

1. ~~Neon test-branch credentials~~: refreshed by the owner; Neon run passed (see above).
2. Your local `apps/api/.env` needs `SESSION_SECRET` before `npm run dev` (the API refuses to start
   without it): `SESSION_SECRET=$(openssl rand -base64 48)`.
3. `packages/shared` moved to the web phase (no second consumer of the Zod schemas yet).
4. Partner/admin roles exist but have no endpoints yet (Phase 5+).
