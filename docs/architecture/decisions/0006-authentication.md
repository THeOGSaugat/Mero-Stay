# 0006. Authentication: server-side sessions in httpOnly cookies

- **Status:** Accepted (pending owner review of Phase 4)
- **Date:** 2026-11-20
- **Phase:** 04
- **Supersedes:** ADR 0005 decision 10 and its amendment (the temporary `userId` and the
  opt-in flag that served trips without authentication are removed)

## Context

Phase 3 shipped the trips API without authentication: a `userId` in the request body, no ownership
checks, commission/payout fields visible, and a flag that kept the endpoints off by default.
Phase 4 adds real accounts so the trips API can always be on, safely. The first client is the
Next.js web app (same site); mobile apps come later.

## Decision

### Mechanism: opaque session token in an httpOnly cookie, session stored server-side

- Login/registration create a row in `sessions` and set a cookie holding a **random 256-bit token**
  (base64url). The database stores only **SHA-256(token)**; a leaked `sessions` table cannot be
  replayed as cookies.
- Every authenticated request looks the session up; logout **deletes the row**, so revocation is
  immediate (a stolen cookie stops working at logout). Suspending a user invalidates all their
  sessions at once (`users.status` is checked on every request).
- **Absolute lifetime: 7 days** (`SESSION_TTL_HOURS`). No sliding renewal yet. Expired rows are
  rejected and deleted lazily on use (a cleanup job is an operational gap).
- A login always creates a **new** session and deletes the one the browser presented (session
  fixation defence).
- Hand-written (~150 lines) instead of `express-session` + a store adapter: two fewer
  dependencies, behaviour fully covered by tests, and the session model lives in our schema.

Why not JWT: revocation needs a server-side list anyway, tokens in JavaScript-readable storage are
exposed to XSS, and a same-site web app gains nothing from stateless tokens. Mobile apps can later
use the same opaque token in an `Authorization` header without changing the session store.

### Cookie

| Attribute | Value | Why |
|---|---|---|
| Name | `__Host-merostay_session` when Secure, else `merostay_session` | `__Host-` forces Secure, `Path=/` and no `Domain` (blocks cookie injection from subdomains) |
| `HttpOnly` | always | JavaScript cannot read the session token |
| `Secure` | production (required there); off on `http://localhost` | HTTPS only |
| `SameSite` | `Lax` | Not sent on cross-site subrequests; first CSRF layer |
| `Path` / `Expires` | `/` / session expiry | |

### CSRF

1. **SameSite=Lax** cookie.
2. **Synchronizer token, stateless:** every state-changing request with a session (POST/PATCH/PUT/
   DELETE on `/trips…` and `/auth/logout`) must send `X-CSRF-Token: HMAC-SHA256(SESSION_SECRET,
   session token hash)`. The token is returned by register, login and `GET /auth/me`. A cross-site
   page can make the browser send the cookie but cannot read the token. Missing/invalid → `403
   CSRF_TOKEN_INVALID`.
3. **Login/register accept only `application/json`** (`415` otherwise). HTML forms cannot send JSON
   cross-site without a CORS preflight, which this API never approves, so login CSRF is blocked.

### Passwords

- **Argon2id** via Node's built-in `crypto.argon2` (no native npm module): **m = 19 MiB, t = 2,
  p = 1** (OWASP Password Storage Cheat Sheet minimum), 16-byte random salt, 32-byte tag, stored as
  a PHC string. Parameters live in each hash, so they can be raised later.
- A database CHECK accepts only `$argon2id$v=19$…` in `users.password_hash`: plaintext cannot be
  stored even by a bug.
- Policy: **12–128 characters**, any characters, no composition rules, small block-list of common
  passwords (OWASP ASVS). Passwords are NFC-normalized before hashing.
- Comparison with `timingSafeEqual`.

### Account enumeration and brute force

- Every failed login returns the same `401 INVALID_CREDENTIALS` ("Email or password is incorrect.")
  for a wrong password, an unknown email, or an account without a password. Unknown emails still run
  one Argon2 verification against a dummy hash so timing does not reveal existence.
  `ACCOUNT_DISABLED` (403) is only returned after a correct password.
- Registration does reveal that an email is taken (`409 EMAIL_TAKEN`), as required for a usable
  sign-up; rate limiting bounds harvesting.
- **Rate limits** (fixed window, in process memory): login 10 / 15 min per email and 30 / 15 min per
  IP; registration 5 / hour per IP → `429 RATE_LIMITED` + `Retry-After`. Single-instance only
  (operational gap before scaling out).

### Ownership and response shape

- **All `/trips` routes require a session** (401 otherwise). The owner is the session user;
  `POST /trips` no longer accepts `userId` (`.strict()` → 400). It is rejected immediately rather
  than "ignored for one release" as ADR 0005 suggested, because the trips API was off by default and
  no client depends on it.
- Ownership is enforced in the **data layer**: trip reads and row locks filter by
  `customer_id = session user`. Another user's trip is therefore **404 `TRIP_NOT_FOUND`, identical
  to a trip that does not exist**, so trip IDs reveal nothing across accounts (chosen over 403).
- **Customer view:** trip and quote responses no longer contain commission rate/amount, provider
  payout, commission status or payout status. They stay stored per item; admin/partner views come
  with their phases.
- Search and listing endpoints stay **public**.

### Secrets

- `SESSION_SECRET` (≥ 32 chars, from env) signs CSRF tokens. The API refuses to start without it; an
  empty value counts as missing (the `.env.example` placeholder is empty on purpose). Rotating it
  invalidates CSRF tokens only; clients fetch a new one from `GET /auth/me`.
- Production refuses `SESSION_COOKIE_SECURE=false`.

### Removed

The Phase 3 opt-in flag that served trips without authentication (named in ADR 0005): its env
variable, guard, `403 TRIPS_API_DISABLED` response, startup warning and current documentation.
A test fails if the variable name reappears outside historical records and the tests that assert
its absence.

## Alternatives considered

- **JWT access + refresh tokens:** see above; more moving parts, harder revocation.
- **`express-session` + `connect-pg-simple`:** fine, but two dependencies for what is a small table
  and a lookup; less control over token hashing.
- **bcrypt / native `argon2` npm package:** Argon2id is preferred by CLAUDE.md and OWASP, and Node 26
  ships it, so no native build step or install script is needed.
- **403 for other users' trips:** confirms the ID exists; 404 avoids that.

## Consequences

- Clients must keep the cookie (browser: automatic; same-site deployment) and send `X-CSRF-Token`
  on writes. The Next.js app will proxy `/api` same-origin in the web phase.
- New gaps (tracked in `docs/development/operational-gaps.md`): no email verification, no password
  reset, no 2FA, in-memory rate limits (single instance), no expired-session cleanup job, client IP
  behind a proxy needs `trust proxy` configuration.
- Partner and admin roles exist on `users.role`, but there are no partner/admin endpoints yet;
  their authorization rules arrive with those phases.
