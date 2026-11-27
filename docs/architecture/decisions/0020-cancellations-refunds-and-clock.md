# 0020. Cancellations, refund execution, the refund clock, settlement reconciliation and clawbacks

- **Status:** Accepted
- **Date:** 2026-11-27
- **Phase:** 14 (Cancellations & refunds). Builds on ADR 0015 (policies frozen per item), ADR 0017
  (gateway adapters, the refund-request shape) and ADR 0018 (payouts, voids). Closes gaps 31, 36
  and 39.

## Context

Since Phase 11 a refund could only be **recorded** (`refund_requests`, `REQUESTED`/`REJECTED`;
the database refused anything else). Customers could not cancel a booking themselves; only an
admin could void one, and not once its payout was paid (gap 39). Pay-at-property settlements were
never compared with the commission invoices (gap 36). ADR 0015 froze each booking's policy tiers
("72+ hours before the start: 100%") but not the clock those hours count from.

Khalti documents a merchant refund API; eSewa documents none (refunds are made in its merchant
portal). Khalti's refund docs (docs.khalti.com/api/refund, read 2026-11-27):

- `POST {api}/merchant-transaction/{transaction_id}/refund/` (`{api}` = `https://khalti.com/api`,
  sandbox `https://dev.khalti.com/api`; the transaction id comes from the lookup);
- no body = full refund; `{ "amount" }` = partial;
- success `{ "detail": "Transaction refund successful." }`.

They say the amount is in paisa but show `50.00`. No refund id or refund-status endpoint is
documented; the lookup reports `Refunded` / `Partially Refunded` and `refunded`.

**Owner decisions (2026-11-27):**

| Question | Decision |
|---|---|
| Refund clock | "Hours before the start" counts from the **actual start of the service** (check-in, departure, start time), stored as an exact timestamp on each item |
| Guides, tours, activities (no time stored) | **Partners set a start time** on those listings (required for new and edited details). Older listings and items without one fall back to **00:00 Nepal time** of the start date, labelled as such |
| Commission on a partial refund | **On the part kept:** e.g. a 50% refund means commission = 15% of 50% of the subtotal. A full refund waives the commission |
| Clawback recovery | **Deducted from the provider's next payouts**, never below zero; the remainder carries forward |
| No policy, or non-refundable | The customer **may cancel; refund 0**, shown before confirming. Admin voids remain for exceptions. Gap 30 stays open (a policy is still optional) |
| Phase number | This is Phase 14; Search UX moves to 15 |

## Decision

### 1. The refund clock (`booking_items.service_starts_at`)

- Every item stores `service_starts_at` (UTC) and `service_start_source`: `LISTING_TIME` (from the
  listing) or `DEFAULT_MIDNIGHT` (no time known).
- The instant is the start date at the listing's time in Nepal (UTC+05:45, no daylight saving),
  frozen when the item is added or its dates change. A later change of the listing's time never
  changes bookings.
