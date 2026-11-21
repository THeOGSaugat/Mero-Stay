# 0007. Payments, commission invoices and the hold-release job

- **Status:** Accepted
- **Date:** 2026-11-21
- **Phase:** 05

## Context

Phase 3 confirms trips without taking money: online items stay `PENDING`/`UNPAID`, and
pay-at-property items become `CONFIRMED` with commission `INVOICED`, but no invoice exists. The
hold-release sweeper exists but nothing runs it. Phase 2 created the shapes (`payments`,
`payment_allocations`, `provider_invoices`, `payouts`) without flows.

The owner's Phase 5 brief: a provider-agnostic online payment flow with idempotent intents and
confirmation, per-item allocation with partial payments, a pay-at-property settle step, real
invoice records behind `INVOICED`, and a scheduled hold-release job. No live gateway, no refund
or payout execution, backend only.

## Decisions

### 1. Simulated gateway, explicit opt-in, refused in production

`PAYMENT_GATEWAY=simulated` enables a test-mode gateway: the confirm endpoint stands in for the
provider's verified server-to-server callback and may report a full capture, a partial capture
or a failure. Because anyone could mark their own payment as paid, **the API refuses to start with
`PAYMENT_GATEWAY=simulated` when `NODE_ENV=production`**. Unset (the default everywhere) means no
gateway: intents and confirmations return `503 PAYMENTS_UNAVAILABLE`. eSewa and Khalti will be
further gateway names (`payments.gateway` is text) whose confirm step verifies with the provider.

### 2. Amounts come from the server; one open intent per trip

`POST /trips/:id/payments/intent` takes no amount. Under the trip's row lock (owner-scoped, as in
ADR 0006) it computes the **due lines**: every `PENDING` online item that is `UNPAID` or
`PARTIALLY_PAID`, with `total − allocated so far`, in item order. The intent stores the sum as
`amount_minor` and an **intent fingerprint** = SHA-256(trip, currency, sorted item=due pairs).

- Same fingerprint as the open intent → the open intent is returned (`200`, `created: false`).
- Different fingerprint (something changed) → the old intent is cancelled and a new one created (`201`).
- The database allows **at most one open charge per trip** (partial unique index
  `payments_one_open_charge_per_trip`), so even code that skipped the lock could not create two.

Why not a client `Idempotency-Key` header? The natural key here is "this trip's outstanding
balance". Deriving it on the server makes retries, double clicks and two browser tabs converge on
one intent without the client doing anything. A header can be added for the live gateways if
they need one.

### 3. Confirmation is idempotent; allocation is in the same transaction

`POST /trips/:id/payments/:paymentId/confirm`, under the trip lock:

1. A payment of another trip is `404 PAYMENT_NOT_FOUND`; another user's trip is `404 TRIP_NOT_FOUND`.
2. Already `SUCCEEDED` → returned unchanged with `replayed: true` (no second capture or allocation).
3. Not open (`FAILED`/`CANCELLED`) → `409 PAYMENT_NOT_OPEN`. Hold passed → `409 TRIP_EXPIRED`.
   Due lines no longer match the fingerprint → `409 PAYMENT_INTENT_STALE`.
4. Success: `status = SUCCEEDED`, `captured_minor` = captured amount (≤ `amount_minor`), then
   allocations are inserted, then item statuses are updated (all in one transaction).

The database re-checks this independently of the code (guard triggers, raising `check_violation`
with a named constraint like a CHECK):

| Guard | Rule |
|---|---|
| `payments_captured_chk` | `0 ≤ captured ≤ amount`; captured > 0 exactly when `SUCCEEDED` |
| `payments_finished_immutable_chk` | A `SUCCEEDED`/`FAILED`/`CANCELLED` payment never changes |
| `payment_allocations_*` | Only succeeded charges are allocated; same trip and currency; online items only; Σ per payment ≤ captured; Σ per item ≤ item total; allocations are immutable |
| `booking_items_payment_matches_allocations_chk` | `UNPAID` ⇔ 0 allocated; `PARTIALLY_PAID` ⇔ 0 < allocated < total; `PAID` ⇔ allocated = total |
| `booking_items_paid_not_pending_chk` / `booking_items_paid_never_expires_chk` | A paid item is confirmed; an item holding customer money is never expired |

