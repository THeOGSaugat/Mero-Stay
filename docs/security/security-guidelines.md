# Security Guidelines

The binding summary lives in [CLAUDE.md §4](../../CLAUDE.md). This document adds detail.

## 1. Secrets management

- All secrets come from environment variables, validated at startup (`apps/api/src/config/env.ts`).
- Commit `.env.example` with **placeholder** values only, e.g. `DATABASE_URL="postgresql://USER:PASSWORD@EP-POOLER.REGION.aws.neon.tech/DBNAME?sslmode=require"`.
- Never log `process.env`, request headers containing cookies/authorization, or payment payloads in full.
- Production secrets live in the hosting provider's secret store, never in the repo.
- A leaked secret is **rotated**, not just deleted from Git.

## 2. Authentication

- Password hashing: Argon2id (preferred) or bcrypt with cost ≥ 12.
- Minimum password policy: at least 8 characters; check against common-password lists.
- Tokens are stored in `httpOnly`, `Secure`, `SameSite=Lax` (or `Strict`) cookies.
- Rate-limit login, registration, password reset and OTP endpoints; lock out or slow down repeated failures.
- Generic error messages on login ("invalid email or password") to avoid account enumeration.
- CSRF protection for cookie-authenticated state-changing requests (SameSite + origin check or CSRF token).

## 3. Authorization

- Every protected route declares its allowed roles.
- Every resource access checks **ownership** (partner ↔ property, customer ↔ booking).
- Admin actions are recorded in an audit log (who, what, when).
- IDs in URLs are not secrets. Never rely on an ID being unguessable for access control.

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

## 6. File uploads

- Allow-list MIME types (JPEG, PNG, WebP); verify magic bytes, not only the extension.
- Enforce maximum size; re-encode images and strip EXIF (GPS) metadata.
- Generate random storage keys; never use the user's filename as a path.
- Serve from object storage/CDN or a non-executable directory.

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

## 9. Privacy

- Collect only necessary personal data.
- Do not log full phone numbers, emails, ID documents or payment details at info level.
- Provide a path for account deletion (later phase).
