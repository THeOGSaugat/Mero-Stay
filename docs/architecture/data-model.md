# Data Model Reference

Source of truth: [`apps/api/prisma/schema.prisma`](../../apps/api/prisma/schema.prisma) and the
migrations in `apps/api/prisma/migrations/`. Design rationale: [ADR 0004](decisions/0004-multi-vertical-data-model.md).

## Conventions

| Rule | Detail |
|---|---|
| Names | Prisma models `PascalCase` singular; tables and columns `snake_case` (tables plural) |
| IDs | UUID primary keys (lookup tables use a text `code`) |
| Money | `*_minor` **BIGINT (64-bit)** columns in minor units (paisa for NPR) + `currency CHAR(3)`. Max 9.2 × 10^18 paisa. In TypeScript they are `bigint` (use `src/domain/money.ts`; never `number`). `bigint` does not serialise to JSON, so convert at the API boundary |
| Rates | `*_rate_bps` integers in basis points: 1500 = 15%, 10000 = 100% |
| Rounding | x% of an amount = round half-up to the nearest minor unit (`src/domain/money.ts`) |
| Time | `timestamptz` (UTC) for moments; `DATE` for service dates; local times as `"HH:MM"` text |
| Integrity | CHECK constraints in the migration SQL re-verify every money formula and range |
| Deletes | Restrict by default (financial records are never cascaded away); detail tables cascade with their listing |

## Entities

### Who

| Table | Purpose | Key fields |
|---|---|---|
| `users` | Customers, partners, admins (shape only; auth later) | `email` / `phone` (at least one), `full_name`, `role` |
| `provider_types` | Lookup: hotel, bus_operator, airline, guide, tour_operator, activity_operator | `code` PK |
| `providers` | A business or person supplying items | `provider_type_code`, `owner_user_id`, `status`, PAN/VAT/registration numbers, `commission_rate_bps` override, `integration_type`, `external_ref` |
| `provider_documents` | Verification files (private) | `document_type`, `storage_key`, `status`, reviewer |
| `provider_payout_accounts` | Bank accounts for payouts | bank, account name/number, `is_default` |
| `locations` | Province → District → Municipality/Area → Point of interest | `parent_id`, `kind`, `slug` |

### What is sold

| Table | Purpose | Key fields |
|---|---|---|
| `listing_types` | Lookup: one row per vertical | `code` PK, `unit_label`, `is_bookable`, `is_active` |
| `listings` | Anything sellable | `provider_id`, `listing_type_code`, `parent_id`, `location_id`, `status`, `currency`, `base_price_minor`, service-charge/tax/commission rates, `default_cancellation_policy_id`, `attributes` JSON, `external_id`, `last_synced_at` |
| `hotel_details` | Property-level data for a `hotel` listing | accommodation kind, stars, check-in/out times |
| `hotel_room_details` | A bookable `hotel_room` | max adults/children, beds, size |
| `bus_route_details` | A scheduled `bus_ticket` service | origin/destination locations, departure time, duration, bus type, seats |
| `guide_service_details` | A `guide_service` | languages, regions, licence, group size |
| `tour_details` | A `tour` / trek | days, difficulty, start location, max altitude, group size |
| `flight_route_details` | A `flight_ticket` (modelled, not built) | airline, flight number, airports, times, cabin |
| `inventory_slots` | Availability per listing per date | `service_date` (unique per listing), `capacity_total`, `capacity_booked` (≤ total), `price_override_minor` |
| `cancellation_policies` | Refund tiers, per provider or platform template | `rules` JSON array `[{minHoursBeforeStart, refundBps}]` |

Listing types in the MVP:

| `listing_types.code` | Unit | Bookable | Active | Detail table |
|---|---|---|---|---|
| `hotel` | property | no (container) | yes | `hotel_details` |
| `hotel_room` | night | yes | yes | `hotel_room_details` |
| `bus_ticket` | seat | yes | yes | `bus_route_details` |
| `guide_service` | day | yes | yes | `guide_service_details` |
| `tour` | person | yes | yes | `tour_details` |
| `activity` | person | yes | yes | none (`attributes` JSON) |
| `flight_ticket` | seat | yes | **no** | `flight_route_details` |

