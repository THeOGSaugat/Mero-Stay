# 0004. Multi-vertical data model: Listing → Trip → BookingItem

- **Status:** Accepted
- **Date:** 2026-11-19
- **Phase:** 02

## Context

MeroStay is a multi-vertical Nepal travel marketplace, not a hotel-booking site. One customer
trip mixes item types from different providers: e.g. a bus seat plus a homestay
(Inaruwa → Shree Antu), or a flight/bus, guide, tour and teahouse nights (Annapurna Base Camp).

The MVP ships hotels, buses and guides/tours. Flights must be modelled but not built. New
verticals (activities, permits, transport, packages) and real partner integrations come later and
**must not require redesigning core tables**. The owner confirmed the money and scope decisions in
[requirements §6.1](../../product/requirements.md#61-decided-by-the-owner).

## Decision

1. **Generic core.** `providers` (typed by `provider_types`) own `listings` (typed by
   `listing_types`). A customer's `trips` contain `booking_items`, each referencing one listing.
   Type-specific columns never go into the core tables.
2. **Verticals are lookup rows, not enums.** `listing_types` and `provider_types` are tables seeded
   by migrations. A new vertical is an `INSERT`, not an `ALTER TYPE`/`ALTER TABLE` on a core table.
   `listing_types.is_active = false` marks verticals that are modelled but not offered (flights);
   `is_bookable = false` marks container listings (a hotel property groups its bookable rooms).
3. **Hybrid type-specific data.** Verticals whose fields search must filter on get a 1:1 detail
   table keyed by `listing_id` (`hotel_details`, `hotel_room_details`, `bus_route_details`,
   `guide_service_details`, `tour_details`, `flight_route_details`). Rare extras, and new verticals
   before they earn a table, use `listings.attributes` (JSONB). Activities use JSON only.
4. **Generic availability.** `inventory_slots`: one row per listing per service date (a night, a bus
   departure, a guide-day, a tour departure) with capacity and an optional date price. A CHECK
   constraint makes `capacity_booked > capacity_total` impossible.
5. **Per-item money.** Each booking item stores its own subtotal, service charge, VAT, total,
   commission rate and amount, provider payout, currency, and payment/commission/payout statuses.
   Per-date units and unit prices are in `booking_item_slots` (nightly prices can differ). Trip
   totals are stored sums of item amounts.
6. **Commission: 15% per item.** `commission = round_half_up(subtotal × rate_bps / 10000)`, taxes
   excluded, deducted from the provider's share. Rate resolution: listing override → provider
   override → platform default (1500 bps). The resolved rate is stored on the item, so changing a
   rate never alters past bookings. Online items: commission collected by deduction from the payout.
   Pay-at-property items: commission invoiced (`provider_invoices`).
7. **Per-item payment.** Statuses `UNPAID / PAID / PAY_AT_PROPERTY / PARTIALLY_REFUNDED / REFUNDED`
   live on each item. Gateway transactions (`payments`) are split across items by
   `payment_allocations`. The gateway is a text field, so adding one needs no migration.
8. **Per-item cancellation.** Policies (`cancellation_policies`, owned by a provider or platform
   templates) hold structured refund tiers. Each item stores the policy ID and a **frozen snapshot**.
9. **Aggregator MVP, integration-ready.** `providers.integration_type` (MANUAL in the MVP),
   `providers.external_ref`, `listings.external_id` + `last_synced_at`,
   `booking_items.external_booking_ref`.
10. **Money and currency.** Integer minor units + ISO 4217 `currency` on listings, items, trips,
    payments, payouts and invoices (`NPR` default). MVP: one currency per trip.
11. **Database-enforced integrity.** CHECK constraints re-verify every money formula, rate range,
    currency format, date order and capacity. The TypeScript functions in `src/domain/money.ts`
    use the same rounding, verified against PostgreSQL in tests.
12. **Shapes only for later phases.** `payments`, `payment_allocations`, `payouts`,
    `provider_invoices`, `reviews` (one per completed item) and `notifications` exist so later
    phases add behaviour, not tables.

## Alternatives considered

- **One table per vertical** (`hotel_bookings`, `bus_bookings`, ...): simple at first, but a trip
  then spans many tables; every new vertical needs new booking, payment and payout code paths.
- **Everything in JSON** (no detail tables): fewest tables, but bus route/date and room-capacity
  searches can't use proper columns, indexes or constraints.
- **Postgres enums for listing types:** every new vertical would need an enum migration; a lookup
  table also carries metadata (unit label, bookable, active).
- **Commission on the trip total:** rounding and refunds become ambiguous when a single item is
  cancelled; per-item amounts make invoices and payouts exact.
- **Trip-level payment status only:** cannot represent a prepaid bus with a pay-at-property
  homestay in the same trip.

## Consequences

- Booking, payment and finance services operate on generic items; vertical-specific behaviour
  (validation, search filters, display) plugs in per listing type.
- Application code must keep `booking_items.provider_id` equal to the listing's provider, trip
  totals equal to the item sums, and reviews limited to completed items. These cross-row rules are
  enforced in services and covered by tests (not by triggers).
- Amounts are 32-bit integers: up to about Rs 2.1 crore per field, which is ample for one item or trip.
- Adding a status value to a lifecycle enum (e.g. a new payment state) still needs a small enum
  migration; that is a deliberate review point, not a core-table change.
- See [data-model.md](../data-model.md) for the entity reference and the "adding a vertical" guide.
