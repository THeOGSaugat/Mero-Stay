# MeroStay web app (`apps/web`)

Next.js 16 (App Router, Cache Components, Turbopack), React 19, Tailwind 4. Decisions:
[ADR 0010](decisions/0010-web-frontend-architecture.md). Design tokens: `src/app/globals.css`
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

The partner dashboard (Track B) and admin dashboard (Track C) follow after their approvals.

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
the property all come from the API. Price filters typed in rupees become minor-unit strings via
`majorInputToMinor`.

## State

No global store. The only app-wide state is the auth context. Pages fetch what they need: Server
Components on the server for public data, small effects in Client Components for account data.
Forms use native inputs and `FormData`.

## Tests

| Kind | Where | Covers |
|---|---|---|
| Unit (Vitest) | `src/lib/*.test.ts` | Money formatting (incl. > 2^53), price input, search query building (no inactive types), auth state, safe `next` paths, API client (credentials, CSRF on writes, errors, Retry-After), quote and totals rows, cancellation rules, calendar window, config, health check |
| E2E (Playwright) | `e2e/booking.spec.ts`, `e2e/home.spec.ts` | The booking journey on desktop and mobile Chromium; a protected page redirects to login; Phase 1 home and health checks |

Run the booking journey against a **disposable** database (never dev):

```bash
E2E_DATABASE_URL="postgresql://…/scratch" npm run test:e2e:booking
```

It builds the web app for an API on port 4100, starts the API (4100) and web app (3100) fresh,
seeds a test world (`apps/api/src/testing/e2e-world.ts`, which refuses the dev database), and runs
all E2E tests. Without `E2E_DATABASE_URL`, `npm run test:e2e` runs only the Phase 1 checks. After a
booking run, rebuild (`npm run build`) before `npm start`, because the build points at port 4100.

## Accessibility and mobile

- Semantic landmarks, labelled inputs, `role="alert"` and `role="status"` messages.
- Visible focus outlines (teal), 44 px minimum touch targets.
- Layouts work from 360 px wide; the E2E suite also runs on a Pixel 7 profile.
- Contrast: navy and charcoal for text and buttons; teal and mint only as accents.
