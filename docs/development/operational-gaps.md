# Known operational gaps before launch

Things that work in development but **must be closed before MeroStay takes real bookings**. Each
has an owner phase on the [roadmap](roadmap.md). Remove an entry only when it is done and tested.

| # | Gap | Effect today | Closed in |
|---|---|---|---|
| 1 | **The hold-release job is not scheduled.** `expireStaleTrips()` exists and is tested, but nothing runs it. | Inventory held by abandoned draft trips (and unpaid online items) stays counted as taken until the sweeper runs, so search can show less availability than is really free. | Payments phase (Phase 9): run it on a schedule (e.g. every minute). |
| 2 | **`INVOICED` commission has no invoice record.** At confirm, pay-at-property items get `commission_status = INVOICED`, but no `provider_invoices` row is created and `commission_invoice_id` stays empty. | The amount owed is correct on each item, but there is no invoice to send, track or mark paid. | Commission & payouts phase (Phase 11): create invoices and link items. |
| 3 | **Trips use a temporary `userId`, not real authentication.** The trip endpoints take the owner from the request body and check no ownership. Commission and payout fields are visible to whoever calls them. | Unsafe for any public use. | Authentication phase (Phase 4): owner from the session, ownership checks, customer-facing responses hide commission/payout. |
| 4 | **The trips API is off by default until auth lands.** `ALLOW_UNAUTHENTICATED_TRIPS_API` defaults to `false` in every environment (`403 TRIPS_API_DISABLED`). | Search works; booking endpoints are unavailable unless a developer opts in locally. Must stay `false` on every public deployment. | Authentication phase (Phase 4): the flag and its guard are removed once real auth protects the endpoints. |

See also: [README deployment notes](../../README.md#deployment-notes), [api.md](../architecture/api.md),
[ADR 0005](../architecture/decisions/0005-search-and-booking-api-conventions.md).
