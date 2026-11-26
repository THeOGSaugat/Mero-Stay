# 0018. Payouts by recorded bank transfer, and admin moderation

- **Status:** Accepted
- **Date:** 2026-11-26
- **Phase:** 12. Closes operational gaps 16 (payout execution), 9 (admin accounts), 13
  (correction), 15 (listing approval) and 34 (admin queues), and narrows 33. Builds on ADRs 0007,
  0008, 0013 and 0017.

## Context

After Phase 11, online money really reaches MeroStay (eSewa, Khalti), but:

- nothing pays providers (gap 16);
- admins are created and removed in SQL (gap 9);
- a wrong booking or a mistaken settlement cannot be corrected (gap 13);
- partner listings never become public without SQL (gap 15);
- late payments and refund requests exist only in the API (gap 34);
- money paid after the last gateway check can go unseen (gap 33).

The owner's brief merged the roadmap's Commission & payouts and Admin moderation phases into one.

**Owner decisions (2026-11-26):**

| Question | Decision |
|---|---|
| Roadmap | Shift up by one: 12 this phase, 13 Search UX, 14 Cancellations & refunds, 15 Reviews, 16 Notifications, 17 Hardening |
| Payout eligibility and period | An online-paid item is eligible once its service has **ended** (Nepal time) and it was not cancelled. One payout per provider and **calendar month** of the service date |
| First password of a new admin | A **one-time setup link** (24 h), shown once to the creating admin; no email system yet |
| Voiding an item whose commission was already invoiced | The commission is **waived** and the invoice gets an **adjustment**; the issued invoice itself is never edited |

## Decision

### 1. Payout batches (gap 16): manual transfer, recorded

`payouts` (Phase 2 shape) becomes a real batch:

- gross, commission and net amounts: net = gross − commission (ADR 0008), with a CHECK;
- the item count and a calendar-month period (CHECK: first to last day);
- who created, scheduled and paid it, and when;
- a **masked** snapshot of the bank account (`Nabil Bank · ••••4321`);
- the transfer reference (stored; only ever returned **masked**, last 4);
- failure reason and time.

The Phase 2 status `PROCESSING` was never used and is renamed `SCHEDULED`.

