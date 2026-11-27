# Phase 13: UI design system & restyle

- **Status:** complete, awaiting owner review.
- **Branch:** `phase/13-ui-design-system`
- **Date:** 2026-11-27

## Scope (as approved)

Restyle `apps/web` to the owner's mockups and build a central design system:

- tokens and shared components;
- homepage, search, listing detail, trip and checkout;
- partner and admin dashboards on the same system;
- Flights hidden; mobile-first; accessible.

**Pure presentation:** no backend logic, API contract, request shape, state management, auth/CSRF
wiring or database change; no new features.

**Not built:** anything outside the web presentation layer. Phase 14 has not been started.

**Owner decisions (asked at the start, 2026-11-27):**

| Question | Answer |
|---|---|
| Phase number (Search UX was 13) | **This restyle is 13; the rest shift:** 14 Search UX, 15 Cancellations & refunds, 16 Reviews, 17 Notifications, 18 Hardening |
| Which mockup set | **Set 2** (green search button, trust bar) with the brief's headline **"Discover Nepal, your way"** |
| Mockup data the backend lacks (ratings, reviews, amenity/rating filters, counts, map, bus times) | **Show only real data**; the map is a labelled placeholder |
| Images (listings have no photos; supplied images are small crops) | **Illustrative only:** scenic photos for hero, destinations and promos; per-type photos on listing cards, labelled illustrative |

**Defaults I chose and stated before building:**

- **NPR as `Rs. 7,500.00`:** per the brief and CLAUDE.md §1, done inside the one formatter.
- **Orange contrast:** white text on `#f4a261` fails WCAG AA (about 2.2:1), so it is decoration
  only, and orange text and white-text buttons use `#b8541a` (about 4.9:1).

## What was built

