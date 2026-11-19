# Phase 03: Search & Booking API

- **Status:** Awaiting review
- **Branch:** `phase/03-search-booking-api`
- **Date completed:** 2026-11-19

## Scope (as approved)

Backend API only: vertical-agnostic search and a trip/booking-item API with quote and confirm, on
the Phase 2 schema. **Not built:** authentication, payment gateway, refunds, payout execution,
review submission, notification sending, dashboards, UI.

The roadmap had authentication as Phase 3; the owner's Phase 3 brief put search and booking first.
The roadmap was renumbered (authentication is now Phase 4).

## What was built

- **Endpoints** (`/api/v1`, details in [api.md](../architecture/api.md)): `GET /listing-types`,
  `GET /listings`, `GET /listings/:id`, `POST /trips`, `GET /trips/:id`, `POST /trips/:id/items`,
  `PATCH|DELETE /trips/:id/items/:itemId`, `POST /trips/:id/quote`, `POST /trips/:id/confirm`.
  Health endpoints unchanged.
- **Layers** per CLAUDE.md: routes → controllers (Zod) → services (rules) → repositories (Prisma).
- **Pricing** (`trip-pricing.ts`) reuses the Phase 2 helpers; no new money arithmetic.
- **Money boundary:** explicit serializers emit every `*Minor` as a digit string with `currency` and
  `currencyExponent` ([ADR 0005](../architecture/decisions/0005-search-and-booking-api-conventions.md)).
- **Inventory holds** at add-item time via atomic increments guarded by the overbooking CHECK;
  every trip write is one transaction holding a row lock on the trip.
- **Central DB-error mapping** (`lib/database-errors.ts`): overbooking → 409, money CHECKs → 422,
  unique → 409; raw PostgreSQL text never returned.
- **Hold-expiry sweeper** (`expireStaleTrips`): set-based, not yet scheduled.
- **Temporary unauthenticated trip API**: `userId` in the body; disabled by default in production
  (`ALLOW_UNAUTHENTICATED_TRIPS_API`).

**No schema changes, no new migration.** Payment method maps onto the existing `payment_status`.

## Important technical decisions

See ADR 0005. Highlights: money as digit strings (no global BigInt patch); holds at add time;
prices frozen at add time and not re-priced at confirm; quote is a pure dry run; pay-at-property
items confirm with commission `INVOICED`, online items stay `PENDING`/`UNPAID` until payment.

## Verification (real results)

| Check | Result |
|---|---|
| `npm run lint` / `typecheck` / `format:check` / `build` | Pass |
| Unit tests (`npm test`) | API 122/122 (10 files), web 16/16 |
| Integration on throwaway PostgreSQL 17 | 93/93 (6 files) |
| **Integration on the Neon `test` branch** | **93/93 (6 files), 418.75 s** |
| Mutation check (deliberate bugs) | Skipping holds → 11 failures; one money field as a number → caught; pay-at-property counted as online → caught |
| Phase 2 regression | Migrations apply cleanly with zero drift; seed and constraint tests pass |

What the integration tests prove (on Neon):
- Hotel (2 nights, pay at property) + bus (2 seats, online) + guide (3 days, online) in one trip:
  per-item SC/VAT/commission (e.g. homestay subtotal "770000", VAT "110110", commission "115500"),
  trip totals = item sums ("2217110" total, "304500" commission), split by payment method.
- Quote totals equal the stored totals; candidate items are priced without writing anything.
- Confirm: pay-at-property → `CONFIRMED` + `INVOICED`; online → `PENDING`/`UNPAID`; snapshots unchanged.
- Overbooking → 409 `INSUFFICIENT_AVAILABILITY`, all-or-nothing for multi-night stays; two
  simultaneous requests for the last unit → exactly one 201 and one 409.
- Currency mismatch → 422 (add-item and quote); inactive (flight), draft, container and
  unverified-provider listings → 422; closed/missing dates → 409.
- PATCH re-prices and re-reserves; an impossible change leaves the item exactly as it was.
- After all writes: CHECK formulas re-evaluated in SQL; trip totals = item sums; inventory held =
  units of active items; every money field in 30+ responses is a digit string with its currency.
- Expiry: expired drafts → 409; the sweeper releases holds; a mixed trip keeps its confirmed hotel.

## Findings during testing (fixed)

1. **Sweeper too slow on Neon.** The first Neon run failed one test (timeout at 30 s): the
   sweeper looped one transaction per trip, about 4 s per trip over Neon's latency. Rewritten as
   one transaction with four set-based statements per batch; the full suite then passed on Neon.
2. **Fixture phone collision** when several test suites shared one database; fixed with a unique
   phone per test world.

## Security checklist

- [x] No real credentials committed (staged diffs scanned for Neon hosts, passwords, tokens)
- [x] Unauthenticated trip endpoints disabled by default in production
- [x] Raw database errors (which contain the failing row) never reach clients
- [x] Strict Zod validation rejects unknown fields; clients never send money

## Known limitations / follow-ups

1. **No authentication yet**: anyone with a trip id can read or change it (dev/test only;
   off in production). Phase 4 replaces `userId` with the session and hides commission/payout
   fields from customers ([api.md](../architecture/api.md#how-authentication-will-slot-in)).
2. **Hold sweeper not scheduled**: abandoned drafts keep their holds until `expireStaleTrips` runs.
   Schedule it with the payments phase (or earlier if needed).
3. **`INVOICED` without an invoice row**: at confirm, pay-at-property commission is set to
   `INVOICED` as the brief asked; the `provider_invoices` row is created in the finance phase.
4. **Search filters are generic only** (type, location subtree, dates, price, currency). Vertical
   filters such as bus destination can be added later as optional query parameters.
5. Neon integration runs take about 7 minutes (network latency); CI uses a local PostgreSQL service.
6. `pg` SSL-mode warning in test output (harmless; `sslmode=verify-full` silences it).
7. `npm audit`: the dev-only picomatch advisory from Phase 1 is unchanged.

## How to review

1. Read [api.md](../architecture/api.md) and ADR 0005.
2. `npm run dev`, then try `GET http://localhost:4000/api/v1/listing-types` and
   `GET /api/v1/listings?location=shree-antu` (after `npm run db:seed`).
3. `npm run test:integration` against your Neon `test` branch.