### Orders and money

| Table | Purpose | Key fields |
|---|---|---|
| `trips` | One customer order | `reference`, `customer_id`, `status`, `currency`, stored totals: subtotal, service charge, tax, total, `commission_total_minor` |
| `booking_items` | One line of a trip | `listing_id`, `provider_id`, `listing_type_code`, `status`, dates, `quantity`, money snapshot (below), `payment_status`, `commission_status`, `payout_status`, `cancellation_policy_id` + snapshot, `attributes`, `external_booking_ref` |
| `booking_item_slots` | Per-date lines of an item | `inventory_slot_id`, `service_date`, `units`, `unit_price_minor`, `amount_minor` |
| `payments` | A gateway charge (intent → succeeded/failed/cancelled) or refund (ADR 0007) | `gateway` (text), `kind`, `status`, `amount_minor` (requested), `captured_minor`, `intent_fingerprint`, `gateway_transaction_id` (unique per gateway); at most one open charge per trip |
| `payment_allocations` | How a succeeded payment splits across items (ADR 0007) | `payment_id`, `booking_item_id`, `amount_minor`; immutable; Σ ≤ captured and Σ per item ≤ item total (triggers) |
| `payouts` | Transfer to a provider for online-paid items (shape) | provider, period, amount, status |
| `provider_invoices` | Commission owed for pay-at-property items, one per trip and provider (ADR 0007) | number, provider, `trip_id`, amount = Σ linked items' commission (checked at issue), status DRAFT → ISSUED → PAID / VOID |
| `reviews` | One review per completed booking item (shape) | `booking_item_id` (unique), `rating` 1–5, provider reply |
| `notifications` | SMS/email records (shape) | `channel`, `provider` (text), recipient, template, status |

### Booking item money (all enforced by CHECK constraints)

```
subtotal          = Σ booking_item_slots.amount_minor        (each = units × unit_price)
service_charge    = round(subtotal × service_charge_rate_bps / 10000)
tax (VAT)         = round((subtotal + service_charge) × tax_rate_bps / 10000)
total             = subtotal + service_charge + tax           ← what the customer pays
commission        = round(subtotal × commission_rate_bps / 10000)   ← taxes excluded
provider_payout   = total − commission

trip.total_minor            = Σ item.total_minor
trip.commission_total_minor = Σ item.commission_minor
```

Per-item statuses:

| Field | Values | Rule (see `src/domain/booking-item-status.ts`) |
|---|---|---|
| `status` | PENDING → CONFIRMED → IN_PROGRESS → COMPLETED; CANCELLED, NO_SHOW, EXPIRED | Final states are final |
| `payment_status` | UNPAID → PARTIALLY_PAID → PAID (online, by allocations) or PAY_AT_PROPERTY → PAID_AT_PROPERTY; PAID → (PARTIALLY_)REFUNDED | Pay-at-property cannot be refunded through MeroStay; a trigger keeps online statuses equal to the allocations (ADR 0007) |
| `commission_status` | PENDING → PAID (online: deducted from payout) / PENDING → INVOICED → PAID (pay at property); WAIVED | Invoicing only for pay-at-property |
| `payout_status` | PENDING, ON_HOLD, PAID; NOT_APPLICABLE for pay-at-property | |

## Relationships

```
users 1──* providers 1──* listings *──1 listing_types
                     │          │ 1──0..1 <type>_details
                     │          │ 1──* inventory_slots 1──* booking_item_slots
                     │          └ *──0..1 listings (parent: hotel → rooms)
                     ├──* provider_documents, provider_payout_accounts, cancellation_policies
                     └──* payouts, provider_invoices

users 1──* trips 1──* booking_items *──1 listings
                 │          │ 1──* booking_item_slots
                 │          │ 1──* payment_allocations *──1 payments *──1 trips
                 │          │ *──0..1 payouts, provider_invoices, cancellation_policies
                 │          └ 1──0..1 reviews
                 └──* notifications
```

