# Phase 05: Payments, Invoices & Hold-Release Job

- **Status:** Awaiting review
- **Branch:** `phase/05-payments-invoices`
- **Date completed:** 2026-11-21

## Scope (as approved)

The payment, invoice and hold-release lifecycle on the existing schema, backend only:

- an online payment flow that doesn't depend on a particular provider, using a simulated gateway
  (no live gateway);
- idempotent payment intents and confirmations;
- per-item allocation with partial payments;
- pay-at-property settlement;
- commission invoices behind `INVOICED`;
- a scheduled hold-release job;
- refunds and payouts as shape and plan only.

**Not built:** UI, live gateway, refund execution, payout execution, reviews, notifications,
partner/admin dashboards, OAuth, 2FA, email verification and password reset.

**Roadmap:** the owner's brief put payments before provider onboarding, so the phases after 4 were
renumbered. Provider onboarding is now suggested as Phase 6, and live eSewa/Khalti is Phase 10.

**First:** the CLAUDE.md §9 docs fix (`a8ba256`, "docs: mark Phase 4 merged and tagged v0.4.0") was
pushed to `main`, and CI was green (run `44918716735`).

## What was built

- **Payment intents** (`POST /trips/:id/payments/intent`). The amount is computed on the server from
  every pending online item (`total − paid`).
  - Idempotent: an unchanged amount due returns the same open intent. The database allows one open
    charge per trip (partial unique index).
- **Confirmation** (`POST /trips/:id/payments/:paymentId/confirm`). It works as a simulated provider
  callback: full capture, partial capture or failure.
  - Idempotent: a payment that already succeeded comes back as `replayed: true` with no change.
  - Allocation fills items in order. An item becomes `PAID`/`CONFIRMED` only when fully covered;
    otherwise it is `PARTIALLY_PAID`. The trip becomes `CONFIRMED` when nothing is pending.
- **Payment list** (`GET /trips/:id/payments`). The trip view gains `money.paidMinor` per item and
  `onlinePayment { paidMinor, dueMinor }`. The quote/trip `totals` shape is unchanged.
- **Commission invoices.** Trip confirm issues one invoice per (trip, provider) for pay-at-property
  items, in the same transaction, and links the items. Commission becomes `INVOICED`.
- **Admin endpoints:**
  - `POST /admin/trips/:id/payments/at-property/settle` (`PAY_AT_PROPERTY → PAID_AT_PROPERTY`);
  - `GET /admin/trips/:id/invoices`.
- **Hold-release job.** `npm run jobs:hold-release` runs once (for cron), and `jobs:hold-release:watch`
  runs as a worker (also started by `npm run dev`). The sweeper:
  - never expires items holding customer money;
  - cancels the open intents of the trips it sweeps.
- **Database guards** (migration `20261121090100_payments_and_invoices`). Triggers and CHECKs
  re-verify every cross-row rule:
  - allocations ≤ captured and ≤ item total;
  - item payment status = allocations;
  - finished payments are immutable;
  - invoice amount = linked commission;
  - `INVOICED` requires an invoice;
  - a paid item is never expired.
- **Config:**
  - `PAYMENT_GATEWAY` (`simulated`; refused in production; unset gives 503);
  - `HOLD_RELEASE_INTERVAL_SECONDS` (default 60).
- **Sample seed:** sample payments are now recorded the way the database requires (capture →
  allocation → `PAID`). The sample pay-at-property stay gets its commission invoice.

## Important technical decisions

The full record is in [ADR 0007](../architecture/decisions/0007-payments-and-invoices.md).

1. **Simulated gateway is explicit opt-in and refused in production.** Without it, payments
   return 503. Faking a successful payment must never be possible in production.
2. **Idempotency is derived on the server.** The intent fingerprint is SHA-256(trip, currency,
   item=due pairs), and a unique index allows one open charge per trip. Confirm replays a
   succeeded payment. No client key is needed: retries, double clicks and two tabs end up on the
   same intent.