The allocation trigger row-locks the payment and the item before summing, so concurrent writers are
checked one at a time. In a mutation test with every application-level check removed, four of five
concurrent confirmations were refused by the database and exactly one succeeded.

### 4. Partial payments: new status `PARTIALLY_PAID`

A captured amount fills due lines in order (`domain/payments.ts`): an item becomes `PAID` (and
`CONFIRMED`) only when its allocations equal its total; otherwise it is `PARTIALLY_PAID` and stays
`PENDING`. The trip becomes `CONFIRMED` when no item is pending. A new intent then covers only the
remainder. `PARTIALLY_PAID` is a new `payment_status` value (migration
`20261121090000_add_payment_statuses`, its own migration because PostgreSQL cannot use a new enum
value in the transaction that adds it).

### 5. Pay-at-property settlement: new status `PAID_AT_PROPERTY`, admin only

The payment method is encoded in `payment_status` (ADR 0005). Setting a settled pay-at-property item
to `PAID` would make it look like MeroStay holds the money, which would wrongly suggest a payout.
So settlement is `PAY_AT_PROPERTY → PAID_AT_PROPERTY` (new value). Commission stays `INVOICED`,
because the provider still owes it, and the payout stays `NOT_APPLICABLE`. No money moves.

**Who may settle:** MeroStay staff, at `POST /admin/trips/:id/payments/at-property/settle`. The
customer is the payer and cannot be the one who confirms the provider received the money. The
provider is the right party, but partner accounts arrive with provider onboarding; a partner path can
be added then. **Admin is identified by `users.role = 'ADMIN'` on the session user**, re-read from
the database on every request. No endpoint can grant `ADMIN` (registration always creates
`CUSTOMER`); an operator promotes a user in the database. The `/admin` router checks the role before
reading any data, so non-admins get the same `403 FORBIDDEN` for every URL. Admin writes are logged
with the admin's user id (a persistent audit log is an operational gap).

### 6. Commission invoices: one per trip and provider, issued at confirm

When a trip is confirmed, its confirmed pay-at-property items with commission `PENDING` are
grouped by provider. For each group, in the same transaction: an invoice is created as `DRAFT` with
`trip_id`, provider, currency and amount = Σ commission. The items are linked and their commission
becomes `INVOICED`. Then the invoice becomes `ISSUED` with `issued_at`. The owner's brief set this
cadence (per trip). Monthly consolidation can come later; `trip_id` is nullable for that.

| Guard | Rule |
|---|---|
| `provider_invoices_one_live_per_trip_provider` | Partial unique index: one non-void invoice per (trip, provider) |
| `booking_items_invoiced_has_invoice_chk` | Commission `INVOICED` ⇒ an invoice is linked |
| `provider_invoices_amount_matches_items_chk` | `DRAFT → ISSUED` only if amount = Σ linked items' commission |
| `provider_invoices_issued_immutable_chk`, `booking_items_invoice_link_chk` | An issued invoice's amount and items never change; items join only a DRAFT of the same provider, trip and currency |
| `provider_invoices_status_transition_chk` | `DRAFT → ISSUED/VOID`, `ISSUED → PAID/VOID` |

Retries: a second confirm is refused (`409 TRIP_NOT_EDITABLE`). Re-running the invoicing step
finds no `PENDING` items and creates nothing. Concurrent confirms serialise on the trip lock (one
`200`, the rest `409`). Numbers are `INV-YYYYMMDD-XXXXXXXX` (Nepal issue date plus a random
suffix). **Open for the finance phase:** whether Nepal's tax rules require sequential invoice
numbers, and the payment terms (`due_on` is left empty). Invoices are internal this phase: an
admin can read them at `GET /admin/trips/:id/invoices`, and provider-facing endpoints arrive with
the partner dashboards.

### 7. Online commission and payouts: computed, not executed