## Adding a new vertical

Example: **trekking permits** (TIMS / ACAP), sold per person.

1. **Migration with one INSERT** (no core table changes):
   ```sql
   INSERT INTO listing_types (code, name, unit_label, is_bookable, is_active)
   VALUES ('permit', 'Trekking permit', 'person', TRUE, TRUE);
   ```
2. **Fields:** if search doesn't need to filter on them, store them in `listings.attributes`
   (e.g. `{ "permitKind": "ACAP", "issuingOffice": "Pokhara" }`) and validate with a Zod schema
   per listing type. If search does need them, add a `permit_details` table keyed by `listing_id`
   (new table, 1:1), exactly like `bus_route_details`.
3. **Inventory:** use `inventory_slots` if quantity is limited per date; otherwise items have no
   slot (`booking_item_slots.inventory_slot_id` is nullable).
4. **Provider type** (if new kind of supplier): `INSERT INTO provider_types ...`.
5. **Code:** register the type's validation/display in the listings module. Trips, booking items,
   payments, commission, payouts, reviews and notifications work unchanged.

## How other future extensions fit

| Extension | What changes | What does NOT change |
|---|---|---|
| Flights (build them) | Set `listing_types.is_active = true` for `flight_ticket`; build flows using `flight_route_details`; integration via the next row | Core tables |
| Partner integrations (airline, bus, channel manager) | Set `providers.integration_type = API`; sync jobs fill `listings.external_id`, `last_synced_at`, `booking_items.external_booking_ref`; optional new `integration_sync_runs` log table | Core tables |
| Payment gateways (eSewa, Khalti, Fonepay, cards) | New `payments.gateway` text value + gateway adapter code | Schema |
| Refunds | `payments` row with `kind = REFUND` + allocations; item `refunded_minor` and `payment_status` | Schema |
| Payouts / invoices | Fill `payouts` / `provider_invoices`; link items via `payout_id` / `commission_invoice_id` | Schema |
| Reviews | Review service enforces "completed item only, one per item" on the existing table | Schema |
| Notifications | `NotificationService` writes `notifications` rows; new provider = new `provider` text value | Schema |
| Multi-currency trips | Currency already on listings, items and trips; relax the one-currency rule in `summarizeTrip` and add FX rate columns to items | Existing columns |
| Per-provider / per-listing commission | Already supported: `providers.commission_rate_bps`, `listings.commission_rate_bps`; future rule tables can feed the same resolver | Booking items (rate is stored per item) |
| Bus seat selection | Seat numbers in `booking_items.attributes` today; a `seat_assignments` table later if seat maps are built | Core tables |
| Packages | Either a `package` listing type, or a trip template that creates several items | Core tables |

## Working with migrations

- Apply to a database: `npm run db:migrate` (`prisma migrate deploy`, uses the **direct** URL).
- Status: `npm run db:migrate:status`.
- Create a new migration (run from `apps/api/`):
  1. `npm run test:integration` so the **test** database has every existing migration applied.
  2. Edit `prisma/schema.prisma`.
  3. Generate the SQL by diffing the test database against the edited schema:
     ```bash
     MEROSTAY_SKIP_ENV_FILE=1 DATABASE_URL="<your TEST_DATABASE_URL>" \
       npx prisma migrate diff --from-config-datasource --to-schema=prisma/schema.prisma --script \
       > prisma/migrations/<YYYYMMDDHHMMSS>_<name>/migration.sql
     ```
  4. Add any CHECK constraints or reference rows by hand at the end of that file.
  5. `npm run test:integration` again: it re-applies all migrations to a clean test database and
     fails if the result differs from `schema.prisma` (drift test).
  6. After review, apply to dev with `npm run db:migrate`.
