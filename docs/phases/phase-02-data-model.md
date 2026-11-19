# Phase 02: Multi-vertical Data Model

- **Status:** Awaiting review
- **Branch:** `phase/02-data-model`
- **Date completed:** 2026-11-19

## Scope (as approved)

Documentation for the multi-vertical vision, then a generic, future-proof schema with
migrations, a separate test database and tests. **No product features**: no endpoints beyond
health checks, no UI, no booking/search/payment/review/notification flows.

Owner decisions (2026-11-19, "all recommendations"): commission on the item subtotal
(taxes excluded), deducted from the provider share, per item with a stored trip total; hybrid
detail tables + JSON; currency code with NPR default, one currency per trip; minimal User now;
buses and guides/tours in the MVP, flights modelled not built; separate Neon `test` branch that
tests wipe.

## What was built

- **Docs:** requirements rewritten around trips; ADR 0004; `architecture/data-model.md`
  (entities, money formulas, adding a vertical, future extensions); overview, roadmap,
  CLAUDE.md, setup guide, security note.
- **Schema (25 tables, 22 enums):** users; locations; provider_types, providers,
  provider_documents, provider_payout_accounts; listing_types, listings and six detail tables;
  inventory_slots; cancellation_policies; trips, booking_items, booking_item_slots;
  payments, payment_allocations, payouts, provider_invoices; reviews; notifications.
- **Migration** `20261119090000_multi_vertical_data_model`: generated DDL + 67 CHECK
  constraints + reference rows for provider and listing types.
- **Domain rules** (`src/domain/`): basis-point money maths, commission resolution, item charges,
  trip totals; booking-item, payment and commission status transitions.
- **Test database harness**, integration tests, and a sample seed.

## Important technical decisions

See [ADR 0004](../architecture/decisions/0004-multi-vertical-data-model.md). Highlights:
- Verticals are **lookup rows** (`listing_types`), so a new vertical is an `INSERT`.
- **Per-date lines** (`booking_item_slots`) hold unit prices, because nightly prices differ and
  inventory must be released on cancellation. The item's "unit price" therefore lives on its lines.
- The **database re-checks every money formula**; TypeScript and PostgreSQL rounding are proven
  identical in tests.
- The test runner resets the test database with `DROP SCHEMA` + `migrate deploy`. Prisma 7 blocks
  `migrate reset` when run by an AI agent unless the user consents; that guard was not bypassed.

## Verification (real results)

| Check | Result |
|---|---|
| Migration on a clean PostgreSQL 17 | Applied; `migrate diff --exit-code` = 0 (no drift) |
| Migration on dev Neon (PostgreSQL 18) | `migrate deploy` applied; status "up to date"; drift check 0 |
| `npm run lint` / `typecheck` / `format:check` | Pass |
| `npm test` | API 67/67 (incl. 31 money/status + 4 guard tests), web 16/16 |
| `npm run test:integration` | 34/34 on a throwaway PostgreSQL 17 (same image as CI) |
| `npm run build` | Pass |
| Guard with real settings | Dev pooled and direct URLs as `TEST_DATABASE_URL` both refused; missing URL fails loudly |

Commission maths verified:
- Bus 2 × Rs 1,800 → subtotal Rs 3,600, commission Rs 540, payout Rs 3,060.
- Homestay Rs 3,500 + Rs 4,200 → +10% SC Rs 770 → +13% VAT Rs 1,101.10 → total Rs 9,571.10;
  commission 15% of Rs 7,700 = Rs 1,155 (taxes excluded).
- Trip total commission = Rs 540 + Rs 1,155; stored trip totals equal item sums (SQL check).
- Half-up rounding identical in TypeScript and PostgreSQL on 2,000 amount × rate pairs.

## Commits

| Hash | Message |
|---|---|
| `5140263` | docs: define multi-vertical trip model and data architecture |
| `07347d5` | feat(db): add generic listing/trip/booking-item schema with per-item commission |
| `05d1e31` | test(db): add test database, schema, constraint, commission and seed tests |
| (this commit) | docs: document test database setup and add Phase 2 report |

## Security checklist

- [x] No real credentials in any commit (staged diffs scanned for URLs, Neon hosts and tokens)
- [x] `apps/api/.env.test` ignored; `.env.test.example` has placeholders only
- [x] Tests can never reach the dev database (separate variable, no dev `.env` loading, identity guard)
- [x] Sensitive columns (bank account numbers, PAN) documented in the security guidelines

## Known limitations / follow-ups

1. **Neon `test` branch not created yet.** Integration tests were run on a throwaway PostgreSQL 17
   (as CI does). Create the branch and `apps/api/.env.test` to run them against Neon.
2. Cross-row rules are enforced in application code, not the database: item `provider_id` equals
   the listing's provider; trip totals equal item sums; reviews only for completed items;
   bookable/active listing types. Covered by tests; services in later phases must use the
   domain helpers.
3. Amount columns are 32-bit integers (max ≈ Rs 2.1 crore per field).
4. Decide on application-level encryption for payout account numbers before launch.
5. Seed cancellation policies are **samples**; real presets are a business decision (requirements §6.1).
6. VAT/service-charge formula (10% SC, then 13% VAT on subtotal + SC) to be confirmed with a tax advisor.
7. `npm audit`: the dev-only picomatch advisory from Phase 1 is unchanged.

## How to review

1. Read [data-model.md](../architecture/data-model.md) and ADR 0004.
2. Inspect `apps/api/prisma/schema.prisma` and the hand-written end of the migration SQL.
3. Create the Neon `test` branch → `apps/api/.env.test`, then `npm run test:integration`.
4. Optional: `npm run db:seed` to load sample data into dev and browse it with `npx prisma studio`.