3. **New statuses, not a new column.** `PARTIALLY_PAID` and `PAID_AT_PROPERTY` are added to
   `payment_status` in their own migration, because PostgreSQL can't use a new enum value in the
   transaction that adds it. ADR 0005 encodes the method in the status. A settled pay-at-property
   item must not look like online money, because that would suggest a payout.
4. **Settlement is admin-only, via `role = ADMIN` on the session user.** The role is re-read every
   request and checked before any data is read. No API grants it. The customer is the payer and
   can't attest that the provider was paid; partner accounts don't exist yet.
5. **The database enforces the math, independently of the code.** In a mutation test with every
   application-level double-confirm check removed, the database refused 4 of 5 concurrent confirms
   and let exactly one succeed.
6. **The job runner is a script, not a library.** It runs once for cron, or as a `--watch` worker.
   Concurrent runs are safe through `FOR UPDATE SKIP LOCKED`. No Redis or queue dependency.

## Migrations

| Migration | Contents |
|---|---|
| `20261121090000_add_payment_statuses` | `payment_status` += `PARTIALLY_PAID`, `PAID_AT_PROPERTY` |
| `20261121090100_payments_and_invoices` | `payments.captured_minor`, `payments.intent_fingerprint`, one-open-charge index; `provider_invoices.trip_id` + one-live-invoice index; 9 CHECKs; 5 guard triggers |

No applied migration was edited. Prisma's `partialIndexes` preview feature lets the drift check
cover both partial indexes (drift = 0).

## Verification (real results)

| Check | Result |
|---|---|
| `format:check` / `lint` / `typecheck` / `build` | Pass |
| Unit tests | API **194/194** (16 files), web 16/16 |
| Integration, throwaway PostgreSQL 17 | **158/158** (9 files) |
| **Integration, Neon `test` branch** | **158/158 (9 files), 1,204 s**, final observed run (history below) |
| Built-server smoke test | Refuses `PAYMENT_GATEWAY=simulated` in production; `paymentGateway: simulated` logged in dev; anonymous payment/admin requests 401; `hold-release.js` once → exit 0; `--watch` runs and stops cleanly on SIGTERM |

### Neon verification history

Each run wiped and migrated only the Neon `test` branch (`ep-dry-pine-…`). The guard passed
every time: pooled and direct URLs point at the same database, which is not dev
(`ep-muddy-sunset-…`).

| Run | Result | What happened |
|---|---|---|
| 1 | **152/158**, 1,183 s | 6 tests in the two new files hit the 30 s per-test limit (`TestTimeoutError`). No assertion failed. Every Phase 2–4 test passed. |
| 2 | **156/158**, 1,271 s | Limit raised (payments 120 s): all 38 payment tests passed. The hold-release worker-loop test still timed out at 120 s. Its loop kept running, which made the next test's draft expire (409). |
| Diagnosis | - | A timing-instrumented copy of the test (deleted afterwards) showed the **setup** took ~117 s: 7 trips built one after another, about 5 s per API call on Neon. The loop itself released 4 trips, then 0, then 0. The one Prisma error seen came from the file's `afterAll` disconnecting after the timeout fired. |
| Fix | - | Hold-release setup builds its independent trips concurrently; the file allows 300 s; loop failures are reported instead of waited out. Assertions unchanged. That file alone on Neon: **2/2**. |
| 3 | not recorded here | Started before the previous session ended; its log stopped after 30 lines. The owner reported 158/158 from their run. |
| 4 (final, observed) | **158/158** (9 files), 1,204.44 s, exit 0 | Started 2026-11-21 22:40 (local) on the code committed as `32d10aa`; only Markdown changed afterwards. Guard passed; no failures, no skips. |

**What the integration tests prove:**

- **Online.** Intent 201, then a repeat call returns 200 with the same id. Confirm makes both items
  `PAID` + `CONFIRMED` and the trip `CONFIRMED`. Confirming again is a replay: still 2 allocations,
  Σ = captured. After that, intent gives `409 NOTHING_DUE`. Online commission stays `PENDING`
  (deducted from the payout later), and the payout is computed but not executed.
