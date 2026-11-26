# Phase 12: Payouts & admin moderation

- **Status:** complete, awaiting owner review.
- **Branch:** `phase/12-payouts-admin-moderation`
- **Date:** 2026-11-26

## Scope (as approved)

The owner's brief asked for backend, frontend, tests and docs for:

- **Gap 16:** payout execution as a manual transfer, recorded.
- **Gap 9:** admin account management.
- **Gap 13:** correction and void.
- **Gap 15:** listing approval that re-checks the listing-type rule.
- **Gap 34:** admin screens for late payments and refunds.
- **Gap 33:** a reconciliation mechanism.

**Not built (confirmed):**

- automated payout or bank APIs;
- refund execution (shape and queue only);
- reviews, notifications;
- OAuth, 2FA, email verification and reset;
- live gateway changes.

Phase 13 has not been started.

**Owner decisions (asked at the start, 2026-11-26):**

| Question | Answer |
|---|---|
| Roadmap numbering (Admin moderation was Phase 13) | **Shift up by one:** 12 this phase, 13 Search UX, 14 Cancellations & refunds, 15 Reviews, 16 Notifications, 17 Hardening. Refund execution and the refund clock reference are therefore **Phase 14** (the brief said 15) |
| Payout eligibility and period | **After the service, monthly:** eligible once the service has ended (Nepal time) and it was not cancelled; one payout per provider and calendar month of the service date |
| First password of a new admin | **One-time setup link** (hashed, 24 h), shown once to the creating admin; the email gap is documented |
| Voiding an item whose commission was already invoiced | **Waive it, mark the invoice:** commission WAIVED plus an audited invoice adjustment; the issued invoice is never edited |

## What was built

Details and reasons: [ADR 0018](../architecture/decisions/0018-payouts-and-admin-moderation.md);
endpoints: [api.md](../architecture/api.md#payouts-admin-accounts-and-moderation-phase-12-adr-0018).

- **Payout batches (gap 16).**
  - **Steps:** generate per month (idempotent; per-month advisory lock) → schedule → mark paid
    (bank reference) or failed (items released for the next batch).
  - **Eligible items:** paid online, not cancelled, last service date before today in Nepal, no
    open refund request.
  - **Amounts:** net = gross − commission (CHECK).
  - **Scheduling:** needs a verified default bank account and snapshots its masked label. The
    reference is stored, but only ever returned and audited masked (last 4).
  - **Partners:** see their own batches only (404 otherwise).
  - **Database guards:** batches are kept and move forward only; sums equal the items when
    scheduled; items are fixed once scheduled; an item is paid out only through a paid batch; one
    open batch per provider, month and currency.
  - **Bank accounts:** provider approval already verifies the default account, but an account
    changed after approval had no way back to verified. New `…/payout-account/verify` (audited)
    covers that, so payouts cannot go to an unchecked account.
- **Admin accounts (gap 9).**
  - Adding an admin creates the account without a password and returns a one-time setup link.
    The link holds 32 random bytes; only their SHA-256 is stored; it lasts 24 h and works once.
    The token is in the URL fragment, and the setup page is `no-referrer` and not indexed.
  - The link can be reissued; admins can be suspended (which ends their sessions) and reactivated.
  - Not yourself, and never the last usable admin: refused by the service and by the
    `users_keep_an_admin` trigger, with an advisory lock so two admins cannot suspend each other at
    once. Everything is audited.
  - The public `POST /auth/admin-setup` is rate limited.
- **Listing review (gap 15).**
  - A queue with a type-rule hint; approve publishes the listing; reject needs a reason, which the
    partner sees (`review.note`).
  - **Approval re-checks the listing-type rule (ADR 0013)** in the service (`422
    LISTING_TYPE_NOT_ALLOWED`, nothing changed) and in the database
    (`listings_approval_type_rule_chk`).
- **Voids and corrections (gap 13).**
  - Void an item, or every voidable item of a trip: CANCELLED, held inventory released, out of an
    open payout batch, commission WAIVED.
  - Online money becomes refund REQUESTS (one per allocation, not executed).
  - Invoiced commission becomes an append-only `provider_invoice_adjustments` row; the invoice
    becomes VOID when fully adjusted and is never edited.
  - Trip totals and status are recalculated, and open intents are cancelled.
  - Undo a pay-at-property settlement recorded by mistake. Snapshots are never edited.
  - All of it audited and idempotent.
- **Admin queues (gap 34).** Web pages: late payments (handle with a note), refund requests (not
  executed, gateway capability), listings to review, admins, and payout batches on Payouts.
- **Gap 33.** `payment_gateway_checks`: each eSewa/Khalti payment that closed without money is
  looked up again at 5 min, 65 min, 6 h and 25 h, by the hold-release job. Money found is recorded
  for reconciliation through Phase 11's decision, never twice. An outage is not counted as a check
  and is retried 5 minutes later.
- **Web.** The payout summary texts no longer say "not executed". A partner's payouts page shows
  their transfers, reference masked.
- **Refactors (behaviour unchanged):**
  - trip-totals recalculation is shared from `trips.repository.ts`;
  - the per-client limiter moved to `lib/limit-per-client.ts`;
  - the sample seed's guide item is now "paid, not yet paid out" (the new guard refused its old
    impossible state).

