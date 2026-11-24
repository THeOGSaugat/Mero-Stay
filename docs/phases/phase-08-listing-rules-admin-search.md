# Phase 08: Listing rules & admin lists

- **Status:** complete, awaiting owner review. End-of-phase Neon run: **200/200** (attempt 2,
  after the owner updated the test-branch password; see below).
- **Branch:** `phase/08-listing-rules-admin-search`
- **Date:** 2026-11-24

## Scope (as approved)

Close **gap 22** (data-driven provider-type → listing-type rule) and **gap 25** (admin search,
ordering, paging beyond 100, actor names): backend, frontend, tests and docs. Nothing else.

**Not built (confirmed):**

- live payment gateway, refunds, payout execution;
- reviews, notifications;
- OAuth, 2FA, email verification and reset;
- cancellation policies (gap 23), document uploads (gap 14), E2E in CI (gap 21);
- admin account creation (gap 9), multi-business persistence (gap 24).

Phase 9 has not been started.

**Owner decisions (asked at the start, 2026-11-24):**

- homestays stay the `hotel` provider type (no new type);
- `activity_operator` → `activity`;
- `hotel` also lists its property (`hotel`) as well as `hotel_room`.

## What was built

### Gap 22: listing rules (ADR 0013)

| Part | What |
|---|---|
| Migration `20261124090000_provider_type_listing_types` (additive) | Table `provider_type_listing_types`, seeded: `hotel` → hotel, hotel_room · `bus_operator` → bus_ticket · `airline` → flight_ticket · `guide` → guide_service · `tour_operator` → tour, activity · `activity_operator` → activity. Trigger `listings_listing_type_allowed_chk` refuses any listing with an unmapped pair (on insert and when the type or provider changes) |
| API enforcement | Create and update need the pair mapped **and** both types active (`domain/listing-rules.ts`). Inactive or unknown listing type → `422 LISTING_TYPE_NOT_OFFERED` (unchanged). Unmapped pair, or inactive provider type → **`422 LISTING_TYPE_NOT_ALLOWED`** with `allowedListingTypes`. Nothing is written. Archiving is always allowed; the type itself can't be changed (400) |
| Why 422 | The request is well-formed but breaks a business rule; it isn't a state conflict (409). It matches the neighbouring `LISTING_TYPE_NOT_OFFERED` and `PROVIDER_TYPE_NOT_OFFERED` |
| Visibility | `GET /provider-types` and the partner profile carry `allowedListingTypes` (usable now). New `GET /admin/provider-types` (read-only) shows every type with its flags and full mapping, rendered at `/admin/listing-rules` |
| Partner UI | The "Kind of listing" choices are exactly the API's allowed list. A business that may list nothing is told so, and the 422 message names what it may list |
| No names in code | A unit test reads the codes from the migrations and scans the API and web sources. Provider types appear nowhere; listing types appear only in the two ADR 0004 detail descriptors. Mutation check: adding `"bus_operator"` to a service fails it |

### Gap 25: admin lists

| Part | What |
|---|---|
| Providers | `q` (display/legal name, owner email, type name or code), `sort` = newest (default), oldest or name, each ending in `id`; any page; `pageSize` ≤ 100 |
| Invoices / payouts | Invoices: `q` (number or provider name), newest first (partner invoices too). Payouts: `q` (provider name; LIKE wildcards escaped). Their order was already stable |
| Paging | Every paged response adds `page.totalPages` (additive) |
| Audit log | `actor: { userId, role, name }`: the name only, no contact data, loaded once per page (an `include`, not a query per row) |
| Admin UI | One provider search form (search, status, kind including not-offered types, order). The 100-provider dropdowns in invoice and payout filters are replaced by text search, plus links from a provider page. Audit actors show as "Name (role)"; "MeroStay system" when there is no user |
| Partner lists | Already offset-paged with a stable order (`createdAt`, `id`) and no 100-row cap; unchanged apart from newest-first invoices. The listing form's parent picker now loads per container type rather than "the first 100 listings" |

## Verification (real results)

| Check | Result |
|---|---|
| `format:check`, `lint`, `typecheck` (API, web, e2e), `build` | Pass |
| API unit | **227/227** (214 + 13 new: rules, paging math, search building, the name scan) |
| Web unit | **80/80** (74 + 6 new: listing-type choices, refusal message, list query/URL building, actor labels) |
| API integration, disposable PostgreSQL 17 | **200/200** (183 + 8 gap 22 + 9 gap 25) |
| E2E (Playwright, booking mode, disposable DB) | **20/20**, desktop and mobile; Phase 1, Track A, Track B (+ allowed types) and Track C (+ search, actor name, rules page) |
| `npm audit` | 0 vulnerabilities |
| CI on `c2c178f` | Run `45406825276`, success |
| CI on `f48c61e` | Run `45407396033`, success |
| **Neon integration (end of phase)** | **13/13 files, 200/200 tests**, 1,829.22 s, exit 0 (attempt 2, below) |

### Gap 22 cases (integration)