Design-system guide: [frontend.md](../architecture/frontend.md#design-system-phase-13);
decision: [ADR 0019](../architecture/decisions/0019-ui-design-system.md).

- **Tokens** (`globals.css`):
  - colours: `primary` `#1b4332` (+ dark, light, soft), `accent` `#f4a261`, `accent-strong`
    `#b8541a` (+ dark, soft), `surface`, `line`, `ink`, `muted`;
  - card and control radii; card and float shadows;
  - Inter and Playfair Display through `next/font` (self-hosted);
  - a global visible focus ring.
- **Mechanical rename** of the Phase 7 palette classes (`navy` → `primary`, `teal` →
  `accent-strong`, `mint` → `primary-soft`, `mist` → `surface`/`line`) and of radii and muted text
  across 62 files. Every screen, dashboards included, now follows the tokens.
- **Shared components** (`components/ui/`):
  - `Button` (primary, secondary, accent, ghost) and the matching class strings;
  - input, select and date input styles (native `type="date"`, no date-picker library);
  - `Card`, and `Badge` (`StatusPill` kept as its alias; `statusTone` also covers listing and
    provider statuses);
  - `PageHeading`, `SectionHeading`, `Alert`; `Panel` restyled;
  - inline SVG icons and a logo mark (no icon library).
- **Navbar:** forest-green bar, logo, Stays · Buses · Guides · Experiences (no Flights), account
  links. On phones the categories are a scrollable second row, so "Log in", "Log out" and the role
  links stay visible.
- **Footer:** links only to pages that exist.
- **Homepage:**
  - full-width hero photo with overlay and "Discover Nepal, your way";
  - the floating search card;
  - a trust bar (every claim true today);
  - popular destinations: only places with listings, with the real count;
  - "Stays / Buses / Guides / Experiences to book now" from real listings, each section left out
    when empty;
  - the existing System status panel (E2E-checked) kept and restyled.
- **Search:**
  - a hero band titled from the filters ("Stays in Pokhara");
  - the search card: category tabs as radio inputs (works without JavaScript), destination,
    dates, guests;
  - a sidebar with a labelled map placeholder and the API's own filters (price range, sort);
  - result cards: illustrative image, type, title, place, availability, the formatted price,
    "Book now";
  - pills when a category has several types (Experiences: Activity, Tour / trek).
- **Listing detail:**
  - a banner (the one large scenic photo, labelled illustrative), title and place;
  - details, rooms, availability calendar, cancellation policy;
  - the booking card (price, taxes, Add to trip), sticky in a right column on desktop and right
    after the title on phones. A fixed bottom bar was avoided because it would cover the "Add to
    trip" button.
- **Trip and checkout:** a presentation-only stepper (Build your trip → Check the quote → Confirm
  → Pay), quote and totals cards, and eSewa and Khalti as large selectable options with a
  full-width Pay button.
- **Dashboards:** partner and admin pages use the tokens, `Panel` cards, display headings and
  `Badge` statuses (Verified, Waiting for verification, Changes requested, Paid…).
- **Assets:**
  - 21 photos cropped from the owner's files (baked-in place names and rounded corners removed),
    re-encoded without metadata into `apps/web/public/images/` (368 KB in total);
  - the originals are kept in `docs/design/assets/`, and the two mockup sets in
    `docs/design/screens/`;
  - the flight photo is not used.

## How the mockup was matched

| Mockup element | Implementation |
|---|---|
| Green header with logo and four categories, Login (outlined) / Sign up (orange) | Same; Sign up uses `accent-strong` for contrast |
| Hero with photo, overlay and headline | Same; the brief's headline |
| Floating white search card with tabs, Destination, dates, Guests, Search | Same fields mapped to the API's filters; green Search button (set 2) |
| Trust strip (set 2) | Four true statements |
| Popular destinations with photos | Real places only (with counts) |
| "Hotels in Pokhara" header + sidebar + horizontal cards with Book now | Same layout; only real data; map placeholder |
| Ratings, review counts, amenity/rating filters, bus times, verified guide photos | **Left out** (owner decision): the API has none of these |

**Visual check:** I screenshotted the production build on the scratch data at 1440 px and 375 px
(home, search, listing, trip, admin payouts, admin providers) and compared it with the mockups.
That check found two bugs, both fixed before committing:

- the search card's tabs were hidden under the hero (a stacking order bug);
- a `fieldset`'s minimum width made the page 72 px too wide on phones.

After the fixes: no horizontal scroll on any checked page at either width.

## Verification (real results)

| Check | Result |
|---|---|
| `format:check`, `lint`, `typecheck` (API, web, e2e), `build` | Pass |
| API unit | **343/343** (unchanged; includes the ADR 0013 guard) |
| Web unit | **107/107** (102 + 5 new) |
| API integration (disposable PostgreSQL 17) | **293/293**, 20 files (regression; no API change) |
| E2E local (booking mode) | **40/40**, with default, 1 and 8 workers |
| Commit 1 on its own (separate worktree: `npm ci`, lint, typecheck, unit, E2E) | lint, typecheck pass; API unit 343/343, web unit 102/102; E2E 40/40. **`format:check` fails on one line** in `search-results.tsx` (whitespace only: the class rename shortened a line that Prettier would join). Commit 2 rewrites that file and the branch head passes. Not fixed in commit 1: that would rewrite pushed history |
| `npm audit` | 0 vulnerabilities |
| CI | `b692901` (run 45969524448): both jobs green, "Format, lint, typecheck, test, build" and "E2E journeys (Playwright, disposable database)". The docs commit is checked by its own run |
| Neon integration run | **Not run:** the API, schema and migrations are unchanged in this phase (no file under `apps/api` differs from `v0.12.0`), and the brief asked for web unit and E2E. Available on request |

**Backend untouched:** `git diff v0.12.0 -- apps/api` is empty. No API call, request or response
shape, state handling or CSRF/session code changed. The homepage makes additional read-only
server-side calls to existing public endpoints (listing types, small searches).

### Tests changed (expected text only, never what is tested)

- **Money strings** `Rs 7,700.00` → `Rs. 7,700.00`: the web unit tests (money, web, partner,
  admin) and the E2E specs (booking, partner, admin, payments, admin-ops' `rupees()` helper).
- **Homepage heading** in `home.spec.ts`: "Find your stay anywhere in Nepal" → "Discover Nepal,
  your way".
- **New:** `phase13-logic.test.ts`.
  - Categories: never flights; a category with no offered type is left out.
  - Titles, illustrative images and alt text, the trip stepper, `Rs.` formatting.

### What testing found

- **The ADR 0013 guard test caught me.** My first version mapped categories to listing-type codes
  in `lib/categories.ts`. The Phase 8 guard (no listing-type codes in application code) failed. I
  kept the guard unchanged and redesigned instead: categories group types by unit label (night,
  seat, day, person), resolved from `GET /listing-types` at runtime, and links use
  `/search?category=…`.
- **The two visual bugs above** (stacking order; fieldset minimum width).
- **I overwrote the existing `docs/architecture/frontend.md`** (Phase 7 web architecture) by
  writing a new file without reading it first. I restored it from git and added the design system
  as a new section; nothing of the original was lost.

## Mobile

- The layouts were checked at 375 px: no horizontal page scroll; the search card, cards,
  sidebars and dashboards stack.
- The Phase 12 mobile payout table fix is unchanged: the provider name in the first column opens
  the batch. It is exercised by the mobile E2E admin journey.

## Commits

| Hash | Message | Content |
|---|---|---|
| `6baa544` | `feat(web): add design tokens, shared UI components, header, footer and assets` | Tokens, fonts, shared components and icons, header and footer, the mechanical palette rename across the app, `Rs.` formatting and its test strings, images (105 files) |
| `b692901` | `feat(web): implement homepage, search, listing detail, trip and checkout designs` | Homepage, search (card, filters, results), listing detail, trip stepper and checkout, `phase13-logic.test.ts`, homepage E2E heading (15 files) |
| (this commit) | `docs: document the frontend design system and Phase 13` | ADR 0019, frontend.md design-system section, design README, mockups and original assets, roadmap and gap renumbering, CLAUDE.md, this report |

## Security and constraints checklist

- **Auth and CSRF:** no change to session, cookie, CSRF or `/api/v1` proxy wiring.
- **Money:** only through `formatMoney` / `formatAmount`; the UI computes no totals.
- **Flights:** never offered (categories come from active, bookable types; a unit test covers it).
- **Assets:** no metadata in the published images; no secrets.
- **Accessibility:**
  - visible focus ring on every interactive element;
  - contrast rules in the tokens;
  - images have alt text (illustrative ones say so), decorative icons are `aria-hidden`;
  - native form controls with labels; tabs are a radio group.
- **Secret scan** before every commit: run before each of the three commits (staged diff; the script plus the CLAUDE.md §2.3 checklist): no hits; `.env` and `node_modules` still ignored.

## Known limitations / follow-ups

- **Low-resolution assets:** the supplied photos are small crops (cards about 170–420 px; the
  hero 827 px). Clean, high-resolution originals can replace the files in `public/images/` under
  the same names.
- **Not in the backend yet:** listing photos ("Frontend polish" row), ratings and reviews
  (Phase 16), amenities and a map.
- **Experiences:** the tab opens the first offered type (Activity) and the results page offers a
  switch to Tour / trek. The API searches one type at a time.
- **Commit 1 formatting:** `6baa544` alone fails `format:check` on one whitespace-only line
  (fixed by `b692901`); everything else passes on that commit.
- **Not restyled field by field:** inner partner and admin forms follow the tokens and components
  but were not redesigned individually (no mockups for them).

## How to review

1. Read [ADR 0019](../architecture/decisions/0019-ui-design-system.md) and the design-system
   section of [frontend.md](../architecture/frontend.md#design-system-phase-13).
2. `npm run dev`, then open:
   - `/` (hero, search card, destinations, picks);
   - `/search?category=stays`, a listing, `/trip`;
   - a confirmed trip with online items (eSewa or Khalti);
   - `/partner` and `/admin` as the respective users.

   Narrow the window to 375 px.
3. `E2E_DATABASE_URL="postgresql://…disposable…" npm run test:e2e:booking`.
