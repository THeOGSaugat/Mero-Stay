# Phase 06: Partner & Admin Backend

- **Status:** Awaiting review
- **Branch:** `phase/06-partner-admin`
- **Date completed:** 2026-11-22

## Scope (as approved)

The read and manage APIs that the partner and admin dashboards will use. Backend only.

**Not built:** UI, live gateway, refund or payout execution (no money movement), review
submission, notification sending, OAuth, 2FA, email verification and reset.

**Opening docs commit:** `fac1c2e` "docs: mark Phase 5 tagged, link invoice decisions, add
seed-safety gap", pushed to `main` (CI run `44984640652`, green).

## What was built

### Roles and scoping

- `/partner` requires `PARTNER` and `/admin` requires `ADMIN`. A wrong role gets `403` before any
  data is read.
- Onboarding (`POST /partner/onboarding`) is open to customers, who become partners.
- Each partner request acts for one provider the user owns (`X-Provider-Id` when they own several).
  Another provider's data is a `404`, the same as data that doesn't exist.

### Partner endpoints

- **Profile:** contact fields; legal and tax fields only while DRAFT or REJECTED.
- **Payout account:** stored, but only ever returned masked (`••••9012`). A change starts
  unverified and is audited.
- **Verification documents:** metadata plus an opaque private storage key; URLs are refused.
  Submit for verification once.
- **Listings:** create and update with per-type detail fields. Types without a detail table (for
  example `activity`) use `attributes` only, so a new vertical needs no endpoint change. A partner
  can't set `providerId` or the commission, and can't approve their own listing.
- **Slots:** create and update date ranges. Creating identical slots again changes nothing.
  Capacity below what's booked is a clean 409, and the overbooking CHECK still guards races.
- **Bookings:** items from submitted trips only. The customer appears by name, with email and phone
  masked.
- **Invoices** and a **read-only payout summary** (nothing is executed).
- **Settle at property:** requires an `Idempotency-Key`, records who and when, and is audited once.

### Admin endpoints

- Providers: list and detail.
- Verification `approve` / `reject`: under a row lock, applied once (a repeat is 409), one audit row
  each.
- Invoices, payout summary, and the audit log (filters and pagination).
- The Phase 5 admin settle now records who and when, and writes an audit row.

### Cross-cutting

- **Audit log:** `recordAudit` writes in the same transaction as the change. Secrets are redacted in
  code and refused by a database CHECK, and rows are append-only.
- **Idempotency keys:** `withIdempotency` claims the key in the same transaction as the write, so
  retries and races apply once. The same key with a different request is a 422.
- Pagination: `?page=&pageSize=` with `page.total`.

## Important technical decisions

The full record is in [ADR 0008](../architecture/decisions/0008-partner-admin-and-audit.md).

1. **Acting provider, not one provider per account.** The sample data already has an owner with two
   providers. `X-Provider-Id` selects one, and every query filters by it.
2. **403 for the wrong role, 404 for someone else's resource.** Role checks happen before any data
   is read, so existence never leaks.
3. **Audit rows are written by application code inside the transaction**, not by database triggers.
   Triggers can't see the actor through the pooler. The database still refuses secret keys and any
   UPDATE or DELETE.
4. **Idempotency stores the resource id, not the response body.** A replay re-reads the resource and
   uses the normal serializer. Writes where the request decides the final state are idempotent by
   state.
5. **Payout summary uses the stored `provider_payout_minor` (total − commission)**, confirmed by
   the owner (ADR 0008 §9).
6. **Invoice numbering and Net 15 terms:** designed in the ADR, not applied (per the owner's
   recommendation). Both gaps stay open.

## Migration

`20261122090000_partner_admin_audit` is additive only. No applied migration was edited.

| Change | Purpose |
|---|---|
| `audit_log` table, 4 CHECKs, append-only trigger | Audit trail with no secrets |
| `idempotency_keys` table, unique (user, key), 4 CHECKs | Retry-safe writes |
| `booking_items.payment_settled_at` / `payment_settled_by_id` + CHECK (set exactly when `PAID_AT_PROPERTY`) | Who and when of a settlement |
| Partial unique index `provider_payout_accounts_one_default_per_provider` | One default payout account |

Drift check: none ("This is an empty migration"). All 6 migrations apply cleanly from zero.