- **Concurrency:**
  - 5 simultaneous intents give one 201, four 200s and one open charge.
  - 5 simultaneous confirms give one application, four replays and allocations = captured.
- **Partial.** Capturing Rs 5,000 of Rs 12,600 makes the bus `PAID` (3,60,000) and the guide
  `PARTIALLY_PAID` (1,40,000), with the trip still `PENDING`. The next intent is for exactly
  "760000", and paying it confirms the trip. Capturing more than the intent gives 422. A failed
  payment allocates nothing, can't be confirmed later, and a new intent works.
- **Pay at property:**
  - Confirm issues 2 invoices (homestay "115500", bus "27000"), each linked to its item, with
    commission `INVOICED`.
  - A retried confirm gives 409; re-running invoicing is a no-op; still 2 invoices.
  - 3 simultaneous confirms give one 200, two 409s and exactly one invoice ("105000").
  - Admin settle gives `PAID_AT_PROPERTY`, idempotent; commission stays `INVOICED`, payout
    `NOT_APPLICABLE`, and there are no payment rows.
- **Mixed trip:**
  - The pay-at-property room is invoiced at confirm, and the intent covers the online part only
    ("540000").
  - After payment: trip `CONFIRMED`, `payOnline + payAtProperty = total`, `onlinePayment.dueMinor`
    "0".
  - SQL agrees: trip = Σ items, payment = Σ allocations, invoice = Σ commission.
- **Ownership:**
  - A stranger gets 404 on intent, confirm and the payments list (same as a missing trip).
  - Another trip's payment id gives `404 PAYMENT_NOT_FOUND`, and the stranger's attempts changed
    nothing.
  - No session gives 401; no CSRF token gives 403.
  - Customers get 403 on every `/admin` URL, including unknown trips; a demoted admin loses access
    on the next request.
  - With no gateway, intents and confirms are 503; after the hold, confirm is `409 TRIP_EXPIRED`.
- **Database refuses direct writes:**
  - over-allocating a payment, an allocation into another trip, over-paying an item;
  - allocating an open payment, editing or deleting an allocation;
  - `PAID`/`PARTIALLY_PAID` without matching allocations;
  - a second open charge, re-capturing a succeeded payment;
  - expiring a partly paid item;
  - unlinking an issued invoice's item, editing an issued invoice, issuing a wrong amount,
    `INVOICED` without an invoice.
- **Hold-release.** The worker loop (50 ms interval, ≥ 3 runs) releases abandoned drafts. It keeps:
  - the confirmed stay;
  - the mixed trip's hotel and invoice, while releasing its unpaid bus and cancelling the open
    intent;
  - the fully paid trip;
  - the partly paid guide (trip stays `PENDING`, no expiry, remainder payable: "899000").

  Holds equal active items exactly, and the next run releases 0. Four concurrent runs release 6
  stale drafts exactly once: six seats come back, not twelve.
- **Money at the boundary.** More than 100 money fields across every payment, trip and admin
  response are digit strings with their currency. No customer response contains commission or
  payout fields.
- **Regression:** the Phase 2, 3 and 4 suites pass unchanged, including the Phase 3 mixed-trip
  expiry test. Three expectations were updated on purpose: the env defaults, the BIGINT column
  count (21), and `paidMinor` on item money.

**Mutation checks** (code broken on purpose, then restored):

| Mutation | Caught by |
|---|---|
| `capturedMinor` serialized as a JSON number | 9 failing integration tests, including the money-boundary scan; plus a unit mutation test |
| Owner scoping removed from payment writes | Ownership test fails |
| App replay/open checks removed | Concurrency test fails |
| All app-level guards removed (replay, status, fingerprint, planned allocation) | **Database refused 4 of 5 concurrent confirms (422); one succeeded** |
| Sweeper expires partly paid items | CHECK `booking_items_paid_never_expires_chk` stops the sweep; both hold-release tests fail |