| Case | Result |
|---|---|
| Bus operator creates a hotel room (and a hotel property) | `422 LISTING_TYPE_NOT_ALLOWED`, `allowedListingTypes: ["bus_ticket"]`, 0 listings written |
| Hotel creates its property and a room | 201, 201 |
| "Homestay" (hotel type, HOMESTAY property) creates its property and a room | 201, 201 |
| Tour operator creates an activity while `activity` is inactive | `422 LISTING_TYPE_NOT_OFFERED`, profile offers only `tour`. After switching it on: 201 |
| Airline creates a flight: both inactive / listing type active only / both active | `422 LISTING_TYPE_NOT_OFFERED` / `422 LISTING_TYPE_NOT_ALLOWED` (`provider_type_not_offered`) / 201. Flags restored |
| Update: `listingTypeCode` in PATCH; edit of a no-longer-usable listing; archive it | 400 / `422 LISTING_TYPE_NOT_OFFERED`, unchanged / 200 ARCHIVED |
| Database guard: Prisma insert of an unmapped pair; raw `UPDATE` of `listing_type_code` | Both refused → `LISTING_TYPE_NOT_ALLOWED`, nothing changed |
| Visibility | Public types, partner profile and admin view are correct; the admin view covers every mapping row; non-admin 403 |

### Gap 25 cases (integration)

| Case | Result |
|---|---|
| 105 seeded providers (pairs share `created_at`) | Pages 1–3 of 50/50/5, `totalPages: 3`, 105 unique ids in exactly the database's order (newest, `id` desc); page 4 empty; a repeated page is identical |
| Orders | `oldest` is the exact reverse; `name` is alphabetical |
| Search | Name, legal name, owner email, type name; with type and status filters (AND); no match → 0 |
| Bad input | `pageSize=101`, `sort=random`, `q=` and `q=␠␠` → 400; customer → 403 |
| No N+1 | The same number of Prisma operations for `pageSize=5` and `pageSize=100` (≤ 6), for providers and for the audit log (100 seeded rows) |
| Audit actor | `{ userId, role, name }` for a user; `null` for a system row; no email in the payload |
| Invoices / payouts | Newest first; search by number and by provider name; payout search by name; `%%` matches nothing (escaped) |

### Two Phase 6 expectations updated (intended behaviour)

- The audit actor now includes `name`, and pages carry `totalPages`.
- A "foreign parent is unknown" check used the tour-operator partner to post a hotel room; the type
  rule now refuses that first. The check now uses a type that partner may list (an activity) with
  the foreign parent, so it still proves `422 UNKNOWN_PARENT_LISTING`.

## Neon integration run (end of phase)

Command: `caffeinate -i npm run test:integration`, against the Neon `test` branch from
`apps/api/.env.test`. Attempt 1 ran on `c2c178f`; attempt 2 ran on `f48c61e`, whose only change
since `c2c178f` is documentation, so the code under test was identical. The working tree was clean
both times.

| Attempt | Started (UTC) | Result |
|---|---|---|
| 1 | 13:46:11 | **Did not run.** Global setup failed after 2 s with `28P01 password authentication failed for user 'neondb_owner'` (P2010), before any test file |
| 2 | 15:21:39 | **Passed: 13/13 files, 200/200 tests**, duration 1,829.22 s (about 30.5 min), exit 0, ended 15:52:09 |

- **Attempt 1 diagnosis, without printing secrets:**
  - `.env.test` was last changed on 22 Nov, and points at the recreated test endpoint
    `ep-odd-feather-benn83wc`, the configuration that passed Phase 7's run (183/183);
  - its password equals the dev password (compared by hash only), and dev still connects
    (`npm run db:check` ✔).
  - So the test branch's role password had changed since 22 Nov.
- **No retry until the owner acted, and no credential was changed by the agent.** The owner
  updated the test-branch password in `apps/api/.env.test`, then attempt 2 ran once.
- **Log:** only the known `pg` SSL-mode and `client.query()` deprecation warnings (also present in
  Phase 7); no errors.
- **Duration:** 1,829 s for 200 tests, against Phase 6's 1,549 s for 179. The extra time is mostly
  the new admin-lists file seeding 105 providers and 100 audit rows over Neon round trips.

## Operational gaps

- **Closed:** 22 (listing rules) and 25 (admin lists).
- **Still open, 20 in total:** 1–10, 12–17, 20, 21, 23, 24. Gap 5 (per-IP limits behind the proxy)
  is the **only launch blocker** left.
- **Retargeted:** gaps 9, 13 (correction) and 15 pointed at "Phase 8". The owner narrowed Phase 8
  to gaps 22 and 25, so they now say "Admin moderation (not yet scheduled)". The roadmap has that
  row without a number for the owner to place.
- **Unchanged:** 14 (Phase 9), 23 (Phase 9), 21 (Phase 16), 7 (Phase 11), 24 (no phase).

## Commits

| Hash | Message |
|---|---|
| `d4df1c4` | feat(api): data-driven listing rules per provider type and admin list search (gaps 22, 25) |
| `c2c178f` | feat(web): allowed listing types in the partner form; admin search, paging and rules |
| `f48c61e` | docs: document Phase 8 listing rules and admin lists, ADR 0013 and gaps |
| (this commit) | docs: record the end-of-Phase-8 Neon integration run (200/200) |

The two gaps share API files (`providers.service.ts`, the Phase 6 test file), so the API work is
one tested commit whose body explains both gaps. Interactive partial staging isn't available here.

## Known limitations / follow-ups

- **The trigger checks new writes only.** Existing rows are not re-validated; the dev database had
  no listings at this phase.
- **Editing the mapping in the console** is not built (read-only); today it changes by migration.
- **Listing approval (gap 15)** should re-check the rule when it is built.
- **After `npm run test:e2e:booking`,** run `npm run build` before `npm start`.

## How to review

1. Read [ADR 0013](../architecture/decisions/0013-provider-type-listing-rules.md) and the migration.
2. `npm run dev`. As a partner, `/partner/listings/new` offers only your type's listings. As an
   admin, see `/admin/providers` (search), `/admin/listing-rules` and `/admin/audit-log`.
3. `E2E_DATABASE_URL="postgresql://…disposable…" npm run test:e2e:booking`.
