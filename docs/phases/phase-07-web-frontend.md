# Phase 07: Web Frontend

- **Status:** Track A (customer) approved. Track B (partner dashboard) complete, awaiting review.
  Track C (admin) not started; it needs the owner's approval.
- **Branch:** `phase/07-web-frontend`
- **Date (Track A):** 2026-11-23 · **Date (Track B):** 2026-11-22

## Scope (as approved)

Three tracks with a checkpoint after each:

- **A**, customer-facing;
- **B**, partner dashboard;
- **C**, admin dashboard.

Frontend only, in `apps/web`, plus the gap 18/19 backend fix.

**Not built:** live gateway, refund or payout execution, review submission, notifications, OAuth,
2FA, email verification and reset.

**Opening docs commit:** `e9d9871` "docs: mark Phase 6 merged and tagged v0.6.0" on `main` (CI run
`45030131070`, green).

**Design:** the owner's reference image is used **only for its colour palette** (owner's
instruction). Navy `#0F3B64`, teal `#14B8A6`, mint `#A7D8D1`, mist `#E8F1F5` and ink `#2D3748`
are in `globals.css` and `docs/design/README.md`. No logo, name, typography or layout was taken
from it.

## Backend changes in this phase

| Change | Why | ADR |
|---|---|---|
| `provider_types.is_active` (airline hidden) + `GET /api/v1/provider-types` | Closes gap 19, data-driven | 0009 |
| `provider_type_required_documents`, enforced at submit and before approval | Closes gap 18, data-driven | 0009 |
| `GET /api/v1/trips` (the caller's own trips) | Track A needed it for history and the draft trip; owner approved it when asked mid-phase | 0010 |
| `GET /api/v1/locations[?parentId=]` (public, one level per request) | Track B: bus routes and listing places need location ids; owner approved it when asked mid-track | 0011 |
| `settledBy { role, name }` on partner bookings (serializer only) | Track B: the brief asks to show who/when of a settlement; the API stored who but didn't return it | 0011 |

Migration `20261123090000_provider_type_requirements` is additive. No applied migration was
edited. Drift: none.

## Track A: what was built

| Route | What |
|---|---|
| `/` | Hero, search form, Phase 1 system status (kept) |
| `/search` | Type (active and bookable only), place, dates, quantity, price in Rs, sort; paginated results with formatted prices and availability |
| `/listings/[id]` | Generic details and attributes, rooms of a hotel, priced availability calendar, cancellation policy, Add to trip (login first, then returns to the page) |
| `/login`, `/register` | Readable API errors: 401, 409, 415, 429 (with retry time), 400 field messages; same-site `?next=` only |
| `/trip` | Draft trip: change dates and quantity, remove, **Get quote** (the API's dry run), **Confirm** |
| `/trips`, `/trips/[id]` | History and detail: items, per-date prices, statuses, totals, frozen cancellation policy. "Trip not found" on the API's 404 |

- **Money:** strings end to end. `lib/money.ts` formats the API's digit strings with string
  operations only (Nepali grouping for NPR, exact above 2^53). The UI computes no totals.
- **Auth and CSRF:** browsers call `/api/v1/*` on the web origin, which Next.js rewrites to the API,
  so the session cookie is first-party. Calls send `credentials: "include"`; writes send
  `X-CSRF-Token`. The user and token live in React state; nothing goes to localStorage.
- **No secrets in the web app:** only `API_URL`, server-only and set at build and run time.

## Verification (real results)

| Check | Result |
|---|---|
| `format:check`, `lint`, `typecheck` (API, web, e2e), `build` | Pass |
| API unit | **214/214** (incl. 5 new verification-rule tests) |
| Web unit | **44/44** (16 from Phase 1 + 28 new) |
| API integration (PostgreSQL 17) | **181/181** (incl. gap 18/19 and trip-list tests) |
| **E2E (Playwright), booking mode** | **12/12**: desktop and mobile Chromium |
| `npm audit` | 0 vulnerabilities |

### E2E coverage

- **The booking journey**, on both profiles, against a disposable PostgreSQL seeded with the
  integration fixture:
  1. register, then log out;
  2. log in with a wrong password, see "Email or password is incorrect.", then log in correctly;
  3. search hotel rooms for two nights ("Rs 7,700.00 for 1 × 2 nights") and open the room (festival
     price "Rs 4,200.00" in the calendar);
  4. add it to the trip, paid at the property;
  5. add two bus seats, paid online;
  6. check the trip builder totals: "Rs 13,171.10" overall, "Rs 9,571.10" at the property and
     "Rs 3,600.00" online;
  7. get a quote ("Rs 7,700.00", VAT "Rs 1,101.10", total "Rs 13,171.10");
  8. confirm: "1 pay-at-property item is confirmed; 1 online item is reserved and waiting for online
     payment";
  9. see the trip in history ("Awaiting payment", "Rs 13,171.10") and open its detail;
  10. log out and land on home.
- **A protected page** sends a visitor to `/login?next=…`.
- **The Phase 1 checks:** home content, system status operational, no horizontal scroll, and API
  health.

### Bugs the E2E found (fixed)

1. A single-date listing (bus) asked the API for an empty calendar window (`from = to`): the API
   rejected it. The calendar window is now a tested helper, `calendarWindow`.
2. Logging out on a protected page raced the login redirect. The header now navigates home first.
3. A test assertion matched Next.js's route announcer, which also has `role="alert"`; it is now
   scoped to the form.

### Safety checks for the E2E setup

- The seed script refuses the dev database (verified: exit 1, "Refusing to seed…").
- Booking mode never reuses a running server. Its first attempt stopped because the owner's
  `npm run dev` held port 4000, so booking mode now has its own ports (4100/3100).
- Before the journey starts, it checks through the web proxy that it reaches the seeded API.

### Gap 18/19 proofs (integration)

- An owner ID alone is refused for a hotel (`409 REQUIRED_DOCUMENTS_MISSING` naming the
  registration group). Adding a homestay registration then allows the submission.
- An admin can't approve a tour operator that lacks registration and PAN. Its status stays the same
  and no audit row is written; rejecting is still possible.
- The inactive provider type is absent from `GET /provider-types` and can't be onboarded
  (`422 PROVIDER_TYPE_NOT_OFFERED`). Toggling the flag exposes it.
- Mutation checks: removing either document check, or the flag check, makes a test fail.

**Neon:** this checkpoint's integration results are from the local PostgreSQL 17 database. A full
Neon run is planned for the end of the phase, given the about-25-minute runs and the connection
constraint recorded in operational-gaps.md.

## Operational gaps

- **Closed:** 18 (required-documents checklist), 19 (airline offered at onboarding).
- **Updated:** gap 5. Behind the web proxy, all users share one IP for the per-IP rate limits; this
  must be fixed before launch.
- **New:** 20 (no locations endpoint), 21 (the E2E journey is not in CI).
- **Open:** 18 in total, numbers fixed.

Roadmap restated: Phase 7 = web frontend, 8 admin approvals, 9 listing media, 10 search UX,
11 live gateways, 12 cancellations, 13 commission & payouts.

## Commits (Track A)

| Hash | Message |
|---|---|
| `b6450cb` | feat(api): make provider-type requirements and visibility data-driven |
| `b5a3b1f` | feat(api): list the customer's own trips |
| `4b658f1` | feat(web): customer auth, search, listings and trip builder (Phase 7 Track A) |
| (this commit) | docs: document Phase 7 Track A frontend, ADRs 0009-0010 and gaps |

## Known limitations / follow-ups

- The location is typed as a place name (gap 20).
- No component-level tests (no DOM library added). Logic is unit-tested, and pages are covered by
  E2E.
- After `npm run test:e2e:booking`, run `npm run build` before `npm start` (that build points at
  port 4100).
- Online payment is not offered in the UI (the gateway is simulated and refused in production). A
  confirmed trip with online items shows "Awaiting payment".

## Track B: partner dashboard

### Routes

| Route | What |
|---|---|
| `/partner/onboarding` | A customer sets up a business: offered types only, with the documents each will need |
| `/partner` | Status, rejection reason, next step |
| `/partner/profile` | Contact edit (always), legal/tax edit (only before verification), payout bank account **masked only** |
| `/partner/verification` | Required-document groups (ADR 0009) with satisfied/missing state, documents and review status, add a document (metadata), submit |
| `/partner/listings`, `/new`, `/[id]` | Own listings (all statuses); type-specific forms from active listing types; place picker; allowed status moves; **availability and date prices** |
| `/partner/bookings`, `/[id]` | Own bookings: frozen money with commission and your share, payment/commission/payout status, invoice, per-date lines, cancellation snapshot, masked guest; **settle at the property** |
| `/partner/invoices` | Commission invoices: number, status, issued date, amount (strings), items |
| `/partner/payouts` | Read-only summary per month: total, commission, payout (= total − commission, ADR 0008), Pending |

### How the rules are kept

- **Money:** every amount is the API's string formatted by Track A's `formatMoney`. The partner
  pages compute nothing. Prices typed in rupees become minor-unit strings, and percentages become
  basis points, both with string operations (unit-tested).
- **Auth:** the same first-party cookie and in-memory CSRF token as Track A. `X-Provider-Id`
  (several businesses) is also in memory only. Nothing is stored in `localStorage`.
- **Scoping:** the API's. The UI never filters. A 404 (missing *or* another business's) is the
  same "Not found", proven in E2E for another partner's listing and booking. The role gate is
  navigation only.
- **Masking:** the bank number is shown as the API's `accountNumberMasked`. A UI guard shows
  `••••` for anything else, and a unit test feeds it a full number. Guest email and phone are shown
  as the API masks them.
- **Design:** only Track A's primitives and palette tokens. No new colours.

### Settle at the property: idempotency in the UI

- **One key per attempt:** a `settleReducer` creates one `Idempotency-Key` per attempt and keeps
  it until the API confirms success.
- **Safe retries:** after a failure the button reads "Try again", next to "Trying again is safe: it
  will be recorded only once." The retry re-sends the **same** key. Clicks while a request is in
  flight do nothing.
- **Success once:** success is shown once ("…recorded once" for a replay of our own key). The
  button then disappears, and the API's record is shown: "Recorded as paid on … NPT by <name>".
  MeroStay staff show as "MeroStay".
- **E2E proof:** the first response is dropped after the API received it. The retry sends the
  identical key, the API replays, and the record is unchanged after a reload. A second attempt
  with a new key returns 200 and changes nothing.
- **Mutation check:** generating a new key on retry fails the journey.

## Verification, Track B (real results)

| Check | Result |
|---|---|
| `format:check`, `lint`, `typecheck` (API, web, e2e), `build` | Pass |
| API unit | **214/214** |
| Web unit | **63/63** (44 from Track A + 19 new in `partner-logic.test.ts`) |
| API integration (PostgreSQL 17, disposable) | **183/183** (+2 location tests; settle tests now assert `settledBy`) |
| **E2E (Playwright), booking mode** | **16/16**, desktop and mobile Chromium: Phase 1 checks, Track A journey, Track B journey |
| `npm audit` | 0 vulnerabilities |
| E2E seed against the dev database | Refused (exit 1) |

**Neon:** still planned as one full integration run at the end of Phase 7 (after Track C).
Track B's integration results are from the local PostgreSQL 17 database.

### E2E coverage (partner journey, both profiles)

1. A customer books the partner's room through the API: one night pay-at-property, one night
   online (simulated gateway). A second trip books another partner's room.
2. The partner logs in (`/login?next=/partner`) and sees the business and the header's "Partner"
   link.
3. **Own listings only:** exactly their two (hotel and room); the other owner's room is absent.
4. **Adds a slot:** one date, 3 units, date price "Rs 2,800.00"; the table shows it as "date price".
5. **Overbooking refused:** capacity 0 on a booked date → "Capacity can't go below what is already
   booked … Nothing was changed."
6. **Bookings:** this customer's two nights. The pay-at-property one shows "Rs 2,500.00", the
   commission "Rs 375.00" and the share "Rs 2,125.00", with a masked email `g•••@e•••.com`.
7. **Settle once:** the lost-response retry and the second attempt (above).
8. **Invoice:** that booking's invoice shows "Rs 375.00".
9. **Payout:** "Pending", and the amount on screen equals the API's `providerPayoutMinor`.
10. **Profile:** the bank number is "••••4321", and the full number appears nowhere on the page.
11. **Verification:** both hotel groups (identity, registration) are approved.
12. **Scoping:** another partner's listing and booking show "Not found"; the API answers 404.
13. **Mobile:** the inventory and booking pages don't scroll sideways.
14. **Logged out:** a visitor on `/partner/bookings` goes to `/login?next=…`, and the API answers
    401.

### Operational gaps (Track B)

- **Gap 5 is marked a launch blocker:** "must be closed before the site takes real users", in
  Hardening (Phase 16) or earlier if the site goes public first.
- **Gap 14:** notes how the UI handles documents (metadata, a `not-uploaded/…` key, a message on
  the page).
- **Gap 20 narrowed:** the endpoint exists; the customer search picker remains for Phase 10.
- **Gap 21:** covers both journeys.
- **New gaps:**
  - 22: listing types aren't restricted by provider type (owner decision first; Phase 8);
  - 23: no cancellation-policy management, so new listings have no policy (Phase 9);
  - 24: the business choice isn't remembered after a reload.
- **Open:** 21 in total.

### Commits (Track B)

| Hash | Message |
|---|---|
| `3614075` | feat(api): add public locations tree and show who settled a booking |
| `7d7fedf` | feat(web): partner dashboard (Phase 7 Track B) |
| `3c25324` | test(e2e): partner dashboard journey on the disposable database |
| (this commit) | docs: document Phase 7 Track B partner dashboard, ADR 0011 and gaps |

### Known limitations (Track B)

- **Documents are metadata only** until uploads exist (gap 14).
- **No cancellation policy** on listings created in the UI (gap 23).
- **Edit-form location details:** an existing bus listing's origin and destination show as
  "Current place" (the API's detail record holds ids). Changing them uses the picker.
- **Currency:** new listings are priced in NPR (one currency in the MVP).
- **Rebuild after the E2E run:** the booking build targets port 4100, so run `npm run build`
  before `npm start`.

## How to review

1. `npm run dev`, then open http://localhost:3000. You need data in your **dev** database to
   search, for example `npm run db:seed`. For the partner area: sign up, then "List your
   business" in the footer (`/partner/onboarding`).
2. Or run the journey yourself:
   `E2E_DATABASE_URL="postgresql://…disposable…" npm run test:e2e:booking`.
3. Read [ADR 0010](../architecture/decisions/0010-web-frontend-architecture.md) and
   [frontend.md](../architecture/frontend.md).
