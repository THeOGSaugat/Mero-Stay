# Known operational gaps before launch

Things that work in development but **must be closed before MeroStay takes real bookings**. Each
has an owner phase on the [roadmap](roadmap.md). Remove an entry only when it is done and tested.

Phase numbers follow the [roadmap](roadmap.md) (renumbered in Phase 5, adjusted in Phase 6, and
shifted by one in Phase 9, when rate limits behind the proxy and E2E in CI became Phase 9).
Phase 8 was narrowed by the owner to gaps 22 and 25; the rest of the old "admin approvals &
moderation" scope (gaps 9, 13 correction, 15) is not yet scheduled.
From Phase 6 on, gap numbers are stable: a closed gap moves to "Closed" and its number is not
reused.

| # | Gap | Effect today | Closed in |
|---|---|---|---|
| 1 | **No email verification.** Accounts are usable immediately; the email address is not confirmed. | Typos and fake addresses can register; booking confirmations may go to the wrong inbox. | Notifications phase (Phase 16), with Amazon SES. |
| 2 | **No password reset.** A user who forgets their password cannot recover the account. | Support must handle it manually. | Notifications phase (Phase 16): reset tokens sent by email/SMS (Sparrow SMS). |
| 3 | **No two-factor authentication.** | Account takeover relies on the password alone (mitigated by Argon2id, rate limits, 12-character minimum). | Hardening phase (Phase 17); at least for admins and partners. |
| 4 | **Rate limits live in process memory.** Since Phase 9 they are per client behind the proxy (ADR 0014); the counters are still per process. | Correct for one API instance, which is the deployment today (not a launch blocker for a single-instance launch). With several instances each has its own counters (limits multiply); restarting resets them. | Before running more than one instance (Hardening, Phase 17): a shared store such as Redis. |
| 6 | **Expired sessions and old idempotency keys are never cleaned up.** Sessions are deleted only when used after expiry; `idempotency_keys` rows (Phase 6) are kept forever. | Rows accumulate (harmless: expired sessions are never valid; old keys only replay their own result). | A cleanup step in the job runner (`src/jobs/`), e.g. keys older than 30 days; at the latest in Hardening (Phase 17). |
| 7 | **No live payment gateway.** Only the simulated test gateway exists, and it is refused in production. | In production online payment is unavailable (`503 PAYMENTS_UNAVAILABLE`); only pay-at-property bookings can complete. | Live gateways phase (Phase 12): eSewa and Khalti with server-to-server verification and signed callbacks. |
| 8 | **A real gateway can report success late**, after the trip's hold expired or the hold-release job released the items. | With the simulated gateway this cannot happen (confirm is refused after the hold, `409 TRIP_EXPIRED`). A real provider's money would arrive for released items. | Live gateways (Phase 12) with Cancellations & refunds (Phase 13): accept the callback, record the payment, then re-book or refund it. |
| 9 | **Admins are created by SQL; no admin user management.** (The audit-log half of this gap closed in Phase 6.) | An operator grants or removes `ADMIN` with an `UPDATE` statement, outside the audit log. | Admin moderation (the rest of the original Phase 8 scope; not yet scheduled, the owner sets the phase): grant/revoke ADMIN through audited endpoints. |
| 10 | **Invoice numbering and payment terms are not implemented yet** (owner decisions recorded below). Numbers are still `INV-YYYYMMDD-<random>`; `due_on` is empty. | Invoices exist and are correct, but may not meet Nepal's tax-invoice rules (sequential numbers) and have no due date. | Commission & payouts phase (Phase 14): implement the decisions below after the tax advisor confirms the numbering rules. |
| 12 | **`db:seed` relies on the caller to target the right database.** It inserts sample data into whatever `DATABASE_URL` points at, with no check. | A mistaken invocation could write sample data into a real or non-empty database (a near-miss in Phase 5: `npm run db:seed --dry-run` does not stop the script; the auto-mode guard blocked it). | A later phase (Hardening, Phase 17 at the latest): refuse to run against a non-empty or non-test database unless an explicit flag is given. |
| 13 | **Pay-at-property settlements are not reconciled or correctable.** Partners (and admins) can record "paid on arrival" (Phase 6), but nothing compares it with what providers report, and a mistaken settlement cannot be reversed. | A wrong settlement stays wrong unless fixed in SQL. Commission is still invoiced correctly either way. | Correction: Admin moderation (not yet scheduled), as an audited admin action. Reconciliation: Commission & payouts (Phase 14). |
| 14 | **Verification documents are not uploaded or stored by MeroStay.** The API records metadata and an opaque private storage key; it does not receive the file, check its magic bytes or strip metadata. | Admins cannot open a document through MeroStay yet; the key is whatever the client sent. Since Phase 7 Track B the partner UI records the chosen file's type and size only, with a `not-uploaded/<uuid>` key, and says on the page that the file stays on the device (ADR 0011). | Listing media & documents (Phase 10): private object storage, upload endpoint, MIME sniffing, EXIF stripping (security guidelines §6). |
| 15 | **Listings cannot be approved through the API.** Partners can create listings and submit them (`PENDING_REVIEW`); there is no admin approval endpoint yet. | Partner-created listings never become public without an operator update in SQL. | Admin moderation (not yet scheduled): listing review queue with approve/reject, audited (before approval it should also re-check the listing-type rule, ADR 0013). |
| 16 | **Payouts are not executed.** Partners and admins see a read-only payout summary (Phase 6); no `payouts` rows, transfers or payout statements are created. | MeroStay holds online payments with no way to pay providers through the system. | Commission & payouts (Phase 14), after the owner decides the payout schedule. |
| 17 | **Bank account numbers are stored in plain text.** They are never returned in full (masked in every response and audit row, Phase 6), but the column is not encrypted at application level. | A database leak would expose account numbers (Neon encrypts at rest). | Before launch (Hardening, Phase 17): decide and apply application-level encryption (security guidelines §9). |
| 20 | **No location picker in customer search.** Search takes a location slug (`pokhara`, `kaski`). Since Phase 7 Track B the API has a read-only `GET /locations` (one level per request, owner approved) and partner listing forms use a Province → District → City/Area picker; customer search does not use it yet. | Customers type a place name; an unknown one shows "We don't know that place yet". | Search UX & locations (Phase 11): the picker (or type-ahead) in customer search. |
| 23 | **No cancellation-policy management.** Partners cannot create or choose a cancellation policy (no endpoint lists them); listings created in the partner UI have none, so their bookings carry no policy snapshot. | Bookings of partner-created listings show "No cancellation policy was attached"; cancellation terms are unclear until policies exist. | Listing media & documents (Phase 10, "cancellation-policy management"), with the owner's policy presets (requirements §6 open details). |
| 24 | **A partner with several businesses chooses one again after every reload.** The choice (`X-Provider-Id`) is kept in memory only (ADR 0011). | A minor inconvenience for multi-business partners; nothing is mis-scoped (the API decides). | Revisit with partner feedback (no phase assigned; at the latest Hardening, Phase 17). |