## Verification (real results)

| Check | Result |
|---|---|
| `format:check` / `lint` / `typecheck` / `build` | Pass, also for each commit on its own |
| Unit tests | API **209/209** (17 files), web 16/16 |
| Integration, throwaway PostgreSQL 17 | **179/179** (10 files) |
| **Integration, Neon `test` branch** | **179/179 (10 files), 1,548.77 s**, final observed run of the committed code (history below) |

### Neon verification history

Every run used the Neon `test` branch (`ep-dry-pine-…`), separate from dev (`ep-muddy-sunset-…`),
and the test-database guard passed each time. All runs except the diagnostic one tested the
unchanged committed code (`e8da40f`). One earlier run was stopped at the owner's request (owner
leaving for college) and is not counted.

| Run | Result | Cause / notes |
|---|---|---|
| 1 | **No tests ran** (11 s) | `P1001: Can't reach database server` during the global setup (`prisma migrate deploy`). Neon was reachable again about a minute later |
| 2 | **166/179** (1,543 s) | 13 failures, all in the new partner file, cascading from two requests that returned 500. Started 36 s after run 1's `P1001`. Server errors were not logged (the test logger is silent), so the cause is **unconfirmed; most likely dropped connections** |
| Diagnostic | **179/179** (1,689 s), zero 5xx | Full suite, with the partner file replaced (`--exclude`) by a copy that only adds error logging and 5xx printing. Same assertions. Not counted as the verification run |
| 3 | **2 passed, 19 failed, 158 skipped** (10,726 s, about 3 h) | `P1001` throughout; one test waited 982 s for a connection. The machine was unattended (likely sleep or Wi-Fi loss, not confirmed) |
| **4 (final)** | **179/179 (10 files), 1,548.77 s, exit 0** | Run with `caffeinate -i` on stable Wi-Fi with the owner at the machine. A watchdog checked Neon every 30 s and would have stopped the run after two failed checks; it never triggered. Started 2026-11-22 18:13:47, ended 18:40:04 |

No code, test or timeout was changed between runs. The Neon failures came from the environment,
not from the code.

### Per-commit checks (clean worktree, `npm ci`, PostgreSQL 17)

| Commit | API unit | Integration |
|---|---|---|
| `f406c08` partner backend | 194/194 | 158/158 |
| `84fcc02` admin backend | 194/194 | 158/158 |
| `e8da40f` tests | 209/209 | 179/179 |

The first version of the partner commit failed lint on its own: an unused `now` parameter, because
its only user arrives in the admin commit. Those commits were unpushed, so I amended that commit
and replayed the other two. The final tree is byte-identical, and all three commits now pass on
their own.

### What the integration tests prove

**Scoping**
- Partner B gets 404 on partner A's listing (GET and PATCH), slots, booking detail and settle.
- B's listing, booking, invoice and payout lists contain nothing of A's.
- A query-string `providerId` is rejected (400).
- Customers and admins get 403 on `/partner`; customers and partners get 403 on every `/admin` URL
  (also for providers that exist); anonymous requests get 401; a write without CSRF gets 403.

**Idempotency**
- Onboarding retried with the same key: 201, `Idempotent-Replayed: true`, the same provider, one
  audit row. The same key with a different body: 422.
- Documents and listings are retry-safe the same way.
- Settle needs a key (400 without). Three concurrent requests with one key: all 200, two replayed,
  applied once, one audit row. A new key on a settled item: 200, unchanged.

**Audit**
- Each action writes exactly one row with the correct actor, role, action and entity.
- Two concurrent approvals: 200 + 409, one row.
- Pagination and filters work (`page 2 of 4`, by actor and action), newest first.
- No row contains the bank number, password hash, session token, CSRF token or document number.
- The database refuses a row with a `passwordHash` key, and any UPDATE or DELETE.

**Masking**
- No response anywhere contains the full account number. Admin lists show `••••9012`.
- Partner booking views show "Sita Sharma", `s•••@e•••.com` and `+977••••••5678`.

**Inventory**
- Creating the same slots again is a no-op (200, 3 unchanged); different values give 409
  `SLOT_EXISTS`; a container listing gives 422.
- Capacity below what's booked gives 409 `CAPACITY_BELOW_BOOKED`; booking past capacity gives 409
  `INSUFFICIENT_AVAILABILITY`; the PATCH success path updates 2 slots.

