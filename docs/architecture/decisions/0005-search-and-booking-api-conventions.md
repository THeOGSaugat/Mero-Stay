# 0005. Search and booking API conventions

- **Status:** Accepted (pending owner review of Phase 3)
- **Date:** 2026-11-19
- **Phase:** 03

## Context

Phase 3 exposes the Phase 2 data model over HTTP: vertical-agnostic search and a trip/booking-item
API with quotes and confirmation. Several shape decisions affect every future client (web, mobile,
partner integrations) and are hard to change later.

## Decisions

1. **Versioned paths.** Feature endpoints live under `/api/v1/...` (CLAUDE.md §3.3). Health checks
   stay at `/api/health` and `/api/health/ready`.

2. **Money is a digit string in minor units at the boundary.** Every money field is named `*Minor`
   and serialized as a string of digits, e.g. `"115500"` = Rs 1,155.00. Every money-bearing object
   carries `currency` (ISO 4217) and `currencyExponent` (2 for NPR). Inputs use the same format
   (`minPrice=350000`). Rates stay JSON numbers in basis points (`commissionRateBps: 1500`).
   - **Explicit serializers, no global `BigInt.prototype.toJSON`.** A forgotten conversion makes
     `JSON.stringify` throw, the request fails with a generic 500, and the test suite catches it.
     A global patch would hide the mistake and could emit money in an undocumented format.
   - A test helper walks every response and fails on any `*Minor` field that is not a digit string
     or lacks a currency in scope.

3. **Inventory is held when an item is added**, not at confirm. Adding/updating an item increments
   `inventory_slots.capacity_booked` inside the same transaction; the Phase 2 CHECK constraint
   rejects overbooking even under concurrent requests, and the API maps it to
   `409 INSUFFICIENT_AVAILABILITY`. The API does no capacity arithmetic of its own on write paths.
   Holds expire with the trip (`expires_at`, 30 minutes, refreshed on every edit); an expiry sweeper
   (`expireStaleTrips`) releases them. Scheduling the sweeper is a later phase.

4. **Every trip write runs in one transaction with a row lock on the trip** (`SELECT … FOR UPDATE`),
   so trip totals are always recomputed from a consistent item list.

5. **Pricing reuses the Phase 2 helpers.** `trip-pricing.ts` calls `calculateItemCharges`,
   `resolveCommissionRateBps` and `summarizeTrip`; the same formulas are enforced by the database
   CHECK constraints, so an amount the API computes is exactly what the database accepts. Tests
   compare the quote with the stored totals and re-evaluate the CHECK formulas in SQL.

6. **Quote is a dry run.** `POST /trips/:id/quote` re-prices the trip's items from current data
   (and optional candidate items) without writing anything. Its availability is advisory; the
   authoritative check is the constraint when an item is added. It reports `priceChanged` when the
   current price differs from the held one.

7. **Prices are frozen when an item is added** (snapshot on the booking item). Confirm does not
   re-price; it validates that each listing is still bookable, then:
   - pay-at-property items → `CONFIRMED`, commission `INVOICED` (owed by the provider, §6.1);
   - online items stay `PENDING` / `UNPAID` (no gateway yet); commission will be deducted from the
     provider payout;
   - trip → `CONFIRMED` if all items are confirmed, else `PENDING` with a payment window.
   `INVOICED` here means "owed and to be invoiced"; the `provider_invoices` row is created in the
   finance phase.

8. **Payment method lives in `payment_status`** (Phase 2 model): `UNPAID` = online, `PAY_AT_PROPERTY` =
   pay at property. In requests/responses it is exposed as `paymentMethod: "online" | "pay_at_property"`.
   No schema change was needed.

9. **Service dates are client-shaped and vertical-agnostic.** A request sends `startDate` and an
   optional exclusive `endDate`; the item consumes one inventory row per date in `[start, end)`, or
   just `start`. Hotels and multi-day guides send a range; buses, tours and activities send one
   date. No vertical is hard-coded. A date without an inventory row, or a `CLOSED` row, is not sellable.

10. **Temporary unauthenticated trips.** Until authentication exists, trip endpoints accept a
    `userId` in the request body and perform no ownership checks. They are **disabled by default in
    production** (`ALLOW_UNAUTHENTICATED_TRIPS_API`), returning `403 TRIPS_API_DISABLED`.
    When auth arrives: the owner comes from the session, `userId` is ignored (accepted but unused
    for one release, then rejected), ownership is enforced, and commission/payout fields are
    shown only to admins and the owning partner. Paths and response shapes stay the same.

11. **Error codes.** 400 = malformed input (`VALIDATION_ERROR`); 404 = the resource in the path does
    not exist; 409 = state/availability conflicts; 422 = a well-formed request that breaks a business
    rule (e.g. `CURRENCY_MISMATCH`, `LISTING_NOT_BOOKABLE`). Raw PostgreSQL text never reaches clients.

## Alternatives considered

- **Money as JSON numbers:** silently wrong above 2^53 and ambiguous about units.
- **Money as decimal strings ("1155.00"):** needs the exponent anyway and invites float parsing;
  minor units match the database exactly.
- **Holds only at confirm:** a customer could build a trip that can't be confirmed; overbooking
  would be found late.
- **Re-pricing at confirm:** prices could change between quote and confirm without the customer
  agreeing; holding the price for the hold window is clearer.

## Consequences

- Clients must parse `*Minor` strings as integers (e.g. `BigInt("115500")`) and format with
  `currencyExponent`.
- Inventory held by abandoned drafts is released only when the sweeper runs; until it is
  scheduled, held units stay counted.
- New verticals need no endpoint changes: a new listing type, optional detail table (added to
  `DETAIL_INCLUDE`) and inventory rows are enough.
