# Known operational gaps before launch

Things that work in development but **must be closed before MeroStay takes real bookings**. Each
has an owner phase on the [roadmap](roadmap.md). Remove an entry only when it is done and tested.

| # | Gap | Effect today | Closed in |
|---|---|---|---|
| 1 | **The hold-release job is not scheduled.** `expireStaleTrips()` exists and is tested, but nothing runs it. | Inventory held by abandoned draft trips (and unpaid online items) stays counted as taken until the sweeper runs, so search can show less availability than is really free. | Payments phase (Phase 9): run it on a schedule (e.g. every minute). |
| 2 | **`INVOICED` commission has no invoice record.** At confirm, pay-at-property items get `commission_status = INVOICED`, but no `provider_invoices` row is created and `commission_invoice_id` stays empty. | The amount owed is correct on each item, but there is no invoice to send, track or mark paid. | Commission & payouts phase (Phase 11): create invoices and link items. |
| 3 | **No email verification.** Accounts are usable immediately; the email address is not confirmed. | Typos and fake addresses can register; booking confirmations may go to the wrong inbox. | Notifications phase (Phase 14), with Amazon SES. |
| 4 | **No password reset.** A user who forgets their password cannot recover the account. | Support must handle it manually. | Notifications phase (Phase 14): reset tokens sent by email/SMS (Sparrow SMS). |
| 5 | **No two-factor authentication.** | Account takeover relies on the password alone (mitigated by Argon2id, rate limits, 12-character minimum). | Hardening phase (Phase 15); at least for admins and partners. |
| 6 | **Rate limits live in process memory.** | Correct for one API instance. With several instances each has its own counters (limits multiply); restarting resets them. | Before running more than one instance (Hardening, Phase 15): a shared store such as Redis. |
| 7 | **Client IP behind a proxy.** Express does not trust `X-Forwarded-For` (no `trust proxy` setting). | Behind a load balancer every request appears to come from the proxy, so per-IP limits apply to everyone together. | Deployment (Phase 15): set `trust proxy` for the real hosting setup. |
| 8 | **Expired sessions are only cleaned up when used.** | Old rows accumulate in `sessions` (harmless, never valid). | With the scheduled jobs (Payments, Phase 9): delete expired sessions periodically. |

## Closed

| Gap | Closed in | How |
|---|---|---|
| Trips used a temporary `userId`; no ownership; commission/payout visible to callers | Phase 4 (ADR 0006) | Session authentication; owner from the session; other users' trips are 404; customer view hides commission/payout |
| The trips API was off by default (opt-in flag) until auth existed | Phase 4 (ADR 0006) | Flag removed entirely; trips always require a session |

See also: [README deployment notes](../../README.md#deployment-notes), [api.md](../architecture/api.md),
[ADR 0005](../architecture/decisions/0005-search-and-booking-api-conventions.md),
[ADR 0006](../architecture/decisions/0006-authentication.md).
