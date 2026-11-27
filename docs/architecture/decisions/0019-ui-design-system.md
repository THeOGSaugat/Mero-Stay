# 0019. UI design system: forest green and orange, illustrative images, "Rs."

- **Status:** Accepted
- **Date:** 2026-11-27
- **Phase:** 13 (UI design system and restyle). Supersedes the Phase 7 palette note in
  `docs/design/README.md`.

## Context

The web app worked but used plain Tailwind styling with the Phase 7 navy and teal palette. The
owner supplied two sets of high-fidelity mockups and 22 photos, and asked for a pure presentation
phase:

- a central design system;
- the home, search, listing, trip and checkout screens restyled to the mockups;
- the dashboards on the same system;
- no backend, API, state or auth change, and no new features;
- Flights hidden.

The two mockup sets differ, and they show data the backend does not have: ratings and review
counts, amenity and rating filters, a map, bus times, verified guide photos.

**Owner decisions (2026-11-27):**

| Question | Decision |
|---|---|
| Phase number | 13 is this restyle; the later phases move down by one (14 Search UX … 18 Hardening) |
| Which mockup set | **Set 2** (green primary actions, slim trust bar), with the headline "Discover Nepal, your way" |
| Data the backend lacks | **Show only real data:** no ratings or counts, no filters the API cannot apply; the map is a labelled placeholder |
| Images | **Illustrative only:** scenic photos for the hero, destinations and promos; listing cards show a per-type photo marked illustrative, never as the property's own |

## Decision

- **Tokens.** A semantic palette in `globals.css`: `primary` `#1b4332` (owner's green), `accent`
  `#f4a261` (owner's orange), plus `accent-strong` `#b8541a`, `surface`, `line`, `ink` and
  `muted`. White text on `#f4a261` is about 2.2:1 and fails WCAG AA, so that orange is decorative
  only, and orange text and white-text orange buttons use `accent-strong` (about 4.9:1). There are
  also card and control radii, card and float shadows, and Inter plus Playfair Display through
  `next/font` (self-hosted).
- **Old classes.** The Phase 7 classes (`navy`, `teal`, `mint`, `mist`) were renamed mechanically
  across the app to the semantic names, so every screen follows the new palette without logic
  changes.
- **Components.** The existing primitives keep their names and props (`buttonPrimary`,
  `StatusPill`, `Panel`…) and are restyled. New: `Button`, `Card`, `Badge`, `SectionHeading`,
  inline SVG icons, `ListingCard`, the tabbed `SearchForm`, `ResultFilters` and `TripSteps`.
  Details: [frontend.md](../frontend.md).
- **Categories by unit, never by code.** Stays, Buses, Guides and Experiences group the offered
  listing types by unit label (night, seat, day, person), resolved from `GET /listing-types` at
  runtime. Links use `/search?category=…`. No listing-type code appears in application code: the
  ADR 0013 guard test caught a first, code-based version during this phase, and the test was kept
  unchanged.
- **Real data only.**
  - Destination tiles come from the existing search endpoint (`/listings?location=…&pageSize=1`):
    unknown or empty places are left out, and known ones show their real count.
  - Homepage picks are the cheapest real listings per category.
  - Search filters are those the API supports (type, place, dates, quantity, price, sort).
- **Images.** The owner's photos are crops from the mockup: small, some with baked-in labels and
  rounded corners. They were cropped and re-encoded without metadata into `public/images/`, and the
  originals are kept in `docs/design/assets/`. The flight photo is not used. Listing images are
  per-type illustrations, labelled on the image and in the alt text.
- **Money.** `formatMoney` renders NPR as `Rs. 7,500.00` (CLAUDE.md §1; it was `Rs 7,500.00`). It
  stays the only formatter, and the expected strings in tests were updated.

## Consequences

- One place changes the look. New pages follow [frontend.md](../frontend.md).
- No API contract, request, state or auth change. The homepage makes more read-only calls to
  existing public endpoints (listing types, a small search per destination and per category), all
  server-side.
- **Known limits:**
  - images are low resolution until the owner supplies originals;
  - listing photos are still not modelled (the "Frontend polish" row);
  - ratings, amenities and a map wait for their features.
