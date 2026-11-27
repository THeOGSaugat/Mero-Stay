# Phase 14: Cancellations & refunds

- **Status:** Awaiting review
- **Branch:** `phase/14-cancellations-refunds`
- **Date completed:** 2026-11-27

## Scope (as approved)

Owner's Phase 14 brief:

- **Gap 31:** execute refunds. Khalti through its refund API, eSewa by hand (documented).
  Idempotent, partial refunds allowed, never above what was paid, audited.
- **The refund clock:** the actual service start time, Nepal time, stored as a field so the clock
  is exact.
- **Gap 36:** reconcile pay-at-property settlements (view, flag, resolve with audit; no money
  moves).
- **Gap 39:** void a paid-out booking → refund request + a clawback against future payouts.
- Backend, admin UI, tests, docs.

**Not built:** automated payout APIs, new gateways, reviews, notifications, OAuth, 2FA, email
verification or reset. Phase 15 has not been started.

**First, a docs bookkeeping commit on `main`** (`cb4ee9a`, CI green, run 46027279947):

- Phase 13 marked merged and tagged `v0.13.0`;
- the refund clock rule recorded.

**Owner decisions (asked at the start, 2026-11-27):**

| Question | Answer |
|---|---|
| Guides, tours and activities have no start time | **Partners set one** (required for new and edited details); items without one fall back to 00:00 Nepal time of the start date, labelled |
| Commission on a partial refund | **On the part kept** (15% of the kept share of the subtotal); full refund → waived |
| Recovering a clawback | **Deducted from the next payouts**, never below zero; the rest carries forward |
| No policy / non-refundable | **The customer may cancel, refund 0** (shown before confirming); gap 30 stays open |

**Defaults I chose and stated:**

- **Phase number:** "Do not start Phase 15" makes this Phase 14, so Search UX moves to 15.
- **Pay-at-property cancellation:** nothing was paid through MeroStay, so the commission is waived
  (nothing kept, per the decision above).

## What was built

ADR: [0020](../architecture/decisions/0020-cancellations-refunds-and-clock.md).

### The refund clock

- **New columns:**
  - `booking_items.service_starts_at` (UTC) and `service_start_source` (`LISTING_TIME` or
    `DEFAULT_MIDNIGHT`), frozen when an item is added or its dates change;
  - `start_time` on guide and tour details, and a new `activity_details` table.