For online items, MeroStay holds the money. Commission stays `PENDING` and `payout_status`
`PENDING`, with `provider_payout_minor = total − commission` already stored per item (CHECK). The
deduction happens when a payout is executed (finance phase), and only then does commission become
`PAID`.

### 8. Hold-release job: a worker/cron script, no new dependency

`src/jobs/hold-release.ts` runs the Phase 3 sweeper in batches until nothing stale is left.
`src/scripts/hold-release.ts` is the entry point:

| Command | Use |
|---|---|
| `npm run jobs:hold-release` (`node apps/api/dist/scripts/hold-release.js`) | Run once and exit: for cron or a platform scheduler, every minute |
| `npm run jobs:hold-release:watch` (`… --watch`) | Long-running worker: runs now and every `HOLD_RELEASE_INTERVAL_SECONDS` (default 60); never overlaps itself; a failed run is logged and retried |

`npm run dev` starts the worker next to the API and web app. The job is **idempotent and safe to
run concurrently** without an external lock. The sweeper takes its trips with
`FOR UPDATE SKIP LOCKED`, so concurrent runs get disjoint sets and skip trips a request is editing.
A released trip no longer matches the query, so a hold is released exactly once.

Changes to the sweeper:

- It never expires an item with customer money on it (`PARTIALLY_PAID`). This is also a CHECK.
- Its trip stays `PENDING`, with no expiry, until the rest is paid.
- It cancels open intents of the trips it sweeps.

Why not an in-process timer in the API? It would run once per API instance and stop with the web
process. A separate worker, or the platform's cron, is the normal deployment shape. Why not a job
library (BullMQ, pg-boss)? One periodic, idempotent SQL job does not need a queue or Redis.

## Refunds and payouts: shape and plan (not built)

The schema can represent both:

- **Refunds:** `payments.kind = 'REFUND'` rows (with `gateway_transaction_id`),
  `booking_items.refunded_minor` (CHECK ≤ total), and the `PARTIALLY_REFUNDED`/`REFUNDED` statuses
  (`PARTIALLY_PAID → REFUNDED` allowed). Plan (cancellations phase): cancel an item →
  refund amount from the frozen policy snapshot → `REFUND` payment via the gateway → update
  `refunded_minor` and status → release inventory.
- **Payouts:** `payouts` (provider, period, amount, status, reference) and `booking_items.payout_id`.
  Plan (finance phase): select online items that are `PAID`, completed and not yet paid out, per
  provider and period. Create a payout for Σ `provider_payout_minor`, link the items, and set their
  commission to `PAID` (deducted) and `payout_status` to `PAID` when the transfer is confirmed.
  Before that: payout schedule (owner decision) and a DB check that a payout amount equals its
  items' payout sum (same pattern as invoices).

## Alternatives considered

- **A `payment_method` column on `booking_items`:** cleaner long term, but it would change Phase
  3's encoding, the quote split and existing data. A status value (`PAID_AT_PROPERTY`) fits ADR 0005
  and is additive.
- **Application checks only:** they would be simpler, but the brief requires the database to enforce
  the math, and the mutation test shows the triggers are what stop a double allocation when the
  code is wrong.
- **Deferred constraint triggers:** they would allow any write order, but errors would surface at
  `COMMIT`, where the central error mapping is harder. The code writes in a fixed order instead
  (capture → allocations → item status; invoice DRAFT → link → ISSUED).
- **Invoice per provider per month:** this needs an owner decision on invoice cadence. Per trip is
  what the brief asked for, and it keeps "exactly once" simple to prove.

## Consequences

- `PAYMENT_GATEWAY` must stay unset in production until a real gateway exists; online payment is
  then unavailable (`503`), and pay-at-property bookings still work.
- Partial-index support uses Prisma's `partialIndexes` preview feature, so the drift check covers
  the two indexes. If the feature changes, the indexes can move to raw SQL with a drift exception.
- A real gateway can report success after the hold expired, or after the trip was swept. Handling
  that payment (refund or reallocation) is an operational gap for the live-gateway phase.
- Settlement and invoices are visible only to admins until partner accounts exist.
