# 0008. Partner and admin backend, audit log and idempotency keys

- **Status:** Accepted
- **Date:** 2026-11-22
- **Phase:** 06

## Context

Dashboards (later phases) need read/manage APIs for **partners** and **MeroStay staff**. Phases
4–5 gave us sessions, roles on `users.role`, owner-scoped trips, payments and commission
invoices. Before this phase:

- partners could not be created through the API, and nobody but an admin could record a
  pay-at-property settlement;
- admin actions were only in the request log;
- there was no general protection against a retried write applying twice.

## Decisions

### 1. Roles and how they are checked

| Role | Who | Gets |
|---|---|---|
| `CUSTOMER` | Travellers (every registration) | Their own trips and payments. May onboard as a partner |
| `PARTNER` | Providers (via onboarding) | `/partner/*` for **their own provider only** |
| `ADMIN` | MeroStay staff | `/admin/*`: read across all providers, trips and invoices; audited writes |

- The role comes from the `users` row loaded with the session on **every request**, so a change
  takes effect immediately.
- `requireRole(...)` runs **before any data is read**. A customer gets the same `403 FORBIDDEN`
  for every partner or admin URL, whether or not the resource exists. An admin is not a partner,
  so `/partner/*` is also 403 for them.
- Only onboarding grants `PARTNER` (CUSTOMER → PARTNER). No endpoint grants `ADMIN`: an operator
  sets it in the database. Partner/admin endpoints never return password hashes or session tokens,
  and never return other customers' trips. A partner sees a customer's **name only**; email and phone
  are **masked** (`s•••@e•••.com`, `+977••••••5678`).

### 2. Partner scoping: one acting provider per request, others are 404

The schema allows one user to own several providers (for example a homestay and a tour company).
`partner-context.ts` resolves the **acting provider** once per request:

1. If the user owns exactly one provider, that provider is used.
2. If the user owns several, the `X-Provider-Id` header picks one. Without the header the request
   is `400 PROVIDER_ID_REQUIRED`.
3. A provider id the user doesn't own, or one that doesn't exist, gets the same
   `404 PROVIDER_NOT_FOUND`.

Every partner query then filters by that provider id. Another provider's listing, slot, booking,
invoice or payout is a **404**, the same as one that doesn't exist (consistent with trips, ADR
0006). A suspended provider can read but not write (`403 PROVIDER_SUSPENDED`).

### 3. Onboarding and verification

1. `POST /partner/onboarding` creates a provider in `DRAFT`, and the user becomes a `PARTNER`.
2. The partner adds profile, payout account and documents.
3. `POST /partner/verification/submit` (DRAFT/REJECTED → `PENDING_VERIFICATION`) needs at least
   one pending document.
4. An admin decides: `approve` (provider `VERIFIED`, pending documents `APPROVED`, default payout
   account verified) or `reject` (reason required; provider and pending documents `REJECTED`).

The decision row-locks the provider and requires `PENDING_VERIFICATION`. A repeat or concurrent
second decision is `409` and writes no second audit row.

Further rules:

- **Legal and tax identity** (legal name, PAN, VAT, registration) can change only while the provider
  is DRAFT or REJECTED.
- **Documents.** There is no upload pipeline yet. The API stores metadata plus an **opaque private
  storage key** and refuses URLs; the MIME type and size are allow-listed. Real private upload
  (object storage, magic-byte check, EXIF stripping) is an operational gap.
- **Required documents** per provider type (requirements §6.2) are judged by the admin; the API
  does not enforce a checklist yet.

### 4. Bank details: stored, never returned in full

The account number is stored as before (application-level encryption is still a pre-launch
decision, security guidelines §9).

- Every response carries only `accountNumberMasked` (`••••9012`), and audit rows carry only that.
- A changed account replaces the default one and starts **unverified**: re-verification happens at
  the next admin approval.
- Sending the current account again changes nothing.
- A partial unique index allows one default account per provider.

### 5. Audit log (closes the admin-audit gap)

The new `audit_log` table holds: actor user and role, a dotted action, entity type and id,
before/after JSON, IP, request id and time.

- `recordAudit` runs **inside the transaction** that makes the change, so a committed change has
  exactly one row and a rolled-back change has none.
- **What is audited:**
  - every admin write: verification approve/reject, and the Phase 5 admin settle (now one row per
    call);
  - sensitive partner writes: onboarding, payout-account change, document submission, verification
    submit, settle at property.
  - Listing and slot edits are not audited (not sensitive). They can be added later with one line
    each.
- **No secrets, enforced twice:**
  - `redactForAudit` drops passwords, hashes, tokens and secrets at any depth, and replaces account
    numbers with their mask. Document numbers are not copied, only `hasDocumentNumber`.
  - A CHECK (`audit_log_no_secrets_chk`) refuses any row that still has a secret-looking key.
- **Append-only:** a trigger refuses UPDATE and DELETE.
- `GET /admin/audit-log` lists the log newest first, filters by actor, action, entity and date, and
  is paginated.

### 6. Idempotency keys

Clients may send `Idempotency-Key` (8–128 characters of `A–Z a–z 0–9 _ -`). It is **required** on
`POST /partner/bookings/:itemId/settle-at-property` and optional on partner creates (onboarding,
documents, listings).

- **Storage:** the key is stored per user with a SHA-256 fingerprint of scope + request, and the id
  of the resource the first request produced.