## Owner decisions on invoicing (recorded 2026-11-21, after Phase 5)

| Topic | Decision | Status |
|---|---|---|
| Invoice numbering | **Sequential numbering is deferred to the tax advisor / finance phase.** The design must support **gap-free sequential numbers per fiscal year** (e.g. a per-fiscal-year counter allocated in the same transaction that issues the invoice, never reused after a void). | Open (gap 10). Today: `INV-YYYYMMDD-<random>` |
| Payment terms | **Default Net 15** (due 15 days after issue). This is a placeholder until finance confirms it. | Not applied yet: `due_on` stays empty until the finance phase |
| Invoice cadence | **One invoice per trip** (per provider within the trip), as built in Phase 5. | Done (ADR 0007) |
| Payout schedule | **Deferred to the payouts phase.** | Open (Commission & payouts, Phase 14) |

## Development and verification constraints

Not launch gaps, but limits on how the project is verified today.

- **Neon integration runs need a stable connection and an awake machine.** The suite is
  latency-bound: every API call is several sequential round trips to Neon (about 100–300 ms each).
  A clean full run takes about **25–28 minutes** (Phase 6: 1,548.77 s for 179 tests). If the
  connection drops or the Mac sleeps, setup fails with `P1001 Can't reach database server`, or tests
  crawl and fail. Phase 6 needed four runs for this reason; the code passed on the clean run
  (see the Phase 6 report).
