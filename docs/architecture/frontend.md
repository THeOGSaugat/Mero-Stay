# MeroStay web app (`apps/web`)

Next.js 16 (App Router, Cache Components, Turbopack), React 19, Tailwind 4. Decisions:
[ADR 0010](decisions/0010-web-frontend-architecture.md) (architecture, customer site) and
[ADR 0011](decisions/0011-partner-dashboard.md) (partner dashboard). Design tokens: `src/app/globals.css`
(palette from the owner's reference, [docs/design](../design/README.md)).

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
`lib/listing-forms.ts`, types in `lib/partner-types.ts`. The admin dashboard (Track C) follows after
its approval.

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
browser ──/api/v1/*──▶ Next.js (same origin) ──rewrite──▶ API_URL/api/v1/*  (Express API)
           cookie: session (httpOnly)                       sets / reads the cookie
           header: X-CSRF-Token on writes
```

- `lib/api-client.ts` sends `credentials: "include"` and `X-CSRF-Token` on POST, PATCH and DELETE.
  It turns error bodies into `ApiError`, including the `Retry-After` seconds of a 429.
- `components/auth/auth-provider.tsx` loads `GET /auth/me` once and keeps `{ user, csrfToken }` in
  memory. **Nothing is stored in `localStorage`.**
- Server-rendered public pages call the API server-to-server (`lib/server-api.ts`) without cookies.
- Owner scoping is the API's job: the UI shows "Trip not found" for a 404 and never assumes that
  hiding something is security.

## Money

Every amount arrives as a digit string with `currency` and `currencyExponent`. `lib/money.ts`
formats it with string operations only:

| API value | Display |
|---|---|
| `"115500"`, NPR, 2 | `Rs 1,155.00` |
| `"123456700"`, NPR, 2 | `Rs 12,34,567.00` (Nepali grouping) |
| `"123450"`, USD, 2 | `USD 1,234.50` |
| `"9007199254740993"`, NPR, 2 | `Rs 9,00,71,99,25,47,409.93` (exact above 2^53) |

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
| Unit (Vitest) | `src/lib/*.test.ts` | Money formatting (incl. > 2^53), price input, search query building (no inactive types), auth state, safe `next` paths, API client (credentials, CSRF on writes, errors, Retry-After), quote and totals rows, cancellation rules, calendar window, config, health check. Track B (`partner-logic.test.ts`): partner money reuse, rupees → minor units, percent ⇄ bps, masked bank display (never more than 4 characters), partner route guard and 404 → not-found, `X-Provider-Id` + CSRF headers, settle key reuse and one-time success, document checklist, detail fields, inventory error messages, Nepal "today" |
| E2E (Playwright) | `e2e/booking.spec.ts`, `e2e/partner.spec.ts`, `e2e/home.spec.ts` | The customer booking journey and the partner dashboard journey on desktop and mobile Chromium; protected pages redirect to login; Phase 1 home and health checks |

Run the booking journey against a **disposable** database (never dev):

```bash
E2E_DATABASE_URL="postgresql://…/scratch" npm run test:e2e:booking
```

It builds the web app for an API on port 4100, starts the API (4100, with the simulated payment
gateway) and web app (3100) fresh, seeds a test world (`apps/api/src/testing/e2e-world.ts`, which
refuses the dev database; it includes a partner with a random password), and runs all E2E tests.
The partner journey books through the API first (one night at the property, one paid online),
then checks the dashboard. It simulates a lost settle response and asserts the retry sends the
same key and is recorded once. Without `E2E_DATABASE_URL`, `npm run test:e2e` runs only the Phase 1 checks. After a
booking run, rebuild (`npm run build`) before `npm start`, because the build points at port 4100.

## Accessibility and mobile

- Semantic landmarks, labelled inputs, `role="alert"` and `role="status"` messages.
- Visible focus outlines (teal), 44 px minimum touch targets.
- Layouts work from 360 px wide; the E2E suite also runs on a Pixel 7 profile.
- Contrast: navy and charcoal for text and buttons; teal and mint only as accents.
