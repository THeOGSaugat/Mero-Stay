# 0010. Web frontend architecture

- **Status:** Accepted
- **Date:** 2026-11-23
- **Phase:** 07 (Track A)

## Context

`apps/web` (Next.js 16 App Router, Cache Components, React 19, Tailwind 4) becomes the customer
site, and later the partner and admin dashboards. The API (Phases 3–6) authenticates with an
**httpOnly session cookie** plus an `X-CSRF-Token` header (ADR 0006), returns money as
**minor-unit strings** (ADR 0005), and owns every business rule. The web app must not access the
database, must not store tokens in `localStorage`, and must stay light for mobile data in Nepal.

## Decisions

### 1. Same-origin API through a Next.js rewrite

`next.config.ts` rewrites `/api/v1/:path*` to `${API_URL}/api/v1/:path*`. Browsers only ever call
their own origin:

- the session cookie is first-party: `SameSite=Lax`, and `Secure` + `__Host-` in production all
  work unchanged;
- no CORS allow-list and no backend change are needed;
- the API stays the only component that touches the database.

**`API_URL` is baked into the build.** Next.js writes the rewrite target into the build output, so
`API_URL` must be set at **build** time and at run time (for server rendering). A build made for
one API (e.g. the E2E build on port 4100) must be rebuilt before it's used with another.

**Consequence:** behind the proxy, every request reaches the API from the web server's address. The
API's per-IP rate limits then apply to all users together until forwarded client IPs are trusted
(operational gap 5).

### 2. Server Components for public pages, Client Components for account pages

| Page | Rendering | Data |
|---|---|---|
| `/`, `/search`, `/listings/[id]` | Server, at request time inside `<Suspense>` (Cache Components) | `lib/server-api.ts` calls `API_URL` directly with no cookies: public data only, good for SEO and a light first load |
| `/login`, `/register`, `/trip`, `/trips`, `/trips/[id]` | Client Components (inside `<Suspense>`, because they read search params) | `lib/api-client.ts`: same-origin `fetch` with `credentials: "include"`, `X-CSRF-Token` on writes |

- The search form is a plain GET form, so it works without JavaScript.
- "Add to trip" is a small Client Component on the otherwise server-rendered listing page.

### 3. Auth state in memory only

`AuthProvider` loads `GET /auth/me` once and keeps `{ user, csrfToken }` in React state.

- Login and register replace that state; logout calls the API, then clears it.
- Nothing is written to `localStorage`, `sessionStorage` or readable cookies.
- `RequireAuth` redirects logged-out visitors to `/login?next=…`. That is navigation convenience,
  not security: the API answers 401, and 404 for other users' trips.
- `safeNextPath` accepts only same-site relative paths, so the `next` parameter cannot become an
  open redirect.

### 4. Money stays a string end to end

`lib/money.ts` formats the API's digit strings with **string operations only**: split by the
currency exponent, Nepali digit grouping for NPR (`Rs 12,34,567.00`), and international grouping
for other currencies.

- It never converts money to a JS `number`, so it stays exact above 2^53. A unit test checks
  `9007199254740993`.
- The UI computes no totals: every total shown is the API's.
- Price filters typed in rupees are converted to minor-unit strings, also with string operations,
  before they reach the API.

### 5. Data, not code per vertical

- **Search filters** come from `GET /listing-types`. Only active, bookable types are offered, so
  flights and hotel containers are absent.
- **Single date or date range** for a booking is decided by the listing type's `unitLabel`: `night`
  and `day` take a range.
- **Detail fields** are rendered generically from the API's `details` and `attributes` objects.

### 6. Testing

- **Unit tests (Vitest, node):** all logic lives in pure modules under `src/lib/` and is tested
  there: money formatting, search query building, auth state, `next` paths, the API client and
  error messages, quote and totals rows, cancellation rules. No DOM library was added.
- **E2E (Playwright):** the booking journey runs against a **disposable** database
  (`E2E_DATABASE_URL`, refused if it is the dev database), seeded with the integration-test
  fixture. It uses its own ports (API 4100, web 3100) so it can't collide with `npm run dev`, never
  reuses a running server, and checks through the proxy that it reaches the seeded API before it
  starts. Run it with `npm run test:e2e:booking`. The Phase 1 checks still run in every mode.

## Alternatives considered

- **CORS with the API on its own origin:** needs a backend change, an allow-list, and cross-site
  cookie care; the proxy avoids all three.
- **A data-fetching library (SWR, React Query):** a new dependency for a handful of client
  fetches. Plain `fetch` with small effects is enough for Track A; revisit for the dashboards if
  needed.
- **`Intl.NumberFormat` with `BigInt`:** it would work, but grouping depends on the runtime's ICU
  data. The string formatter is tiny and behaves the same on every runtime.
- **Testing Library + jsdom for components:** more dependencies. Logic is unit-tested and the
  rendered pages are covered by the E2E journey.

## Consequences

- One small backend addition, approved by the owner: `GET /api/v1/trips` (the customer's own
  trips), used by the trip builder and history.
- New operational gaps: no locations endpoint for a province → town picker; the E2E journey is not
  in CI; per-IP rate limits behind the proxy (gap 5 extended).
- Deployment: set `API_URL` for both `npm run build` and `npm start` of `apps/web`.