- Where the time comes from is a pure lookup (`listingStartTime`, `listing-details.ts`), with no
  listing-type code. A listing has at most one detail row:
  - a stay: its check-in (a room uses its parent hotel's);
  - a bus: its departure;
  - a guide, tour or activity: its new `start_time`.
- New detail columns:
  - `guide_service_details.start_time` and `tour_details.start_time` (nullable for old rows);
  - a new 1:1 `activity_details` table (activities had none; ADR 0004 allows adding a detail table).
- The API requires the start time when guide, tour and activity details are written.
- **Database checks:**
  - the Nepal date of the start equals `start_date`;
  - a `DEFAULT_MIDNIGHT` start is exactly 00:00 Nepal time.
- **Migration backfill:** existing items are filled the same way, by detail rows, and checked on
  v0.13.0 seed data (rooms 13:00 from the parent hotel, the bus 06:30, the guide midnight).
- **Tiers** (`domain/refunds.ts`):
  - notice = `service_starts_at − cancelled_at`, in milliseconds, never rounded;
  - the first tier (most hours first) with `minHoursBeforeStart` hours ≤ the notice applies;
  - exactly 72 h meets a 72-hour tier; 71 h 59 m 59.999 s does not;
  - after the start nothing can be cancelled.

### 2. Customer cancellations

- `GET /trips/:id/items/:itemId/cancellation` shows what cancelling now gives back. It never
  includes commission.
- `POST …/cancel {expectedRefundMinor}` cancels, but only if the refund still equals what the
  customer saw. Otherwise `409 CANCELLATION_TERMS_CHANGED` (a tier boundary passed).
- Only CONFIRMED items, before they start. An item already settled at the property is refused
  (the provider holds that money; an admin can void). Owner-scoped: another customer's trip is a
  404.
- **Amounts**, frozen on the item and re-computed by CHECK constraints:

  ```
  refund           = round_half_up(total × tier_bps / 10000)       online (confirmed = fully paid)
                   = 0                                             pay at property
  kept             = total − refund
  kept_commission  = min(round_half_up(subtotal × (10000 − bps) × rate / 10⁸), kept)
                   = 0, commission WAIVED                          when nothing is kept
  ```

- **Effects** (one transaction, trip locked):
  - CANCELLED, with `cancelled_by_id`, the tier bps, the refund and the kept commission;
  - inventory released;
  - online refunds become refund REQUESTS (split over the charges that paid it, newest first);
  - an issued invoice for waived pay-at-property commission gets an adjustment (ADR 0018);
  - trip totals and status recomputed;
  - audited, with the customer as actor.
- Repeating a cancel returns the same result.

### 3. Refund execution (gap 31)

```
REQUESTED ─approve→ APPROVED ─execute→ PROCESSING ─→ COMPLETED
    │                  │                    └──────→ FAILED ─execute (retry)→ PROCESSING
    └─reject→ REJECTED ←┘ ←──────────────────────── FAILED ─reject→ REJECTED
```

- **Adapters** (`PaymentGatewayAdapter`, ADR 0017) gain optional `refund()` and `checkRefund()`.
  Core code never names a gateway; it asks whether the adapter can refund.
  - **Khalti:** the refund API. No body for a full refund; `{ amount }` in **paisa** for a partial
    one. The reference stored is Khalti's refund id if it ever returns one, else the refunded
    transaction id.
  - **eSewa:** no `refund()`. Execute moves the refund to PROCESSING with mode MANUAL and the note
    "Refund by hand in the eSewa merchant portal…". The admin refunds in the portal, then records
    the eSewa reference: `complete {reference, note?}` → COMPLETED.
  - **Simulated** (dev/test only, refused in production): refunds at once.
- **Order of writes:** PROCESSING is committed **before** the gateway is called, and the call runs
  outside any transaction.
  - Success → COMPLETED.
  - A definite refusal (4xx) → FAILED with the reason; retry is allowed.
  - An unknown outcome (time-out, 5xx) stays PROCESSING. `check` asks the lookup:
    - `Refunded` / `Partially Refunded` matching this refund, with no earlier completed refund on
      the payment → COMPLETED;
    - still `Completed` without `refunded` → FAILED (safe to retry);
    - anything ambiguous stays PROCESSING, and an admin confirms in the Khalti portal with
      `complete`.
- **Idempotency:**
  - each step locks the refund row; repeats return `changed: false`;
  - a refund already PROCESSING or COMPLETED is never sent again;
  - a partial unique index allows one PROCESSING refund per payment (`409 REFUND_IN_PROGRESS`);
  - tests run two executes at once and see exactly one gateway call.
- **Limits:** refunds never exceed what the payment paid for the item (Phase 11 trigger, kept).
  - Completing a refund adds it to the item's `refunded_minor` and sets its payment status: PAID →
    PARTIALLY_REFUNDED → REFUNDED.
  - A deferred constraint trigger checks at commit that `refunded_minor` equals the completed
    refunds and that the status matches.
  - The guard also fixes the money fields, the transitions and finished refunds, and refuses
    deletes.
- **Money already with the provider:**
  - executing is refused while the item is in a SCHEDULED payout (`REFUND_ITEM_IN_SCHEDULED_PAYOUT`);
  - executing is refused when the item was paid out without a clawback (`REFUND_ITEM_PAID_OUT`:
    void it first);
  - the database also refuses changing `refunded_minor` of an item in a scheduled batch.
- **No `REFUND` rows in `payments`.** The roadmap mentioned them, but every money movement back is
  already a refund request with amount, gateway, reference, who and when. Several charge queries
  and invariants read `payments` without filtering by kind, so adding refund rows there would only
  add risk.
- **Audit:** `refund_request.approve | reject | execute | execute.unknown | complete.api |
  complete.manual | complete.check | fail`, with no secrets. References are masked in responses and
  audit rows (`••••8899`).

### 4. Payouts after a cancellation, and clawbacks (gap 39)

- **Payable items:**
  - paid and live, as before;
  - or cancelled by the customer, not voided, with something kept and its refund completed
    (`refunded = cancellation_refund`).
- An unfinished refund holds an item back: REQUESTED, APPROVED, PROCESSING or FAILED.
- **A batch line:** gross = `total − refunded`; commission = the kept commission, else the
  snapshot. The SQL, the domain function and both payout guards (replaced in this migration, the
  applied ones are untouched) use the same rule.
- **Voiding a paid-out item** is now allowed (`planVoid`):
  - the customer gets everything back (refund requests for all allocations);
  - the commission MeroStay deducted is waived (PAID → WAIVED, only on this path:
    `canWaivePaidOutCommission`);
  - a `provider_clawbacks` row records the item's line in its PAID batch;
  - past payouts never change.
- **Recovery:** when a batch is scheduled, outstanding clawbacks of that provider and currency are
  deducted, oldest first (`planDeductions`), up to the batch's net before deductions, so a batch
  never goes below zero.
  - Each deduction is a `provider_clawback_recoveries` row, append-only.
  - It counts while its batch is SCHEDULED or PAID; a FAILED transfer gives it back.
  - `payouts.deductions_minor`; net = gross − commission − deductions (CHECK; the schedule guard
    re-sums).
- **Views:** admins see every clawback with recovered and outstanding amounts
  (`GET /admin/clawbacks`); partners see their own (`GET /partner/clawbacks`).

### 5. Pay-at-property reconciliation (gap 36)

- **Mismatches** are computed, not stored (`domain/settlement-reconciliation.ts`, mirrored in SQL),
  for live pay-at-property items:
  - `UNSETTLED_AFTER_SERVICE`: invoiced, the service over in Nepal time, never recorded paid;
  - `SETTLED_NOT_INVOICED`: recorded paid, but no invoiced or paid commission;
  - `SETTLED_BEFORE_SERVICE`: recorded paid before `service_starts_at`.
- `GET /admin/settlement-reconciliation?state=open|resolved|all&kind=` lists them.
- `POST …/:itemId/resolve {kind, note}` records how one was handled: once per item and kind,
  append-only, audited.
- **No money moves.** Corrections use the existing tools: undo a settlement, void a booking.

### 6. Web

- **Customers:**
  - each booking shows its start ("Starts 20 Dec 2026, 14:00 (Nepal time)", or "no start time
    given");
  - "Cancel this booking…" shows the policy line, the notice and the exact refund before
    confirming.
- **Admins:**
  - the refund queue gains status filters and per-status actions (approve, "Refund through Khalti" /
    "Start a manual refund (eSewa merchant portal)", record the reference, ask Khalti, reject with a
    note);
  - a Settlements page;
  - clawbacks on the Payouts page, and deductions in each batch.
- **Partners:**
  - a start-time field for guides, tours and activities;
  - deductions in their payouts, and their clawbacks.
- The UI computes no money.

## Consequences

- **Refunds are real money:** Khalti by API, eSewa by a recorded manual step.
- The database enforces every amount and transition.
- **Behaviour changed on purpose** (tests updated to match):
  - a paid-out item can be voided (with a clawback);
  - a refund can leave REQUESTED (through its state machine);
  - an activity listing needs its start time;
  - void responses carry `clawbackMinor` with its currency.
- **Limits, recorded as gaps:**
  - a clawback with no later payouts is collected outside MeroStay (gap 40);
  - an admin's partial refund on an active (not cancelled) item keeps it out of payouts (gap 41);
  - the Phase 6 "not yet batched" payout estimate excludes the kept part of cancelled items (gap 41);
  - customers are not notified when a refund completes (Notifications, gap 1/2 phase).
- **Launch checklist:** confirm with the Khalti sandbox that a partial refund's `amount` is in
  paisa before going live.
