# Security Guidelines

The binding summary lives in [CLAUDE.md §4](../../CLAUDE.md). This document adds detail.

## 1. Secrets management

- All secrets come from environment variables, validated at startup (`apps/api/src/config/env.ts`).
- Commit `.env.example` with **placeholder** values only, e.g. `DATABASE_URL="postgresql://USER:PASSWORD@EP-POOLER.REGION.aws.neon.tech/DBNAME?sslmode=require"`.
- Never log `process.env`, request headers containing cookies/authorization, or payment payloads in full.
- Production secrets live in the hosting provider's secret store, never in the repo.
- A leaked secret is **rotated**, not just deleted from Git.

## 2. Authentication (implemented in Phase 4, ADR 0006)

- Passwords: Argon2id via `node:crypto` (m = 19 MiB, t = 2, p = 1; OWASP), random 16-byte salt,
  PHC string; a database CHECK rejects anything that is not an Argon2id hash.
- Password policy: 12–128 characters, no composition rules, common passwords rejected.
- Sessions: random 256-bit token in an `httpOnly`, `SameSite=Lax` cookie (`Secure` + `__Host-` in
  production); the database stores only SHA-256(token); absolute lifetime 7 days; logout deletes
  the session; suspended users lose all sessions; a login always issues a new session.
- CSRF: `X-CSRF-Token` = HMAC(`SESSION_SECRET`, session) required on state-changing requests with a
  session; login/register accept only `application/json`.
- Rate limits: login 10 / 15 min per email and 30 / 15 min per client IP; registration 5 / hour
  per client IP (IPv6 by /64).
- **Client IP (ADR 0014):** `trust proxy` is never `true`.
  - An `X-Forwarded-For` entry counts only within `TRUST_PROXY_HOPS` and only from
    `TRUST_PROXY_ADDRESSES`; both are required in production.
  - The web server (`apps/web/server.mts`) appends the connecting address. A client-written header
    can never choose the rate-limit bucket or the audit IP.
- One generic "Email or password is incorrect." for every failed login, with a dummy Argon2 check for
  unknown emails so timing does not reveal accounts.
- Never return or log passwords, hashes or session tokens. Users are selected through
  `PUBLIC_USER_SELECT`; only the login query reads `password_hash`.

## 3. Authorization

- Every protected route declares its allowed roles.
- Every resource access checks **ownership** (partner ↔ property, customer ↔ booking).
- Admin writes and sensitive partner writes are recorded in the append-only `audit_log` (who, role,
  what, which entity, before/after, IP, request id, when), in the same transaction as the change
  (ADR 0008). Payloads go through `redactForAudit` (no passwords, hashes, tokens, secrets; account
  numbers masked) and a database CHECK refuses secret-looking keys.
- Roles are checked before any data is read (wrong role → 403 for every URL in the area); within a
  role, another owner's data is a 404. Partners act for one owned provider per request
  (`X-Provider-Id` when they own several).
- IDs in URLs are not secrets. Never rely on an ID being unguessable for access control.
- Trips are owner-scoped in the query itself; another user's trip is a 404 (no existence leak).

## 4. Input & output

- Zod validation on all body/query/params; `.strict()` to reject unknown keys.
- Output is serialised through explicit DTOs, never raw Prisma objects (avoid leaking `passwordHash` etc.).
- React escapes output by default; avoid `dangerouslySetInnerHTML`. Sanitise any rich text.

## 5. Payments (eSewa / Khalti)

- The amount is calculated on the server from the booking, never taken from the client.
- After redirect/callback, **verify the transaction with the provider's server API** before confirming.
- Verify signatures where the provider supplies them.
- Make callback handlers idempotent (unique provider transaction ID; repeated callbacks are no-ops).
- Store provider references and raw verification responses (without secrets) for reconciliation.
- Use sandbox credentials in development; never commit merchant secrets.
- Phase 5 (ADR 0007): the only gateway is a **simulated** one for development; the API refuses to
  start with `PAYMENT_GATEWAY=simulated` in production. Intents are idempotent per trip (one open
  charge per trip, enforced by a unique index); confirmations are idempotent (a succeeded payment is
  returned unchanged); database triggers stop over-allocation and keep each item's payment status
  equal to its allocations.
- Admin-only actions (e.g. recording a pay-at-property settlement) require `role = ADMIN` on the
  session user, checked before any data is read; the role cannot be granted through the API.

## 6. File uploads

- Allow-list MIME types; verify magic bytes, not only the extension.
- Enforce maximum size; re-encode images and strip EXIF (GPS) metadata.
- Generate random storage keys; never use the user's filename as a path.
- Serve from object storage/CDN or a non-executable directory.

**Verification documents (Phase 10, ADR 0016)** follow this as follows.

- **Type:** PDF, JPEG and PNG only, checked from the first bytes.
- **Size:** exactly the declared size, at most 10 MB. The web server refuses larger `/api/v1`
  bodies before Next.js buffers them.
- **Metadata:** JPEG/PNG metadata is stripped (EXIF/GPS, IPTC, comments, text chunks).
- **Keys:** server-generated (`documents/<provider>/<document>/<random>`); the file name is a display
  name only.
- **Storage:** private (local disk outside any web root, files 0600, or a private S3-compatible
  bucket).
- **Access:** only the owning partner and admins, through the API. Responses are attachments with
  `no-store` and a sandboxing CSP. Admin views are audited; audit rows hold metadata only.
- **Not yet done:** malware scanning, PDF metadata and image re-encoding (operational gaps 26, 29).

## 7. HTTP & infrastructure

- `helmet` security headers; strict CORS allow-list (web origin only).
- HTTPS everywhere in production; HSTS.
- Request body size limits.
- Production errors return generic messages; details go to server logs only.
- Database user for the app has only the privileges it needs.

## 8. Dependencies & supply chain

- Run `npm audit` every phase; address high/critical issues.
- Prefer well-maintained, widely used packages; justify every new dependency.
- Commit `package-lock.json` for reproducible installs.

## 9. Sensitive data in the database

- Bank account numbers are never returned in full by any endpoint (partner or admin): only
  `accountNumberMasked` (last 4). Partners see customers by name only; email and phone are masked.

- `provider_payout_accounts.account_number`, `providers.pan_number` and verification documents are
  sensitive. Only admins and the owning partner may read them; never include them in logs, list
  endpoints or analytics exports.
- Before launch, decide on application-level encryption for bank account numbers (tracked in the
  Phase 2 report as a follow-up). Neon encrypts data at rest.
- Verification document files live in private object storage (`storage_key`), never in the database
  and never on a public URL.

## 10. Privacy

- Collect only necessary personal data.
- Do not log full phone numbers, emails, ID documents or payment details at info level.
- Provide a path for account deletion (later phase).