**Payout math**
- Partner summary rows match SQL per service month (2 months).
- Commission = 15% of the subtotal, and payout = total − commission for every row. For example:
  subtotal "350000", commission "52500", total "435050", payout "382550".
- `executed: false` throughout. The admin summary is filtered by provider.

**Money boundary**
- More than 100 money fields across every response are digit strings, or `null` for an absent
  optional price.

**Regression**
- All Phase 2–5 suites pass. One intentional change: the schema test's table list gained
  `audit_log` and `idempotency_keys`.

### Mutation checks (code broken on purpose, then restored)

| Mutation | Caught by |
|---|---|
| Partner booking read without the provider filter | Scoping test fails (another partner sees the booking) |
| Bank number returned unmasked | 10 integration tests fail |
| Admin decision without its audit row | 3 tests fail |
| Settle without idempotency-key storage | Idempotency test fails. Retries still applied once, because a settled item is unchanged; the key adds an identical replayed response |

Unit tests also show that a payout amount serialized as a number is caught by the money-boundary
check.

## Security checklist

- [x] No secrets in any diff (all staged diffs scanned; only test fixtures and redaction code matched)
- [x] No new configuration; `.env.example` is unchanged
- [x] Every new endpoint: session, strict Zod validation, role check before data access, provider scoping, CSRF on writes
- [x] No password hash, session token or full bank number in any response or audit row (asserted)
- [x] Partners never see customers' email or phone, or other customers' trips

## Operational gaps

**Closed:**
- the persistent admin audit log (first half of gap 9);
- admin-only pay-at-property settlement (gap 11).

**Updated:**
- gap 6: idempotency-key retention added;
- gap 9: now admin user management only.

**New:**
- 13: settlement reconciliation and correction;
- 14: document upload and storage;
- 15: no listing approval endpoint;
- 16: payout execution;
- 17: bank numbers not encrypted at application level.

**Still open:** invoice numbering and terms (10), live gateway (7), late gateway success (8), seed
safety (12), and gaps 1–5.

Gap numbers are now stable. See [operational-gaps.md](../development/operational-gaps.md).

## Open questions for the owner

1. ~~**Payout formula.**~~ **Decided by the owner after review:** payout = `total − commission`
   (the stored, CHECK-enforced formula), recorded in ADR 0008 §9. For the hotel night in the tests
   that is 382,550 paisa (pinned by the integration test); the rejected `subtotal − commission`
   would have been 297,500. For buses and guides both formulas agree.
2. **Required documents per provider type** (requirements §6.2): left to the admin's judgement for
   now. Should the API enforce a checklist (next admin phase)?
3. **Airline providers:** onboarding accepts any provider type, including `airline`. Flights are not
   offered (listing creation refuses `flight_ticket`). Should `airline` be hidden from onboarding?

## Known limitations / follow-ups

- Listing approval, provider and listing suspension, admin user management and settlement
  corrections: the next admin phase.
- Document files are not uploaded (gap 14). Admins see metadata and the storage key only.
- Neon integration runs are slow (about 20 minutes), as noted for later optimisation.
- `npm audit`: 0 vulnerabilities (the `effect` override from Phase 5 still applies).

## Commits

| Hash | Message |
|---|---|
| `fac1c2e` (on `main`) | docs: mark Phase 5 tagged, link invoice decisions, add seed-safety gap |
| `f406c08` | feat(api): add partner onboarding, profile, listings, inventory, bookings and settlement |
| `84fcc02` | feat(api): add admin provider verification, invoices, payouts and audit log |
| `e8da40f` | test(api): cover partner scoping, admin audit and settlement idempotency |
| (this commit) | docs: record Phase 6 Neon verification and final report |

CI: `e8da40f`, run `44986524577`, **success**.

## How to review

1. Read [ADR 0008](../architecture/decisions/0008-partner-admin-and-audit.md) and the partner/admin
   sections of [api.md](../architecture/api.md#partner-endpoints-adr-0008).
2. Run `npm test` and `npm run test:integration` (wipes the TEST branch).
3. Locally: register, `POST /api/v1/partner/onboarding`, then use the partner endpoints. Promote a
   user to ADMIN in SQL for the admin endpoints.
