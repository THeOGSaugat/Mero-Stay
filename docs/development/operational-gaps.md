# Known operational gaps before launch

Things that work in development but **must be closed before MeroStay takes real bookings**. Each
has an owner phase on the [roadmap](roadmap.md). Remove an entry only when it is done and tested.

Phase numbers follow the roadmap as renumbered in Phase 5 (payments moved ahead of provider
onboarding at the owner's request).

| # | Gap | Effect today | Closed in |
|---|---|---|---|
| 1 | **No email verification.** Accounts are usable immediately; the email address is not confirmed. | Typos and fake addresses can register; booking confirmations may go to the wrong inbox. | Notifications phase (Phase 15), with Amazon SES. |
| 2 | **No password reset.** A user who forgets their password cannot recover the account. | Support must handle it manually. | Notifications phase (Phase 15): reset tokens sent by email/SMS (Sparrow SMS). |
| 3 | **No two-factor authentication.** | Account takeover relies on the password alone (mitigated by Argon2id, rate limits, 12-character minimum). | Hardening phase (Phase 16); at least for admins and partners. |
| 4 | **Rate limits live in process memory.** | Correct for one API instance. With several instances each has its own counters (limits multiply); restarting resets them. | Before running more than one instance (Hardening, Phase 16): a shared store such as Redis. |
| 5 | **Client IP behind a proxy.** Express does not trust `X-Forwarded-For` (no `trust proxy` setting). | Behind a load balancer every request appears to come from the proxy, so per-IP limits apply to everyone together. | Deployment (Phase 16): set `trust proxy` for the real hosting setup. |
| 6 | **Expired sessions are only cleaned up when used.** | Old rows accumulate in `sessions` (harmless, never valid). | A cleanup step in the Phase 5 job runner (`src/jobs/`); at the latest in Hardening (Phase 16). Not part of the Phase 5 brief. |
| 7 | **No live payment gateway.** Only the simulated test gateway exists, and it is refused in production. | In production online payment is unavailable (`503 PAYMENTS_UNAVAILABLE`); only pay-at-property bookings can complete. | Live gateways phase (Phase 10): eSewa and Khalti with server-to-server verification and signed callbacks. |
| 8 | **A real gateway can report success late**, after the trip's hold expired or the hold-release job released the items. | With the simulated gateway this cannot happen (confirm is refused after the hold, `409 TRIP_EXPIRED`). A real provider's money would arrive for released items. | Live gateways (Phase 10) with Cancellations & refunds (Phase 11): accept the callback, record the payment, then re-book or refund it. |
| 9 | **No persistent admin audit log; admins are created by SQL.** | Admin actions (pay-at-property settlement) are only in structured logs with the admin's user id. An operator grants `ADMIN` with an `UPDATE` statement. | Admin phase (Phase 7): audit-log table, admin user management. |
| 10 | **Invoice numbering and payment terms are not implemented yet** (owner decisions recorded below). Numbers are still `INV-YYYYMMDD-<random>`; `due_on` is empty. | Invoices exist and are correct, but may not meet Nepal's tax-invoice rules (sequential numbers) and have no due date. | Commission & payouts phase (Phase 12): implement the decisions below after the tax advisor confirms the numbering rules. |
| 11 | **Only admins can record a pay-at-property settlement.** | Providers cannot mark "paid on arrival" themselves. | With partner accounts (Provider onboarding, Phase 6) or the partner dashboard (Phase 13). |
| 12 | **`db:seed` relies on the caller to target the right database.** It inserts sample data into whatever `DATABASE_URL` points at, with no check. | A mistaken invocation could write sample data into a real or non-empty database (a near-miss in Phase 5: `npm run db:seed --dry-run` does not stop the script; the auto-mode guard blocked it). | A later phase (Hardening, Phase 16 at the latest): refuse to run against a non-empty or non-test database unless an explicit flag is given. |

## Owner decisions on invoicing (recorded 2026-11-21, after Phase 5)

| Topic | Decision | Status |
|---|---|---|
| Invoice numbering | **Sequential numbering is deferred to the tax advisor / finance phase.** The design must support **gap-free sequential numbers per fiscal year** (e.g. a per-fiscal-year counter allocated in the same transaction that issues the invoice, never reused after a void). | Open (gap 10). Today: `INV-YYYYMMDD-<random>` |
| Payment terms | **Default Net 15** (due 15 days after issue). This is a placeholder until finance confirms it. | Not applied yet: `due_on` stays empty until the finance phase |
| Invoice cadence | **One invoice per trip** (per provider within the trip), as built in Phase 5. | Done (ADR 0007) |
| Payout schedule | **Deferred to the payouts phase.** | Open (Commission & payouts, Phase 12) |

## Closed

| Gap | Closed in | How |
|---|---|---|
| Trips used a temporary `userId`; no ownership; commission/payout visible to callers | Phase 4 (ADR 0006) | Session authentication; owner from the session; other users' trips are 404; customer view hides commission/payout |
| The trips API was off by default (opt-in flag) until auth existed | Phase 4 (ADR 0006) | Flag removed entirely; trips always require a session |
| `INVOICED` commission had no invoice record | Phase 5 (ADR 0007) | Trip confirm issues one invoice per trip and provider in the same transaction and links the items. The database refuses `INVOICED` without an invoice, a second live invoice for the same trip and provider, and an issued amount that differs from the items' commission. Tests prove: created exactly once with the right amount, no-op on retry, one invoice under three concurrent confirms |
| The hold-release job was not scheduled | Phase 5 (ADR 0007) | `npm run jobs:hold-release` (cron/platform scheduler, once) and `jobs:hold-release:watch` (worker; started by `npm run dev`), documented for dev and production. Tests prove: the loop releases abandoned holds on schedule; confirmed, paid and partly paid bookings keep theirs; four concurrent runs release each hold exactly once |

See also: [README deployment notes](../../README.md#deployment-notes), [api.md](../architecture/api.md),
[ADR 0005](../architecture/decisions/0005-search-and-booking-api-conventions.md),
[ADR 0006](../architecture/decisions/0006-authentication.md),
[ADR 0007](../architecture/decisions/0007-payments-and-invoices.md).