### Migration

`20261126200000_payouts_and_admin_moderation` (new; no applied migration edited):

- **Payouts:** rename `PROCESSING` → `SCHEDULED`; add amounts, item count, period, who/when, the
  masked account label and failure columns, CHECKs, a partial unique index, `payouts_guard` and
  `booking_items_payout_guard`.
- **Voids:** `booking_items` void columns with a CHECK; `provider_invoice_adjustments` with its
  guard.
- **Listings:** review columns, a CHECK and `listings_approval_type_rule`.
- **Admins:** `admin_setup_tokens` and `users_keep_an_admin`.
- **Re-checks:** `payment_gateway_checks`.
- `*_minor` columns 23 → 26, all BIGINT. Drift check on a fresh database: no difference.

## Verification (real results)

| Check | Result |
|---|---|
| `format:check`, `lint`, `typecheck` (API, web, e2e), `build` | Pass |
| API unit | **343/343** (327 + 16 new) |
| Web unit | **102/102** (97 + 5 new) |
| API integration, disposable PostgreSQL 17 (local) | **293/293**, 20 files (258 + 35 new: payouts 12, moderation 11, admin accounts 9, gateway re-checks 3), twice |
| E2E local (booking mode) | **40/40** (30 + 10 new), with default, 1 and 8 workers |
| Commit 1 on its own (separate worktree) | format, lint, typecheck pass; API unit 327, web unit 97, integration 258/258 (17 files), E2E 30/30 |
| `npm audit` | 0 vulnerabilities |
| CI on `9dac3e8` (code commits) | Run `45859421658`: `verify` ✔ (format, lint, typecheck, unit, integration, build), `e2e` ✔ |
| **Neon integration (end of phase)** | **20/20 files, 293/293 tests**, 3,200.99 s, exit 0 (attempt 1, on committed `9dac3e8`, below) |

### Cases