- **How to run it reliably:** on mains power, lid open, stable Wi-Fi, with someone at the machine:
  `caffeinate -i npm run test:integration`. `caffeinate -i` keeps macOS awake only while that
  command runs. Stop the run if the connection drops rather than letting it crawl.
- **Known constraint: Neon runs are flaky, and one stall cascades (recorded in Phase 9, owner
  accepted).**
  - **The cause:** the suite is latency-bound, and a transient connection stall can hold one
    request for minutes.
  - **Why one stall fails many tests:** some files are written as one continuous scenario
    (`partner-admin.integration.test.ts`), so each test builds on the previous one. One stalled
    request fails its test, and every later step in that file fails too, although nothing is
    wrong with the code.
  - **What happened in Phase 9:**
    - Attempt 1 lost the test endpoint mid-run (`28000` endpoint not found; the owner recreated
      the branch).
    - Attempt 2 took 41 minutes, with one request stalled for about 12 minutes: 1 timeout and 9
      dependent failures, all in `partner-admin`, which had passed 22/22 on Neon in attempt 1 on
      identical code.
  - **What to do:** re-run on a stable connection with the machine awake (below). Read a failure in
    a scenario file from its **first** failing test; the rest usually follow from it.
  - **What not to do:** don't weaken tests, raise timeouts or add retries to hide it. A stalled
    request must still fail the run.
  - **The real fix (not scheduled):** the owner's speedup note below. Seeding setup directly
    shortens the window a stall can hit, and so does running the full Neon suite only on release
    tags, while local PostgreSQL and CI stay the per-change gate.