- **Where the time comes from** (no listing-type code):
  - a stay: its check-in (a room uses its parent hotel's);
  - a bus: its departure;
  - a guide, tour or activity: its start time.
- **Database CHECKs:**
  - the Nepal date of the start equals the start date;
  - a midnight fallback is exactly 00:00 Nepal time.
- **Migration backfill:** existing items are filled by detail rows. Checked on a database seeded by
  the `v0.13.0` code:

  | Item | Start (Nepal time) | Source |
  |---|---|---|
  | Room | 13:00 (the parent homestay's check-in) | `LISTING_TIME` |
  | Bus | 06:30 | `LISTING_TIME` |
  | Guide | 00:00 | `DEFAULT_MIDNIGHT` |

- **Tiers:** exact instants, never rounded. Exactly 72 h meets "72 h"; one millisecond less does
  not.

### Customer cancellations

- `GET /trips/:id/items/:itemId/cancellation` (preview) and `POST …/cancel
  {expectedRefundMinor}`. The cancel goes through only if the refund still equals what was shown
  (else `409 CANCELLATION_TERMS_CHANGED`).
- Frozen on the item and re-computed by CHECKs: the tier, refund = total × tier, and the commission
  on the part kept.
- **Effects:**
  - inventory released;
  - refund requests created;
  - pay-at-property commission waived (with an invoice adjustment when invoiced);
  - trip totals and status recomputed;
  - audited, with the customer as actor.
- Owner-scoped (another customer's trip is a 404). No commission in any customer response.

### Refund execution (gap 31)

- **State machine:** REQUESTED → APPROVED → PROCESSING → COMPLETED | FAILED (retry) or REJECTED
  (with a note). Enforced by the service and by a replaced database guard: transitions, immutable
  money fields, final states, no deletes.
- **Adapters:**
  - **Khalti:** `refund` / `checkRefund` behind `PaymentGatewayAdapter`. No body for a full refund,
    `{amount}` in paisa for a partial one. An unknown outcome is settled from the lookup.
  - **eSewa:** no refund API. MANUAL, with a note; the admin refunds in the portal and records the
    reference.
  - **Simulated:** dev and test only.
- **Idempotency:**
  - PROCESSING is committed before the gateway call, so a refund is never sent twice;
  - a partial unique index allows one PROCESSING refund per payment;
  - repeats return `changed: false`.
- **Limits:** refunds never exceed what was paid (API and database). The item's `refunded_minor`
  equals its completed refunds (deferred database check); payment status goes PAID →
  PARTIALLY_REFUNDED → REFUNDED.
- **Money already with the provider:** refused while the item is in a scheduled payout, and for a
  paid-out item without a clawback.
- **No `REFUND` rows in `payments`.** A completed refund request is the record (reasons in ADR
  0020).

### Payouts and clawbacks (gap 39)

- **Kept money is paid out:** customer-cancelled items are payable for what was kept, once the
  refund is completed. Batch lines use `total − refunded` and the kept commission. The SQL, the
  domain function and both replaced payout guards apply the same rule.
- **Voiding a paid-out item:**
  - a full refund request for the customer;
  - the deducted commission waived (only on this path);
  - an append-only clawback of the item's line in its PAID batch;
  - the paid batch itself never changes.
- **Recovery:** scheduling a batch deducts outstanding clawbacks, oldest first, never below zero
  (`deductions_minor`; net = gross − commission − deductions, CHECK). A failed transfer gives the
  deduction back.
- **Views:** `GET /admin/clawbacks` and `GET /partner/clawbacks` (own only).

### Settlement reconciliation (gap 36)

- **Mismatches** are computed (domain and SQL):
  - invoiced, service over, never recorded paid;
  - recorded paid without invoiced commission;
  - recorded paid before the service started.
- `GET /admin/settlement-reconciliation`, and `POST …/:itemId/resolve {kind, note}`: once per item
  and kind, append-only, audited. No money moves.

### Web

- **Trip page:** each booking's start time, and "Cancel this booking…" with the exact refund before
  confirming.
- **Admin:**
  - the refund queue with status filters and the actions valid for each state and gateway;
  - a Settlements page;
  - clawbacks and batch deductions on Payouts.
- **Partner:**
  - start-time fields for guides, tours and activities;
  - deductions and clawbacks on Payouts.
- Money is only formatted from the API's strings.

## Important technical decisions

- **One migration** (`20261127090000_cancellations_refunds_clawbacks`). The Phase 11 refund guard
  and the Phase 12 payout guards are replaced with `CREATE OR REPLACE`; applied migrations are
  untouched. The diff of the migrations against `schema.prisma` is empty.
- **`refunded_minor` is checked at commit** (constraint triggers, `DEFERRABLE INITIALLY DEFERRED`),
  so the refund row and the item can be written in either order within one transaction.
- **Paid commission → WAIVED only for paid-out voids** (`canWaivePaidOutCommission`). The general
  transition table still treats PAID as final.
- **Khalti's documented unit contradiction** (paisa in the text, `50.00` in the example): we send
  paisa. A launch-checklist item asks for one sandbox partial and one full refund before going
  live.
- **The ADR 0013 guard stayed unchanged.** The start-time lookup uses detail rows; listing-type
  codes appear only in `listing-details.ts` / `listing-forms.ts`.

## Files created / changed

**API**

- **Migration and schema:** `prisma/migrations/20261127090000_cancellations_refunds_clawbacks/`,
  `schema.prisma`.
- **Domain (pure, unit-tested):** `domain/refunds.ts`, `clawbacks.ts`,
  `settlement-reconciliation.ts`, `payouts.ts`, `booking-void.ts`, `booking-item-status.ts`.
- **Gateways:** `lib/payment-gateways/{types,khalti,esewa,index}.ts`, `testing/fake-gateways.ts`
  (Khalti refund route, refund modes).
- **Services:**
  - `modules/cancellations/` (new);
  - `modules/refunds/` (execution);
  - `modules/payouts/` (payable lines, deductions, clawbacks);
  - `modules/moderation/` (paid-out voids);
  - `modules/finance/settlement-reconciliation.service.ts` and `invoice-adjustments.ts` (new);
  - `modules/trips/` (start freeze, routes, serializers, `trip-settlement.ts`);
  - `modules/listings/` (start times, `activityDetail`);
  - `lib/database-errors.ts`, `app.ts`, admin and partner routes.
- **Tests and fixtures:**
  - `domain/refunds.test.ts`, `modules/refunds/refund-execution.integration.test.ts` (new);
  - fixtures and seed with the service start;
  - E2E world (Phase 14 room and logins).

**Web**

- **Display logic:** `lib/refunds-display.ts`; types in `api-types.ts` and `admin-ops.ts`;
  start-time fields in `listing-forms.ts`.
- **Components:**
  - `components/trip/cancel-item.tsx`, `trip-view.tsx`, `trip-history.tsx`;
  - admin `settlements-view.tsx`, `clawbacks-view.tsx`, `admin-clawbacks.tsx`, the refund queue,
    payouts and navigation;
  - partner payouts.
- **Pages:** `app/admin/settlements/page.tsx`.
- **Tests:** `lib/phase14-logic.test.ts` (new); `e2e/refunds.spec.ts` (new).

**Docs:** ADR 0020, `api.md`, `data-model.md`, `frontend.md`, `requirements.md`, `operational-gaps.md`,
`roadmap.md`, `CLAUDE.md`, `README.md`, `.env.example`, this report.

## Verification (real command output)

| Check | Result |
|---|---|
| `format:check`, `lint`, `typecheck` (API, web, e2e) | Pass |
| API unit | **373/373** (343 + 30 new: clock, tiers, amounts, state machine, deductions, eligibility, mismatches) |
| Web unit | **118/118** (107 + 11 new) |
| API integration (disposable PostgreSQL 17) | **317/317**, 21 files (293 regression + 24 new) |
| E2E (booking mode, disposable database) | **46/46** (40 + 6 new: 3 journeys × desktop and mobile) |
| Migration backfill on `v0.13.0` seed data | Room 13:00 (parent check-in), bus 06:30, guide 00:00 `DEFAULT_MIDNIGHT` |
| `npm audit` | 0 vulnerabilities |
| Commit 1 on its own (separate worktree: `npm ci`, format, lint, typecheck, unit, integration and E2E on disposable databases) | All pass: API unit 373/373, web unit 107/107, integration 317/317, E2E 40/40 (the new journeys come with commit 2). A first version failed typecheck and E2E seeding because the E2E fixture's service start was left out of it; I rebuilt both local commits **before pushing** (no published history changed) |
| CI | Green on `a0465e8` (run 46035709743, both jobs). The commit recording the Neon result is checked by its own run |
| **Neon integration run** (test branch, committed code `a0465e8`) | **317/317**, 21 files, on the third attempt (the first two failed on credentials). See below |

**Neon end-of-phase run, every attempt:**

| Attempt | Started (UTC) | Code | Result |
|---|---|---|---|
| 1 | 2026-11-27 16:34:40 | Phase 14 working tree, before the commits | Failed in global setup, no test ran: `28P01 password authentication failed for user 'neondb_owner'` |
| 2 | 2026-11-27 16:35:30 | The same | The same `28P01` |
| 3 | 2026-11-27 17:40:48 (ended 18:55:38) | `a0465e8`, clean tree before and after | **Passed: 317/317 tests, 21/21 files**, exit 0, 4488.84 s (about 75 minutes) |

- **Attempts 1 and 2 were a credential issue, not a code issue:** Neon refused the login before
  any test ran. The owner then put the test branch's current connection strings into
  `apps/api/.env.test` and confirmed it is the test branch. No code changed to make attempt 3 pass.
- **Endpoints:** attempts 1 and 2 used `ep-dawn-mountain…`; attempt 3 used `ep-rapid-glade…`. Both
  differ from dev (`ep-muddy-sunset…`). An earlier version of this report called `ep-dawn-mountain…`
  the test branch endpoint; I had only checked that it was not dev.
- **Guard, re-checked before attempt 3:** the pooled and direct URLs name the same endpoint, it
  differs from dev, and no database URL was set in the shell.
- **Conditions for attempt 3:** `caffeinate -i npm run test:integration`; no retries inside the
  run, no changed timeouts, no skipped tests. It took longer than the 40–50 minutes expected.

**Tests that changed because behaviour changed on purpose** (each by the owner's decisions or the
brief):

- `booking-void.test.ts`: a paid-out item can now be voided (with a clawback); the plan has a new
  `clawback` field.
- `payouts.test.ts`: `sumPayout` returns `deductionsMinor`.
- `partner.unit.test.ts`, `partner-logic.test.ts`, `partner-admin` and `listing-rules` integration
  tests: activities have a detail row with a start time, and guides need one. The "no detail table"
  case now uses a type without a table.
- `payment-gateways.integration.test.ts`: the database no longer refuses execution; it refuses
  skipping states (`refund_requests_transition_chk`).
- `moderation.integration.test.ts`: void results carry `clawbackMinor` with its currency. The
  money-boundary check caught it missing, and the API was fixed.
- `schema` / `constraints` integration tests: inventories of the new tables and five new BIGINT
  money columns.

## Commits

| Hash | Message | Content |
|---|---|---|
| `cb4ee9a` (on `main`) | `docs: mark Phase 13 tagged and record refund clock rule` | Bookkeeping before the phase (CI green) |
| `48582d2` | `feat(api): cancellations, refund execution, the refund clock and clawbacks` | Migration, schema, domain rules, gateway adapters (Khalti refund, fake), services and routes, error mapping, unit and integration tests, fixtures (45 files) |
| `9d7553e` | `feat(web): cancel bookings, execute refunds, settlements and clawbacks` | Trip cancellation, refund queue actions, settlements, clawbacks and deductions, start-time fields, web unit tests, E2E journeys and their world (22 files) |
| `a0465e8` | `docs: record Phase 14 cancellations, refunds, ADR 0020 and closed gaps` | ADR 0020, API/data-model/frontend docs, requirements, gaps (31, 36, 39 closed; 40, 41 added), roadmap, CLAUDE.md, README, `.env.example`, this report |
| (this commit) | `docs: record Phase 14 Neon verification` | The Neon result and every attempt, in this report and ADR 0020 |

## Security and constraints checklist

- **Money:**
  - digit strings at the boundary, `bigint` inside;
  - every new money field has its currency (money-boundary check, all new and old suites);
  - the UI only formats.
- **Database invariants:**
  - refunds ≤ paid;
  - refunded = completed refunds;
  - transitions and final states;
  - cancellation amounts and kept commission (CHECKs);
  - payout sums with deductions;
  - append-only clawbacks, recoveries and resolutions.
- **Idempotency:** state-based on every step; concurrent executes call Khalti once (tested).
- **Auth and scoping:**
  - `/admin…` needs ADMIN; partners see only their own clawbacks;
  - another customer's trip is a 404;
  - customers never see commission.
- **Secrets and masking:** no secrets in responses or audit rows. Gateway refund references are
  returned and audited masked (`••••8899`); the gateway's raw answer is stored, never returned.
- **Isolation:**
  - test databases are disposable or the test branch; nothing touched dev;
  - the E2E world refuses the dev database;
  - the backfill check used a scratch database.
- **Secret scan:** before every commit, the staged diff with the scan script and the CLAUDE.md §2.3 checklist: no real values; keyword hits were field names, comments, the fake gateway's random test key and per-run random test passwords; `.env` and `node_modules` still ignored.

## Known limitations / follow-ups

- **Gap 40 (new):** a clawback is recovered only from later batches; a provider without any keeps
  owing it.
- **Gap 41 (new):**
  - an admin's partial refund on a live item keeps it out of payouts;
  - the Phase 6 "not yet batched" estimate omits the kept part of cancelled items.
- **Gap 30** stays open (owner): whether a listing must have a policy.
- **Launch checklist:** confirm Khalti's refund `amount` unit with sandbox refunds.
- **Not notified:** customers are not told by email or SMS when a refund completes (Notifications,
  Phase 17).
- **eSewa partial refunds** depend on what the merchant portal allows; the admin records whatever
  was refunded, and the queue shows the amount owed.

## How to review

1. Read ADR 0020, then `domain/refunds.ts` (clock, tiers, amounts) and the migration's guards.
2. Run the integration suite on a disposable database:
   `TEST_DATABASE_URL=… npx vitest run --project integration src/modules/refunds` (24 journeys).
3. `E2E_DATABASE_URL=<disposable> npm run test:e2e:booking`, or by hand:
   - book and pay a room 30+ days ahead;
   - on the trip page, Cancel this booking… (100% refund);
   - as an admin, Refund requests → Approve → Refund through test gateway.