| Case | Level | Result |
|---|---|---|
| Not eligible before the service is over | Integration + unit | A batch for the month is created only after the service: none today, one each for bus and guide after the clock jump. Edge: the last night is not "over" |
| Amounts | Integration + unit | Bus 2 × Rs 1,800: gross 360000, commission 54000, net 306000 paisa; the guide matches its item; the pay-at-property room is never batched; sums beyond 2^53 are exact |
| Repeated and concurrent generate | Integration | 3 concurrent runs: same batches, same counts, one audit row |
| Schedule needs a verified account | Integration | `409 PAYOUT_ACCOUNT_NOT_VERIFIED`; verify (idempotent, masked, no number in the body); scheduled with the label `Nabil Bank · ••••4321`; a repeat is a no-op |
| Mark paid | Integration + E2E | PAID, items paid out, commission PAID; the same reference twice (also concurrently) is a no-op; another reference is a 409; audit shows `••••7788`, never the reference |
| DB guards | Integration | Changing a scheduled batch's money, unlinking its items, deleting a batch, changing a paid reference, moving back to PENDING, paid out without a paid batch: all refused |
| Failed transfer | Integration | FAILED (reason required), items released, picked up by a new batch; mark-paid then 409 |
| Partner scoping | Integration + E2E | Own batches with items; the same owner's other business and another partner: 404; customer 403 |
| Admin accounts | Integration + E2E | Setup link once (no password before it), short password 400, reuse/expired/unknown/reissued old link 400, login after setup; email in use 409 (nothing promoted); suspend ends sessions (401), login 403, reactivate; self-lockout 409; last-admin trigger (suspend, demote, clear password) refused in a rolled-back transaction; non-admins 403/401; no hash or token in any response or audit row |
| Listing review | Integration + E2E | Hidden → approved → public in detail and search; audit; rejection needs a reason (the DB too); **a bus operator's hotel room is refused (422 `LISTING_TYPE_NOT_ALLOWED`, details name the allowed `bus_ticket`) by the API and the database**, nothing changed, no audit; non-admins 403/401 |
| Voids | Integration + unit | Paid bus item: seats back (−2), commission WAIVED, one refund REQUEST = its allocation, no REFUND payment, trip total = the room; repeat and concurrent voids change nothing; invoiced room: adjustment = its commission, invoice VOID (amount and number unchanged), trip CANCELLED; adjustments append-only; trip void releases the guide day; completed → 409; customer 403; unknown 404 |
| Settlement correction | Integration | PAID_AT_PROPERTY → PAY_AT_PROPERTY, who/when cleared, money unchanged; repeat no-op; an online item → `409 ITEM_NOT_SETTLED` |
| Gap 33 re-check | Integration + unit | Paid on Khalti after the hold closed, never returned: not due at 1 min; recorded at 6 min (`PAYMENT_NOT_OPEN`, 360000, no allocation); never again. Unpaid: checks 1 → (not due at 10 min) → 2 at 66 min, next at 6 h. Outage: not counted, retried in 5 min |
| Admin queues | E2E + web unit | Late payment handled with a note (moves to Handled); its refund request shows "Requested (not executed)"; a partner gets "Page not found" for the admin pages |
| Money at the boundary | Integration | Every response's money is a digit string with its currency (4 files) |

### What testing found (fixed before committing)

- **The E2E suite exhausted the API's real per-client login limit** (30 per 15 minutes, every
  attempt counts). All browsers come from one address, and the new journeys tipped older mobile
  journeys into failing at `/login`. Two fixes, without weakening any test:
  - the Phase 12 journeys share one admin and one partner login per project;
  - a tests-only `AUTH_LOGIN_PER_IP_LIMIT` (refused in production, unit-tested; per-email
    unchanged) lets the E2E API raise that single limit.
- **Mobile:** the payout table's "Open" button, in the last column of a sideways-scrolling table,
  was covered by another cell on a Pixel 7. The provider name in the first column is now the
  button (pages must work from 360 px).
- The seed held an item "paid out" with no payout. The new guard refused it, so the seed now
  models "paid, not yet paid out".
- `admin_setup_tokens_expiry_chk` was `>`: reissuing a link within the same millisecond would have
  failed. It is now `>=`.
- The demoted-admin test of Phase 5 demoted the only admin, which the new rule refuses; it now
  creates a second admin first.

## Neon integration run (end of phase)

Command: `caffeinate -i npm run test:integration` on committed code `9dac3e8` (all code committed;
the working tree held only docs), against the Neon test branch from `apps/api/.env.test` (no URL
printed).

