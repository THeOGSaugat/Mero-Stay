# MeroStay web app (`apps/web`)

Next.js 16 (App Router, Cache Components, Turbopack), React 19, Tailwind 4. Decisions:
[ADR 0010](decisions/0010-web-frontend-architecture.md) (architecture, customer site) and
[ADR 0011](decisions/0011-partner-dashboard.md) (partner dashboard) and
[ADR 0012](decisions/0012-admin-console.md) (admin console). Design tokens: `src/app/globals.css`
(palette and mockups from the owner, [docs/design](../design/README.md)). The design system
(tokens, components, content rules) is described in [Design system](#design-system-phase-13)
below ([ADR 0019](decisions/0019-ui-design-system.md)).

## Design system (Phase 13)

How the MeroStay web app (`apps/web`) looks, and how to style a new page so it matches. Introduced
in Phase 13 ([ADR 0019](decisions/0019-ui-design-system.md)), following the owner's mockups in
[`docs/design/screens/`](../design/screens/) (set 2, with the headline "Discover Nepal, your way").

**Rules that do not change with the look:**

- the UI computes no totals;
- every amount is formatted from the API's minor-unit string by `formatMoney` / `formatAmount`
  (`src/lib/money.ts`; NPR renders as `Rs. 7,500.00`);
- auth state and the CSRF token live in memory (ADR 0010);
- Flights are never offered.

### 1. Tokens (`src/app/globals.css`)

Colours, radii, shadows and fonts are defined once in `@theme`. Components use the **semantic
names** and never a hex value.

| Token | Value | Use |
|---|---|---|
| `primary` | `#1b4332` | Forest green: header, headings, primary buttons, links |
| `primary-dark` | `#123326` | Hover/pressed; footer background |
| `primary-light` | `#2d6a4f` | Gradients, success borders |
| `primary-soft` | `#e3efe8` | Success / selected / availability backgrounds |
| `accent` | `#f4a261` | Warm orange, **decorative only**: icons, labels on the dark header/footer, focus ring on dark backgrounds |
| `accent-strong` | `#b8541a` | Orange for text, outlined "Book now" buttons, white-text orange buttons, default focus ring (≈ 4.9:1 on white) |
| `accent-dark` | `#9a4413` | Hover of `accent-strong` |
| `accent-soft` | `#fdf0e6` | Warm highlight background |
| `surface` | `#f4f6f3` | Page sections, table headers, sidebars |
| `line` | `#e1e7e2` | Borders, dividers |
| `ink` | `#1f2a24` | Body text |
| `muted` | `#4a5a51` | Secondary text (≥ 7:1 on white) |

Contrast rules (WCAG AA):

- **Never put small text in `accent` on white.** White on `accent` is about 2.2:1.
- Use `accent-strong` for orange text and for buttons with white text.
- The status badge's label always names the status, so colour is never the only signal.

Other tokens:

| Kind | Tokens |
|---|---|
| Radius | `rounded-card` (0.875 rem: cards, panels, the search card), `rounded-control` (0.625 rem: inputs, buttons) |
| Shadow | `shadow-card` (cards), `shadow-float` (the search card over a hero) |
| Font | `font-sans` = Inter (body, UI); `font-display` = Playfair Display (headings) |

Fonts are self-hosted by `next/font` (`app/layout.tsx`), so the browser never calls Google.

**Focus:** a 2 px `accent-strong` outline on every link, button and field (a global rule in
`globals.css`). Use `outline-accent` on the dark green header and footer.

### 2. Components

| Component | File | Use |
|---|---|---|
| `Button` / `buttonClass(variant)` | `components/ui/primitives.tsx` | Variants `primary` (main action), `secondary` (outlined), `accent` (outlined orange: Book now), `ghost` |
| `buttonPrimary`, `buttonSecondary`, `buttonAccent`, `buttonGhost` | same | The same styles as strings, for `<Link className={…}>` |
| `inputClass`, `selectClass`, `labelClass` | same | Text, number and date inputs (native `type="date"`: no date-picker library) and selects |
| `Card` | same | White card with border, radius and shadow |
| `Badge` (`StatusPill`) + `statusTone()` | same | Statuses: `good` (Verified, Paid, Approved), `wait` (Pending…), `bad` (Rejected, Cancelled), `neutral`, `accent` |
| `PageHeading`, `SectionHeading` | same | Page title (display font) / section title with an optional link |
| `Alert` | same | `error` (role alert), `success`, `info` (role status) |
| `Panel`, `Facts`, `Pager`, `SectionNav`, table classes | `components/ui/data.tsx` | Dashboards (partner and admin) |
| Icons, `LogoMark` | `components/ui/icons.tsx` | Inline SVG line icons (no icon library); decorative (`aria-hidden`) |
| `SiteHeader` / `HeaderNav` | `components/site-header.tsx`, `header-nav.tsx` | Green bar: logo, Stays · Buses · Guides · Experiences (links `/search?category=…`), account links. On phones the categories become a scrollable second row |
| `SiteFooter` | `components/site-footer.tsx` | Links only to pages that exist |
| `SearchForm` / `ResultFilters` | `components/search/search-form.tsx` | The search card (category tabs are radio inputs, so it works without JavaScript) / price and sort sidebar |
| `ListingCard` | `components/search/listing-card.tsx` | Result and homepage card: illustrative image, title, place, price, Book now |
| `TripSteps` | `components/trip/trip-steps.tsx` | Build → Quote → Confirm → Pay (presentation only, `lib/trip-steps.ts`) |

### 3. Content rules (owner decisions, Phase 13)

- **Only real data.** Show what the API returns and never invent numbers.
  - No ratings or review counts (reviews are a later phase).
  - No amenity or rating filters, and no property-type counts.
  - The map is a labelled placeholder ("Map view is not available yet").
  - Destination tiles appear only for places that have listings, with the real count.
  - Homepage picks are real listings; a category with none is left out.
- **Images are illustrative.** Listings have no photos yet, so cards use a photo of the kind of
  thing booked (`illustrationFor()` in `lib/categories.ts`), always labelled "Illustrative photo",
  with alt text that starts "Illustrative photo:". The listing banner uses the one large scenic
  photo; the supplied per-type photos are only about 170–420 px wide.
  - Assets live in `public/images/`: cropped from the owner's files, with the baked-in labels and
    rounded corners removed and metadata stripped. The originals are in `docs/design/assets/`.
  - Higher-resolution, label-free originals can replace them with the same file names.
- **Categories** (`lib/categories.ts`) group the offered listing types by the unit they are sold
  in, with **no listing-type code in code** (ADR 0013's guard test checks this):

  | Category | Unit | Types today |
  |---|---|---|
  | Stays | night | Hotel room |
  | Buses | seat | Bus ticket (flights are also per seat but inactive, so never offered) |
  | Guides | day | Guide service |
  | Experiences | person | Activity, Tour / trek (the results page shows pills to switch) |

  - Header, footer and homepage links use `/search?category=<id>`; the search page resolves it
    from `GET /listing-types` to the category's first offered type.
  - A category with no offered type is not shown.

### 4. Styling a new page

1. Server Component by default; `"use client"` only for interaction.
2. Use `max-w-6xl` page containers with `px-4 sm:px-6`. Design for 360 px first, then `sm:`,
   `lg:`.
3. Title with `PageHeading`, sections with `SectionHeading` or a `Panel` (dashboards) / `Card`.
4. Actions:
   - `Button` / `buttonPrimary` for the main one, `buttonSecondary` for the rest;
   - "Book now"-style calls to action use `buttonAccent`;
   - statuses use `Badge`.
5. Images: `next/image` with `fill` + `sizes`, or width/height. Use `preload` (not the deprecated
   `priority`) only for the first, above-the-fold image.
6. Money only through `formatMoney` / `formatAmount`. Dates through the existing helpers
   (Nepal time).
7. Check at 375 px that there is no horizontal page scroll (`home.spec.ts` tests it for the home
   page), and that tables scroll inside their own container with any action in the first column.

## Routes (Phase 7, Track A: customer)

| Route | What | Rendering | Login |
|---|---|---|---|
| `/` | Hero, compact search form, system status (Phase 1 health check) | Server (Suspense) | No |
| `/search` | Filters (type, place, dates, quantity, price in Rs, sort) and paginated results | Server (Suspense), GET form | No |
| `/listings/[id]` | Type-specific details and attributes, rooms of a hotel, priced availability calendar, cancellation policy, "Add to trip" | Server (Suspense) + client "Add to trip" | To add |
| `/login`, `/register` | Forms; API errors shown as readable messages (401, 409, 415, 429 with retry time) | Client | — |
| `/trip` | The draft trip: edit dates and quantity, remove, quote, confirm | Client | Yes |
| `/trips` | The customer's trips, newest first (`GET /trips`) | Client | Yes |
| `/trips/[id]` | One trip: items, per-date prices, statuses, totals, frozen cancellation policy | Client | Yes |

## Routes (Phase 7, Track B: partner dashboard)

All under `app/partner/(dashboard)/`, client-rendered behind `RequireAuth` → `PartnerGate` →
`PartnerProvider` (layout), with a section nav. `/partner/onboarding` sits outside the group:
customers use it to become partners.

| Route | What | API |
|---|---|---|
| `/partner/onboarding` | Choose the kind of business (only offered types, with the documents each needs), name, contact | `GET /provider-types`, `POST /partner/onboarding` |
| `/partner` | Status, rejection reason, the next step, links | `GET /partner/profile` |
| `/partner/profile` | Business details; contact edit (always), legal/tax edit (only before verification); payout bank account, **masked only** | `GET`/`PATCH /partner/profile` |
| `/partner/verification` | Required-document groups of the type and which are satisfied; documents and review status; add a document (metadata only, gap 14); submit for verification | `GET /provider-types`, `GET`/`POST /partner/verification-documents`, `POST /partner/verification/submit` |
| `/partner/listings` | Own listings, every status, filter, paging | `GET /partner/listings` |
| `/partner/listings/new` | Type from active listing types; common fields + the type's detail fields; place picker | `GET /listing-types`, `GET /locations`, `POST /partner/listings` |
| `/partner/listings/[id]` | Details, allowed status moves (no self-approval), edit, **availability and prices** (show, add, update ranges) | `GET`/`PATCH /partner/listings/:id`, `GET`/`POST`/`PATCH …/slots` |
| `/partner/bookings` | Own bookings of submitted trips, status filter | `GET /partner/bookings` |
| `/partner/bookings/[id]` | Frozen money (subtotal, VAT, total, commission, your share), statuses, invoice, per-date lines, cancellation snapshot, masked guest contact; **settle at the property** with who/when | `GET /partner/bookings/:itemId`, `POST …/settle-at-property` |
| `/partner/invoices` | Commission invoices: number, status, issued date, amount, items | `GET /partner/invoices` |
| `/partner/payouts` | Read-only summary per month: total, commission, payout (= total − commission, ADR 0008), Pending | `GET /partner/payouts` |

Components: `components/partner/` (`partner-context.tsx`, `partner-ui.tsx` and one view file per
area). Logic: `lib/partner-access.ts`, `lib/partner-display.ts`, `lib/settle-state.ts`,
`lib/listing-forms.ts`, types in `lib/partner-types.ts`. Generic display pieces shared with the
admin console (`SectionNav`, `Panel`, `Facts`, `Pager`, table classes) live in
`components/ui/data.tsx`.

## Partner scoping, masking and idempotency in the UI

- **Scoping is the API's.** `PartnerProvider` sends every call to `/api/v1/partner…`; with several
  businesses it asks which one and sends `X-Provider-Id` (kept in memory). The UI never filters
  other providers' data. A 404, whether the item is missing or belongs to someone else, is shown
  as the same "Not found" (`partnerErrorView`), never as "access denied".
- **Role gate = navigation.** `partnerAccess()` shows customers the onboarding link and refuses
  admins; the API answers 403 to both anyway.
- **Masking:** `accountNumberMasked` and the guest's `emailMasked`/`phoneMasked` are shown as the
  API sends them. `safeMaskedAccountNumber` shows `••••` for anything that isn't a mask plus at most
  four characters. A new account number is cleared from the form as soon as it is sent.
- **Settle at the property** (`lib/settle-state.ts`): one `Idempotency-Key` per attempt, kept
  until the API confirms. "Try again" after a lost response re-sends the same key, and clicks in
  flight are ignored. Success is shown once, then the recorded who/when (`settledBy`,
  `settledAt`).
- **Overbooking and slot conflicts** (`409 CAPACITY_BELOW_BOOKED`, `INSUFFICIENT_AVAILABILITY`,
  `SLOT_EXISTS`) are shown next to the inventory form with the dates the API names, and
  "Nothing was changed."

## How the browser talks to the API

```
browser ──/api/v1/*──▶ server.mts ─▶ Next.js (same origin) ──rewrite──▶ API_URL/api/v1/*  (Express API)
           cookie: session (httpOnly)                                     sets / reads the cookie
           header: X-CSRF-Token on writes
           X-Forwarded-For: <whatever the client sent>, <address server.mts saw>   (appended)
```

- **`server.mts` (Phase 9, ADR 0014)** is the production web server behind `npm start`. It
  appends the connecting address to `X-Forwarded-For` before Next.js handles the request, because
  the rewrite proxy adds nothing of its own. The API trusts that one entry (`TRUST_PROXY_HOPS=1`
  from the web server's address), so login and registration limits and audit rows are per real
  client.
- Run the web app with `npm start`, never with plain `next start`, wherever per-client limits
  matter. `npm run dev` stays `next dev`.

- `lib/api-client.ts` sends `credentials: "include"` and `X-CSRF-Token` on POST, PATCH and DELETE.
  It turns error bodies into `ApiError`, including the `Retry-After` seconds of a 429.
- `components/auth/auth-provider.tsx` loads `GET /auth/me` once and keeps `{ user, csrfToken }` in
  memory. **Nothing is stored in `localStorage`.**
- Server-rendered public pages call the API server-to-server (`lib/server-api.ts`) without cookies.
- Owner scoping is the API's job: the UI shows "Trip not found" for a 404 and never assumes that
  hiding something is security.

## Routes (Phase 7, Track C: admin console)

All under `app/admin/`, client-rendered behind `RequireAuth` → `AdminGate` (layout), `noindex`.
Every call goes to `/api/v1/admin…` with the session cookie and, on writes, `X-CSRF-Token`.

| Route | What | API |
|---|---|---|
| `/admin` | Providers waiting for verification (count), links | `GET /admin/providers?status=PENDING_VERIFICATION` |
| `/admin/providers` | Every provider; filters: type, verification status (incl. suspended); paging | `GET /admin/providers` |
| `/admin/providers/[id]` | Profile, owner, payout account (**masked**), required-document groups with provided/missing, documents; **approve** (blocked while a group is missing) or **reject with a reason**; audit confirmation | `GET /admin/providers/:id`, `GET /provider-types`, `POST …/verification/approve\|reject`, `GET /admin/audit-log` |
| `/admin/invoices` | All commission invoices; filters: provider, status, issued date | `GET /admin/invoices` |
| `/admin/payouts` | Read-only summary across providers: total, commission, payout (= total − commission), "Pending · not executed" | `GET /admin/payouts` |
| `/admin/audit-log` | Newest first; filters: actor, action, entity, date; before/after per field; actor by name | `GET /admin/audit-log` |
| `/admin/listing-rules` | Read-only listing rules per provider type (Phase 8, ADR 0013) | `GET /admin/provider-types` |

Components: `components/admin/` (`admin-ui.tsx`: gate, nav, `useAdminData`; one view file per
area). Logic: `lib/admin-access.ts`, `lib/audit-display.ts`, types in `lib/admin-types.ts`.

### Phase 8 additions (gaps 22 and 25)

- **Partner listing form:** the "Kind of listing" choices are the profile's
  `providerType.allowedListingTypes` (mapped to the business's type and active, ADR 0013), via
  `listingTypeChoices()`. Parents are loaded per container type the business may list. A business
  that may list nothing sees a message. The API's `422 LISTING_TYPE_NOT_ALLOWED` names what it may
  list.
- **Admin lists** (`lib/admin-lists.ts`): the URL holds the filters (`readListQuery`, `listHref`).
  - Providers have one search form: `q`, status, kind (including types not offered) and order.
  - Invoices and payouts replace the 100-provider dropdown with a text search, plus `providerId`
    links from a provider page.
  - Pagers use the API's `totalPages`.
- **Audit log:** actors show as "Name (role)"; a row without a user shows "MeroStay system"
  (`auditActorLabel`).
- **`/admin/listing-rules`:** a read-only table of every provider type, whether it is offered, its
  mapped listing types with flags, and what is usable now.

### Phase 10 additions (gaps 23 and 14)

| Where | What |
|---|---|
| `/partner/cancellation-policies` (new) | The business's policies (summary, on/off, where used), the default for listings, and a form with a tier editor (hours + refund %; or non-refundable). The tier rules are checked in the browser (`lib/cancellation-policy.ts`) and again by the API |
| `/partner/listings/[id]` | "Cancellation policy" panel on bookable listings: this listing's policy, "use my default (…)" or none. When none applies, a warning (booking is not blocked) |
| Listing page, trip, partner booking | One `CancellationTerms` component. A listing shows the policy that applies **now**, with its source ("This listing's policy" / "The provider's standard policy"). A trip item or a partner booking shows the copy **fixed when booked**. No policy is said explicitly |
| `/partner/verification` | Upload: choose a PDF/JPEG/PNG up to 10 MB → request → `PUT` the file (`apiRequest` `rawBody`) → confirm, with step labels. Rows show file name and status; "Open" (fetched with the session and `X-Provider-Id`, saved as a download), "Send for review" (uploaded, not confirmed), "Delete" (not approved, not under review) |
| `/admin/providers/[id]` | "Open file" per uploaded document (a plain link: the API checks the admin role and audits the view), and a read-only cancellation policies panel |
| `server.mts` | Refuses `/api/v1` bodies above 10 MB + 64 KB with 413 before Next.js buffers them (Next would cut them; `experimental.proxyClientMaxBodySize` is the same number) |

## Admin guard and audit handling in the UI

- **Guard = navigation.** `adminAccess()`: a visitor goes to login. A logged-in customer or
  partner sees "Page not found", the same as any unknown URL; there is no "Admin" link for them.
  The API answers 403 to them for every `/admin` call, and that is the security. An API 404 or 403
  inside the console also reads as "not found".
- **Approval block.** The review page shows the type's required groups against the provider's
  documents (the same `requirementChecklist` and rule as the API). With a group missing it shows
  "Approval is blocked: no document for …" and disables Approve. The API refuses a forced approval
  with `409 REQUIRED_DOCUMENTS_MISSING`, shown the same way.
- **Audit confirmation.** After approve or reject, the page reads the newest matching audit entry
  back from the API and shows its time and action, with a link to the filtered log.
- **Audit rendering.** `auditRows()` flattens `before`/`after` into string rows that React renders
  as text: never HTML. No file uses `dangerouslySetInnerHTML`, which a unit test checks. As a
  backstop, secret-looking keys show `[hidden]` and account numbers are re-masked.

## Money

Every amount arrives as a digit string with `currency` and `currencyExponent`. `lib/money.ts`
formats it with string operations only:

| API value | Display |
|---|---|
| `"115500"`, NPR, 2 | `Rs. 1,155.00` |
| `"123456700"`, NPR, 2 | `Rs. 12,34,567.00` (Nepali grouping) |
| `"123450"`, USD, 2 | `USD 1,234.50` |
| `"9007199254740993"`, NPR, 2 | `Rs. 9,00,71,99,25,47,409.93` (exact above 2^53) |

The UI never adds or multiplies money. Totals, quotes and the split between pay online and pay at
the property all come from the API, and so do the partner figures (commission, your share,
invoice amounts, payouts). Prices typed in rupees (search filters, listing prices, date prices)
become minor-unit strings via `majorInputToMinor`; percentages become basis points via
`percentInputToBps`, both with string operations.

## State

No global store. The only app-wide state is the auth context. Pages fetch what they need: Server
Components on the server for public data, small effects in Client Components for account data.
Forms use native inputs and `FormData`.

## Tests

| Kind | Where | Covers |
|---|---|---|
| Unit (Vitest) | `src/lib/*.test.ts` | Phase 13 (`phase13-logic.test.ts`): categories (never flights), search titles, illustrative images, trip steps, `Rs.` formatting. Money formatting (incl. > 2^53), price input, search query building (no inactive types), auth state, safe `next` paths, API client (credentials, CSRF on writes, errors, Retry-After), quote and totals rows, cancellation rules, calendar window, config, health check. Track C (`admin-logic.test.ts`): admin guard and 404/403 → not found, the blocked-approval message, money and masking reuse, audit rows (flattening, literal markup, secret hiding, re-masking), no `dangerouslySetInnerHTML` in any source file. Track B (`partner-logic.test.ts`): partner money reuse, rupees → minor units, percent ⇄ bps, masked bank display (never more than 4 characters), partner route guard and 404 → not-found, `X-Provider-Id` + CSRF headers, settle key reuse and one-time success, document checklist, detail fields, inventory error messages, Nepal "today" |
| E2E (Playwright) | `e2e/booking.spec.ts`, `e2e/partner.spec.ts`, `e2e/admin.spec.ts`, `e2e/admin-ops.spec.ts`, `e2e/payments.spec.ts`, `e2e/policies-documents.spec.ts`, `e2e/home.spec.ts` | The customer booking journey, the partner dashboard journey and the admin console journey on desktop and mobile Chromium; non-admins get "Page not found" (API 403); protected pages redirect to login; Phase 1 home and health checks. Phase 9: the admin journey sends a forged `X-Forwarded-For` on every request and checks the audit row shows the address the web server saw. **Runs in CI on every push** ([ci.md](../development/ci.md)) |

Run the booking journey against a **disposable** database (never dev):

```bash
E2E_DATABASE_URL="postgresql://…/scratch" npm run test:e2e:booking
```

It builds the web app for an API on port 4100, starts the API (4100, with the simulated payment
gateway) and web app (3100) fresh, seeds a test world (`apps/api/src/testing/e2e-world.ts`, which
refuses the dev database; it includes a partner, an admin and a customer with random passwords,
and pending providers for the admin journey), and runs all E2E tests.
The partner journey books through the API first (one night at the property, one paid online),
then checks the dashboard. It simulates a lost settle response and asserts the retry sends the
same key and is recorded once. Without `E2E_DATABASE_URL`, `npm run test:e2e` runs only the Phase 1 checks. After a
booking run, rebuild (`npm run build`) before `npm start`, because the build points at port 4100.

## Accessibility and mobile

- Semantic landmarks, labelled inputs, `role="alert"` and `role="status"` messages.
- Visible focus outlines (teal), 44 px minimum touch targets.
- Layouts work from 360 px wide; the E2E suite also runs on a Pixel 7 profile.
- Contrast: navy and charcoal for text and buttons; teal and mint only as accents.