| Step | Who | What happens |
|---|---|---|
| `POST /admin/payout-batches/generate {period: "YYYY-MM"}` | Admin | For each provider and currency with eligible items in that month: create the PENDING batch, or top up the open one; link the items; set the sums. A per-month advisory lock serialises concurrent runs; a repeat adds nothing |
| `…/:id/schedule` | Admin | PENDING → SCHEDULED. Items that stopped being eligible (e.g. a refund was requested) leave first. Needs a **verified** default bank account (409 otherwise). Amounts and items are then fixed |
| `…/:id/mark-paid {bankReference}` | Admin | SCHEDULED → PAID after the transfer was made outside MeroStay. Items: payout PAID, commission PAID (deducted, ADR 0007). The same reference again is a no-op; another one is a 409 |
| `…/:id/mark-failed {reason}` | Admin | SCHEDULED → FAILED: the items are released and picked up by the next generate |
| `GET /partner/payout-batches[/:id]` | Partner | Own batches only (another provider's is a 404), read-only |

**Eligible item** (`domain/payouts.ts`, and the same SQL):

- online, payment PAID, payout PENDING, not in a batch;
- status CONFIRMED, IN_PROGRESS, COMPLETED or NO_SHOW;
- last service date (the day before check-out for ranges) before today in Nepal;
- no open refund request.

**Database guards** (`payouts_guard`, `booking_items_payout_guard`):

- batches are created PENDING, never deleted, and move only PENDING → SCHEDULED → PAID | FAILED;
- a scheduled batch's money, items, period and account snapshot never change, and when it is
  scheduled its sums must equal its items;
- an item joins only an open batch of its own provider, currency and month, and only when it
  is PAID online and not cancelled;
- an item is "paid out" only through a PAID batch, and stays so;
- one open batch per provider, month and currency (partial unique index).

**Bank accounts.** Provider approval already verifies the default account (ADR 0008). An account
changed **after** approval starts unverified again, and nothing could re-verify it. So
`POST /admin/providers/:id/payout-account/verify` (audited) marks it verified after MeroStay has
checked it out of band; payouts cannot be scheduled to an unverified account.

### 2. Admin accounts (gap 9)

- `POST /admin/admins {email, fullName}` creates an ADMIN account **without a password** and
  returns a one-time setup link: `/admin-setup#token=<32 random bytes, base64url>`.
  - Only the SHA-256 of the token is stored (`admin_setup_tokens`); it expires after 24 h and
    works once.
  - The token sits in the fragment, so it never reaches a server log or a Referer. The page is
    `no-referrer` and not indexed.
  - The link is shown once, in the console, to the creating admin, who hands it over in person or
    by phone: MeroStay has no email yet (gap 37).
  - An email already in use is a 409: nobody is promoted silently.
- `POST /api/v1/auth/admin-setup {token, password}` has no session and is rate limited per client
  (10 per 15 minutes). It sets the password (the same policy as registration, Argon2id), marks the
  token used and is audited. Unknown, used and expired tokens all get the same answer.
- `POST /admin/admins/:id/setup-link` reissues a link for an admin who never set a password; the
  old link stops working.
- `POST /admin/admins/:id/suspend | reactivate`. Suspending also deletes the account's sessions.
  - **You cannot suspend yourself** (`ADMIN_SELF_LOCKOUT`).
  - **The last usable admin** (active, with a password) can never be suspended, demoted or lose
    its password. The service refuses it (`LAST_ADMIN`), and the `users_keep_an_admin` trigger
    refuses it in the database.
  - Admin changes take one advisory lock, so two admins cannot suspend each other at once.
- Every change is audited. Tokens and passwords never appear in a response or an audit row
  (audit redaction drops `token`/`password` keys; tests check it).
- The **first** admin is still created by an operator in SQL (bootstrap); everything after that
  goes through the console.

### 3. Listing review (gap 15)

- `GET /admin/listings?status=PENDING_REVIEW` lists the queue, with a type-rule hint per
  listing. Decisions: `POST /admin/listings/:id/approve`, and `…/reject {reason}`, where the reason
  is required and the partner sees it on their listing as `review.note`.
- **Approval re-checks the listing-type rule (ADR 0013).** The provider type must be mapped to
  the listing type, and both must be active; otherwise `422 LISTING_TYPE_NOT_ALLOWED` (or
  `…_NOT_OFFERED`) and nothing changes. The rule can change after submission, which is exactly
  when this matters.
- The `listings_approval_type_rule` trigger repeats the check in the database for any change to
  APPROVED.
- `listings_review_chk`: a rejection always has a note, and who/when are set together.
- Approval sets `publishedAt` the first time. Public search already shows only APPROVED listings
  of a VERIFIED provider and an active type, so an approved listing becomes public with no other
  change.

### 4. Voids and corrections (gap 13)

`POST /admin/booking-items/:id/void {reason}` and `POST /admin/trips/:id/void {reason}` (all
voidable items, all or nothing). The decision is pure (`domain/booking-void.ts`):

- **Voidable** items are PENDING or CONFIRMED and not paid out. An item in a SCHEDULED batch must
  first be recorded paid or failed. IN_PROGRESS, COMPLETED and NO_SHOW items are not voidable.
- **Effect** (one transaction, trip locked):
  - the item becomes CANCELLED with `voided_at`, `voided_by` and `void_reason`
    (`booking_items_void_chk`);
  - its held inventory is released;
  - it leaves an open payout batch;
  - its commission becomes WAIVED;
  - for an online payment, each succeeded charge allocation becomes **one refund REQUEST** for
    its amount (Phase 11 shape: never executed here; the payment status stays PAID until a refund
    is actually made, Phase 14);
  - trip totals are recalculated from the active items; with nothing active the trip is
    CANCELLED; open payment intents are cancelled, and late money is reconciled (ADR 0017).
- **Invoiced commission:** a `provider_invoice_adjustments` row records the waived amount.
  - The invoice is immutable (ADR 0007): owed = amount − adjustments.
  - When adjustments cover the whole invoice, it becomes VOID.
  - Adjustments are append-only and must match a waived item of that issued invoice (trigger).
- **Settlement correction:** `POST /admin/booking-items/:id/settlement/reverse {reason}` undoes a
  pay-at-property settlement recorded by mistake (PAID_AT_PROPERTY → PAY_AT_PROPERTY; who/when
  cleared). Money snapshots never change. A wrong **amount** is corrected by voiding and
  rebooking, never by editing a snapshot.
- Every void and correction is audited with before/after values; repeats are no-ops.

### 5. Admin queues (gap 34)

The web console gains:

- **Late payments** (`/admin/late-payments`): open and handled; mark one handled with a note;
- **Refund requests** (`/admin/refund-requests`): requested, not executed; shows the gateway's
  refund capability;
- **Listings to review**, **Admins**, and payout batches on **Payouts**.

The UI computes nothing: money is formatted from the API's strings.

### 6. Re-checking closed payments (gap 33)

`payment_gateway_checks` records, for each eSewa/Khalti payment that closed **without** money
(cancelled at hold expiry, replaced or failed), how often it was looked up and when it is next
due:

- **5 min, 65 min** (past Khalti's 60-minute link), **6 h and 25 h** after closing, then never
  again (`domain/gateway-recheck.ts`);
- the hold-release job runs `recheckClosedPayments` on every pass;
- a result is applied through the same decision as callbacks (ADR 0017): money found is recorded
  in `payment_reconciliations` (unique per gateway transaction), never applied to the trip, and
  the payment is not looked up again;
- a gateway outage is not counted as a check and is retried 5 minutes later.

Gap 33 is narrowed to money that arrives after the 25-hour check, or during an outage longer than
the window.

### 7. Test infrastructure

E2E runs every browser from one machine. The API's per-client login limit (30 per 15 minutes,
ADR 0014) is real and every attempt counts, so a growing suite exhausted it. Two measures:

- `AUTH_LOGIN_PER_IP_LIMIT` raises that one limit. It is **refused in production**; the E2E API
  sets 500, and the per-email limit (10) is never changed.
- The Phase 12 journeys share one admin and one partner login per project.

## Consequences

- MeroStay can pay providers, admins can be managed without SQL, wrong bookings can be voided
  safely, and listings can go live. Every step is audited, idempotent and backed by the database.
- New money columns are BIGINT with CHECKs (`*_minor` count 23 → 26). Every new amount reaches
  the API as a digit string with its currency.
- **Residuals:**

  | Gap | What remains | Target |
  |---|---|---|
  | 10 | Sequential invoice numbers, payment terms (tax advisor) | Unchanged |
  | 35 | Commission invoices are never marked paid (invoice payment tracking) | New |
  | 36 | Pay-at-property settlements are not reconciled against provider reports (the reconciliation half of 13) | New |
  | 37 | Setup links are not emailed | Notifications, Phase 16 |
  | 38 | Edits to an approved listing are not re-reviewed (owner decision) | New |
  | 39 | Paid-out bookings cannot be voided (clawback) | Phase 14 |
  | 31 | Refund execution | Phase 14 |

- A changed bank account blocks payouts until an admin verifies it. This is deliberate: it is the
  fraud-sensitive moment.