| Attempt | Started (UTC) | Result |
|---|---|---|
| 1 | 16:30:48 | **Clean: 20/20 files, 293/293 tests passed**, 3,200.99 s (about 53 min), exit 0, ended 17:24:10. No stalls, no connection or timeout errors, no retries |

The same 293 tests pass locally on PostgreSQL 17 and in CI `verify` (run `45859421658`).

## Operational gaps

- **Closed:** 16, 9, 13 (correction), 15, 34.
- **Narrowed:** 33 (now only money after the 25-hour check, or during an outage longer than the
  window; daily statement comparison in Hardening, Phase 17).
- **New residuals:**
  - 35: invoice payment tracking;
  - 36: settlement reconciliation (the reconciliation half of old 13);
  - 37: setup links by email (Notifications, 16);
  - 38: edited approved listings are not re-reviewed (owner decision);
  - 39: paid-out bookings cannot be voided (Cancellations & refunds, 14).
- **Still open as the brief asked:** 31 (refund execution, now Phase 14), 32 (production merchant
  accounts), 4, 26, 29, 30. Gap 10 (invoice numbering) still waits for the tax advisor.
- **Refund clock reference:** deferred to Cancellations & refunds (**Phase 14** after the shift).
- **Open, 23:** 1–4, 6, 10, 12, 17, 20, 24, 26–33, 35–39. **No launch blocker.**
- The launch checklist gains "an admin exists" and "no `AUTH_LOGIN_PER_IP_LIMIT`".

## Commits

| Hash | Message |
|---|---|
| `c84950c` | feat(api): payout batches, admin accounts, listing review, voids and closed-payment re-checks |
| `ce97565` | test(api): payouts, admin accounts, listing review, voids and closed-payment re-checks |
| `9dac3e8` | feat(web): payout, listing review, admin and queue screens; E2E admin journeys |
| (this commit) | docs: record Phase 12 payouts and admin moderation, ADR 0018, gaps closed, roadmap shift |

Commit 1 includes the existing tests that had to change with it (new tables, the BIGINT count,
the last-admin rule) and the seed fix, so it builds and passes on its own (separate worktree,
above).

## Security checklist

- **Admin only and audited:**
  - every new admin endpoint needs role ADMIN (403 before any read) and CSRF;
  - every write is audited and idempotent;
  - partners see their own payouts only (404).
- **Never exposed:** password hashes, setup tokens, full bank references and account numbers,
  in responses and audit rows (tests check).
- **Money:** `bigint` paisa; digit strings at the boundary; new money columns BIGINT with CHECKs;
  the UI computes nothing.
- **Database invariants:** every money formula, transition and link is re-checked by a trigger or
  CHECK.
- **Unchanged:** sessions, CSRF, rate limits (except the tests-only, production-refused login
  setting), money rules.
- **Secret scan** before every commit: no real value in any diff. Keyword hits were code names, test passphrases, random
per-run E2E passwords, a fake token and obviously fake bank numbers in the disposable E2E world.

## Known limitations / follow-ups

- **New residual gaps:** 35–39 (above).
- **First admin:** still bootstrapped in SQL (README).
- **Payout batch row:** shows a provider's batches across all months; a provider with many months
  pages through them.
- **Void UI:** voids and settlement corrections are API-only in the console. The brief asked for
  UI for the queues, payouts and listing review; a void screen fits Cancellations & refunds.

## How to review

1. Read [ADR 0018](../architecture/decisions/0018-payouts-and-admin-moderation.md) and the
   migration.
2. `npm run dev` with an admin. In the console:
   - **Listings to review:** approve or reject (the partner sees the reason);
   - **Payouts:** prepare last month → open a batch → schedule → record paid;
   - **Late payments** and **Refund requests**;
   - **Admins:** add one, open the setup link in another browser.

   The seed's October guide booking is eligible; its provider has no bank account in the sample
   data, so scheduling shows "not verified" until the partner adds one and an admin verifies it
   on the provider page.
3. `E2E_DATABASE_URL="postgresql://…disposable…" npm run test:e2e:booking`.