## Security checklist

- [x] No secrets in any diff (staged diffs scanned; real values only in the git-ignored `apps/api/.env` and `.env.test`)
- [x] `.env.example` has placeholders only (`PAYMENT_GATEWAY` and `HOLD_RELEASE_INTERVAL_SECONDS` commented out)
- [x] The simulated gateway cannot run in production (startup refuses it)
- [x] Every new endpoint is authenticated, validated with strict Zod, owner-scoped (404) or admin-only (403 before any read); writes need CSRF
- [x] Clients never send prices; the captured amount comes from the (simulated) gateway report and is capped by the intent
- [x] Customer responses contain no commission or payout data

## Operational gaps

**Closed:**

- `INVOICED` without an invoice record;
- hold-release job not scheduled.

**New:**

- no live gateway;
- late gateway success after the hold;
- no persistent admin audit log (admins are created by SQL);
- invoice numbering and payment terms undecided;
- partners can't record a settlement.

All are listed in [operational-gaps.md](../development/operational-gaps.md).

## Known limitations / follow-ups

1. **Decisions for the owner** (not invented here):
   - invoice numbering (sequential, for Nepal's tax rules?);
   - invoice payment terms (`due_on`);
   - invoice cadence beyond per-trip (e.g. monthly);
   - payout schedule (finance phase).
2. **`npm audit`: 3 high, all from one advisory** (GHSA-7589-6fvf-x4pw, ReDoS in `effect` ≤ 3.22.0).
   It reaches us through `prisma` → `@prisma/config`, which pins `effect@3.20.0`. It affects the
   Prisma CLI and config loader, not the API runtime. npm's only fix is downgrading to Prisma 6.12,
   which I rejected. Options: wait for a Prisma release, or add an npm `overrides` entry for
   `effect@3.22.5` (needs your approval, and Prisma CLI compatibility would need testing).
3. The expired-session cleanup (gap 6) could be one more step in the new job runner. It wasn't part
   of this brief.
4. The Neon test branch is now `ep-dry-pine-…` (Phase 4 used `ep-fragrant-dream-…`). It is
   separate from dev and the guard passed; please confirm this is the intended test branch.
5. The two Phase 5 migrations are applied to the Neon test branch. They are not yet applied to the
   dev branch; that waits for your approval (it is additive, and dev has no trips).

## Commits

| Hash | Message |
|---|---|
| `a8ba256` (on `main`) | docs: mark Phase 4 merged and tagged v0.4.0 (CI run `44918716735`, green) |
| `7086637` | feat(api): add online and pay-at-property payment flows with commission invoices |
| `d6ba7c5` | feat(jobs): schedule the hold-release job and document scheduling |
| `32d10aa` | test(api): cover payment idempotency, invoices and hold-release; parallelize hold-release setup and raise Neon timeouts |
| (this commit) | docs: record Phase 5 Neon verification and final report |

Each code commit was checked on its own in a clean worktree (`npm ci`, format, lint, typecheck,
build, unit, integration on PostgreSQL 17):

| Commit | API unit | Web unit | Integration |
|---|---|---|---|
| `7086637` | 153/153 | 16/16 | 118/118 (Phase 2–4 suites on the new code) |
| `d6ba7c5` | 153/153 | 16/16 | 118/118 |
| `32d10aa` | 194/194 | 16/16 | 158/158 |

CI on `32d10aa`: run `44927418564`, **success**.

## How to review

1. Read [ADR 0007](../architecture/decisions/0007-payments-and-invoices.md) and the payments
   section of [api.md](../architecture/api.md#payments-adr-0007).
2. Run `npm run test:integration` (wipes the TEST branch) and `npm test`.
3. Locally: set `PAYMENT_GATEWAY=simulated`, then `npm run dev` and follow
   [local-setup.md → Trying payments locally](../development/local-setup.md#trying-payments-locally).
