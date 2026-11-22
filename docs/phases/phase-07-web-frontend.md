# Phase 07: Web Frontend

- **Status:** Track A (customer) complete, awaiting review. Tracks B (partner) and C (admin) not
  started; each needs the owner's approval.
- **Branch:** `phase/07-web-frontend`
- **Date (Track A):** 2026-11-23

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

## How to review

1. `npm run dev`, then open http://localhost:3000. You need data in your **dev** database to
   search, for example `npm run db:seed`.
2. Or run the journey yourself:
   `E2E_DATABASE_URL="postgresql://…disposable…" npm run test:e2e:booking`.
3. Read [ADR 0010](../architecture/decisions/0010-web-frontend-architecture.md) and
   [frontend.md](../architecture/frontend.md).