- **CI is not affected:** it uses a local PostgreSQL service container (fast, no network).
- **Future speedup (owner's note, not scheduled):** seed test setup directly with Prisma where the
  setup itself is not under test, and run the full Neon suite only on release tags.

## Closed

| Gap | Closed in | How |
|---|---|---|
| Trips used a temporary `userId`; no ownership; commission/payout visible to callers | Phase 4 (ADR 0006) | Session authentication; owner from the session; other users' trips are 404; customer view hides commission/payout |
| The trips API was off by default (opt-in flag) until auth existed | Phase 4 (ADR 0006) | Flag removed entirely; trips always require a session |
| `INVOICED` commission had no invoice record | Phase 5 (ADR 0007) | Trip confirm issues one invoice per trip and provider in the same transaction and links the items. The database refuses `INVOICED` without an invoice, a second live invoice for the same trip and provider, and an issued amount that differs from the items' commission. Tests prove: created exactly once with the right amount, no-op on retry, one invoice under three concurrent confirms |
| The hold-release job was not scheduled | Phase 5 (ADR 0007) | `npm run jobs:hold-release` (cron/platform scheduler, once) and `jobs:hold-release:watch` (worker; started by `npm run dev`), documented for dev and production. Tests prove: the loop releases abandoned holds on schedule; confirmed, paid and partly paid bookings keep theirs; four concurrent runs release each hold exactly once |
| No persistent admin audit log (gap 9, first half) | Phase 6 (ADR 0008) | Append-only `audit_log` table written in the same transaction as each admin write and sensitive partner write; secrets redacted in code and refused by a CHECK; UPDATE/DELETE refused by a trigger; `GET /admin/audit-log`. Tests prove: each action writes exactly one row with the right actor/action/entity, repeats write none, no secrets in any row, non-admins are refused |
| Only admins could record a pay-at-property settlement (gap 11) | Phase 6 (ADR 0008) | `POST /partner/bookings/:itemId/settle-at-property`: own provider only (404 otherwise), Idempotency-Key required, who/when recorded on the item (CHECK), audited once. Tests prove: three concurrent retries apply once with one audit row; another partner gets 404. What remains is gap 13 |
| No required-documents checklist per provider type (gap 18) | Phase 7 (ADR 0009) | Data-driven `provider_type_required_documents` (groups: any one type satisfies a group, so hotels and homestays share the `hotel` type), seeded from requirements §6.2. Enforced at verification submit and again before an admin approves (`409 REQUIRED_DOCUMENTS_MISSING` with the missing groups). Tests prove: an owner ID alone is refused for a hotel; approval of a tour operator missing registration and PAN is blocked, unchanged and unaudited; homestay registration satisfies the group; rejected documents never count |
| The `airline` provider type was offered at onboarding (gap 19) | Phase 7 (ADR 0009) | `provider_types.is_active` (airline set to false by migration; no provider-type name in code). Onboarding refuses inactive types (`422 PROVIDER_TYPE_NOT_OFFERED`); public `GET /api/v1/provider-types` lists active types only. Tests prove: the inactive type is absent and cannot be onboarded; toggling the flag exposes it and allows onboarding |
| Listing types not restricted by provider type (gap 22, launch blocker) | Phase 8 (ADR 0013) | Data-driven `provider_type_listing_types`, seeded by migration with the owner's mapping (homestays are the `hotel` type; `hotel` also lists its property; `activity_operator` → activity). Listing create and update require the pair to be mapped AND both types active: `422 LISTING_TYPE_NOT_ALLOWED` naming the allowed types (inactive listing type: `422 LISTING_TYPE_NOT_OFFERED`), nothing written; archiving always allowed. A trigger refuses any unmapped pair on every write path. Partner form offers only the allowed types; admin sees the rules read-only. Tests prove: bus operator → hotel room refused (also the property type), hotel and homestay → property + room succeed, tour operator → activity refused while inactive and allowed once active, airline → flight refused while the provider type is inactive and allowed when both are active, update of a no-longer-usable listing refused (archive allowed), type change refused, DB guard on insert and type change; a source scan proves no type name in app code (mutation-checked) |
| Admin lists did not scale (gap 25) | Phase 8 | `GET /admin/providers` takes `q` (names, owner email, type) and `sort` (newest default, oldest, name) with an `id` tie-breaker; invoices get `q` and newest-first; payouts get `q`; every page reports `totalPages`; the 100-provider dropdowns are replaced by search; audit actors show by name (loaded per page). Tests prove: 105 seeded providers page 50/50/5 with no overlap in the database's stable order, page 4 empty, each search field and filter combination, invoice and payout search, actor names and a system row, and a query count that does not grow with the page size |

See also: [README deployment notes](../../README.md#deployment-notes), [api.md](../architecture/api.md),
[ADR 0005](../architecture/decisions/0005-search-and-booking-api-conventions.md),
[ADR 0006](../architecture/decisions/0006-authentication.md),
[ADR 0007](../architecture/decisions/0007-payments-and-invoices.md),
[ADR 0008](../architecture/decisions/0008-partner-admin-and-audit.md),
[ADR 0009](../architecture/decisions/0009-provider-type-requirements.md),
[ADR 0010](../architecture/decisions/0010-web-frontend-architecture.md),
[ADR 0013](../architecture/decisions/0013-provider-type-listing-rules.md).
| Per-IP rate limits were one global limit behind the web proxy (gap 5, launch blocker) | Phase 9 (ADR 0014) | Verified that `next start` forwards a client's `X-Forwarded-For` unchanged and adds nothing. The production web server (`apps/web/server.mts`, `npm start`) now appends the connecting address; the API's `trust proxy` is a function, never `true`, trusting an entry only within `TRUST_PROXY_HOPS` and only from `TRUST_PROXY_ADDRESSES` (both required in production; `true`, `*`, `/0` refused). Limits are keyed per action by the resolved client IP (IPv6 per /64); the per-email login limit is unchanged; audit rows use the same IP. Tests prove (integration): client A exhausting its login budget does not 429 client B; rotating a forged header neither opens a new bucket through the proxy nor from an untrusted source; registration per client; 2-hop edge; IPv6 /64; audit IP. E2E: a forged header through the real web server never reaches the audit log (it did under plain `next start`). Mutation-checked. Residual: the in-memory store (gap 4) |
| The E2E journeys were not in CI (gap 21) | Phase 9 | CI job `e2e` (parallel to `verify`): its own PostgreSQL 17 container, no secrets; migrations and the test world seeded by Playwright's global setup; `npm run build` with `API_URL=http://localhost:4100`; the whole suite on desktop and mobile Chromium; HTML report and traces uploaded on failure; no retries (`retain-on-failure` traces). Green on push (run 45636903736: 20 passed). Proven to fail: a scratch branch renaming the "Add to trip" button failed the job at that click (run 45637352496, artifact uploaded) while `verify` passed; repeated without retries (run 45638124103): only the 2 broken journeys failed, 18 passed; scratch branches deleted. CI also exposed three order/timing dependencies between specs, fixed |