- **When it is claimed:** in the **same transaction as the write**, after the work. A failed request
  stores nothing and can be retried.
- **Concurrent requests with one key:** the loser's whole transaction rolls back on the unique
  (user, key) index, and it then replays the winner's result.
- **Replays** re-read the resource and answer with the original status and an
  `Idempotent-Replayed: true` header.
- **Reuse for a different request** is `422 IDEMPOTENCY_KEY_REUSED`. Only 2xx results are stored.
- **Writes that need no key** are idempotent by state:
  - settling an already settled item;
  - re-sending the same payout account;
  - creating slots that already exist with the same values;
  - an admin decision on a provider that is no longer pending (409).

### 7. Partner-side settlement

`POST /partner/bookings/:itemId/settle-at-property` uses the same rule as the admin path (shared
`settlement.ts`): `PAY_AT_PROPERTY → PAID_AT_PROPERTY`.

- It records **who and when** in the new columns `booking_items.payment_settled_by_id` and
  `payment_settled_at`. A CHECK ties both to `PAID_AT_PROPERTY`, so the admin path now records them
  too.
- Commission stays `INVOICED`; no money moves.
- It is the provider's own booking only (404 otherwise), needs an idempotency key, and is audited
  once.
- **Still open:** reconciliation (comparing what providers report against invoices), and reversing a
  mistaken settlement (an admin correction with an audit row).

### 8. Listings and inventory for partners

- **Listings:**
  - Create with type-specific details validated per listing type (`listing-details.ts`). Types
    without a detail table use `attributes` only, so a new vertical needs data and validation code,
    not endpoint changes.
  - New listings start as `DRAFT`. Partners may move them to `PENDING_REVIEW`, `ARCHIVED`, or back to
    `DRAFT` from archive.
  - **Approval is an admin action** (listing queues are the next admin phase).
  - Partners can't set `providerId` or `commissionRateBps`; both are rejected like any unknown field.
- **Slots:**
  - Create a date range (366 days at most). Existing identical slots are left alone; a different
    existing slot is `409 SLOT_EXISTS`.
  - Update a range. Capacity below what's booked is `409 CAPACITY_BELOW_BOOKED`. Under a race with a
    booking, the overbooking CHECK still refuses it (`409 INSUFFICIENT_AVAILABILITY`).

### 9. Payout summary (read-only)

`GET /partner/payouts` and `GET /admin/payouts` group online-paid items whose payout is still
pending by provider, service month and currency.

- They show subtotal, service charge, tax, total, commission and **`providerPayoutMinor` = Σ
  (total − commission)**. That is the Phase 2 formula, enforced by a CHECK: the provider receives the
  service charge and VAT collected for them, and VAT is theirs to remit.
- **Owner decision (confirmed after the Phase 6 review): the payout is `total − commission`**, the
  stored Phase 2 formula, not "subtotal − commission" (the wording in the original brief). The
  provider receives the service charge and VAT collected for them; VAT is theirs to remit.
  - Example, the hotel night in the tests: subtotal 3,50,000, service charge 35,000, VAT 50,050,
    total 4,35,050, commission 52,500 (15% of the subtotal), all in paisa. The **payout is
    382,550** (pinned by the integration test). The rejected formula would have given 297,500 for
    the same night.
  - For items without service charge or VAT (buses, guides) both formulas give the same number.
  - The integration test also checks `payout = total − commission` and `commission = 15% of the
    subtotal` on every summary row, against SQL.
- "Month" is a reporting grouping, not a payout schedule. Nothing is paid out, and each row says
  `executed: false`.

### 10. Invoice numbering and payment terms: designed, not applied

Per the owner's decision (see operational-gaps.md), nothing is applied yet. When the tax advisor
confirms the rule, the design is:

- a `provider_invoice_sequences(fiscal_year PRIMARY KEY, next_value)` table;
- the number is allocated with `UPDATE … SET next_value = next_value + 1 RETURNING` in the
  **same transaction that issues the invoice**, so there are no gaps from rollbacks and no
  duplicates under concurrency;
- `provider_invoices.fiscal_year` + `sequence_number`, with a unique pair; a void keeps its number;
- the Nepali fiscal year (starts 1 Shrawan, mid-July) needs a date conversion that the advisor
  must confirm.

**Net 15** stays a recorded placeholder; `due_on` stays empty. Both gaps remain open.

## Alternatives considered

- **One provider per partner account (unique `owner_user_id`):** simpler, but it doesn't fit owners
  with several businesses, and the sample data already has such an owner. The acting-provider
  header covers it at little cost.
- **Storing the full response body for idempotent replays:** it duplicates serialized money JSON
  and goes stale. Storing the resource id and re-reading it keeps one serializer.
- **Auditing in application logs only:** not queryable, not append-only, and easy to lose.
- **Database-generated audit rows (triggers on every table):** these can't know the actor or the
  reason without session variables through the pooler (PgBouncer transaction mode). Writing in
  application code inside the same transaction is explicit and testable.

## Consequences

- New migration `20261122090000_partner_admin_audit` (additive).
- Listing approval, provider suspension and admin user management remain admin work for the next
  admin phase.
- The open gaps are in operational-gaps.md: document storage, idempotency-key retention,
  reconciliation, invoice numbering and terms, payout execution, the live gateway, late gateway
  success, and seed safety.
