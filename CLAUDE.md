# CLAUDE.md — MeroStay

This file is the operating manual for anyone (human or AI) working on MeroStay.
Read it fully before making changes. When this file and a request conflict, stop and ask.

---

## 1. Product summary

**MeroStay** is a **multi-vertical Nepal travel marketplace**. A traveller books one **trip**
containing several **booking items** of different types from different providers: hotel and
homestay nights, bus seats, guides, tours/activities (flights later). MeroStay takes a
**15% commission per item**. Data model: `Listing → Trip → BookingItem`
(`docs/architecture/data-model.md`, ADR 0004).

### Users

| Role | Description |
|---|---|
| `CUSTOMER` | Travellers who search, book and pay for stays |
| `PARTNER` | Providers: hotels/homestays, bus operators, guides, tour/activity operators |
| `ADMIN` | MeroStay staff who verify providers, approve listings and oversee trips, payments and payouts |

### MVP scope

Verticals: **hotels/homestays, buses, guides, tours** (activities via the generic model).
**Flights are modelled in the schema but NOT built** (`listing_types.is_active = false`).

1. Customer registration and login
2. Partner (provider) registration and verification, for every provider type
3. Listing submission and admin approval (all MVP verticals)
4. Inventory, pricing and availability per date
5. Search and listing details per vertical
6. Multi-item trip booking with per-item payment choice (online or at property)
7. Payments (eSewa, Khalti), commission invoicing and provider payouts
8. Customer, partner and admin dashboards
9. Reviews and ratings (completed items only)
10. Notifications (Sparrow SMS, Amazon SES)

### Business decisions (details: `docs/product/requirements.md` §6)

- **Commission:** 15% of each item's **subtotal** (taxes excluded), per item, rounded half-up;
  trip total = sum of items. Deducted from the provider's share. Rate stored per item;
  listing → provider → platform default (1500 bps).
- **Payment:** per item, **online or pay at property**. Pay-at-property commission is invoiced.
- **Cancellation:** per item; the provider's/listing's policy is snapshotted onto the item.
- **Currency:** ISO code on listings, items and trips (NPR default); one currency per trip (MVP).
- **Delegated decisions (owner approved):** partner verification documents per provider type,
  verified reviews, Sparrow SMS + Amazon SES.
- Open details (invoice cadence, payout schedule, policy presets, tax confirmation) are raised
  with the owner in the phase that needs them. **Never invent business policy.**

### Future (NOT in MVP — do not build until explicitly approved)

- Flight booking and airline integrations (schema exists; no flows)
- Direct partner API integrations (bus operators, hotels, channel managers)
- Multi-currency trips, packages, bus seat maps
- Mobile applications (iOS / Android)

The architecture must leave room for these (see §3.4), but no code for them is written early.

### Nepal-specific context

- **Currency:** Nepalese Rupee (NPR). Display as `Rs. 4,500` / `NPR 4,500`.
- **Timezone:** `Asia/Kathmandu` (UTC+05:45 — note the 45-minute offset).
- **Payment providers:** eSewa and Khalti first; others (Fonepay, cards) later.
- **Phone numbers:** Nepali mobile format (`+977 98XXXXXXXX`), validated server-side.
- **Locations:** Province → District → City/Area (e.g. Gandaki → Kaski → Pokhara/Lakeside).
- **Connectivity:** many users are on mobile data — pages must be light and fast.
- **Language:** English first; structure UI strings so Nepali (ने) can be added later.

---

## 2. Development workflow (MANDATORY)

### 2.1 Phase-by-phase rules

1. **Work only on the phase the owner has approved.** Never start the next phase without explicit approval.
2. **Never build the entire project in one attempt.** Each phase is small, reviewable and shippable.
3. At the start of a phase: restate the scope, list the files you expect to touch, and flag open questions.
4. At the end of a phase:
   - Run lint, type-check and all tests. Report real output — **never claim something works without running it.**
   - Write a phase report in `docs/phases/phase-XX-<name>.md` (template in `docs/phases/_template.md`).
   - Run the pre-commit secret checklist (§2.3).
   - Commit and push to GitHub (§2.2).
   - Stop and wait for review.
5. If a phase reveals that the plan is wrong, stop and propose a change — do not silently expand scope.

The phase roadmap lives in [`docs/development/roadmap.md`](docs/development/roadmap.md).

### 2.2 Git & GitHub

- Remote: `origin` → `https://github.com/THeOGSaugat/Mero-Stay.git`
- Default branch: `main`. Work for a phase happens on `phase/XX-short-name`, then merges to `main` after review.
- Commit messages follow **Conventional Commits**:
  `feat(api): add property submission endpoint`, `fix(web): ...`, `docs: ...`, `chore: ...`, `test: ...`
- Never use an invented Git identity. Commits use the owner's configured `user.name` / `user.email`.
- Never force-push to `main`. Never rewrite published history without permission.
- Never commit: `.env*` (except `.env.example`), keys, credentials, `node_modules`, build output, coverage, uploads, DB dumps.

### 2.2.1 GitHub Contribution and Commit Strategy

- Aim for **2–4 meaningful commits per phase**, each an independently reviewable logical unit
  (e.g. "API foundation", "web app", "CI + docs").
- Each commit must be **self-consistent and tested**: its code, `package.json` and lockfile build
  and pass checks on their own. Never commit broken or untested work.
- **No artificial commits**: no empty, duplicate, trivial or split-for-count commits.
- Conventional Commit messages with a body explaining *what* and *why*.
- Review `git diff --cached` and run the secret checklist (§2.3) before **every** commit.
- Push the phase branch, confirm the push succeeded (local and remote hashes match) and check
  the CI result. Report commit hashes and messages in the phase report.
- Never overwrite or rewrite existing history; check `git status`, branch and remote first.

### 2.3 Pre-commit secret checklist

Before every commit:

```bash
git status --short                      # review every file being added
git diff --cached --name-only           # confirm nothing unexpected is staged
git diff --cached | grep -nEi "(api[_-]?key|secret|password|token|BEGIN (RSA|EC|OPENSSH) PRIVATE)" || echo "clean"
git check-ignore -v .env node_modules   # confirm ignore rules still work
```

Any hit must be inspected by a human. Placeholder values in `.env.example` are fine; real values are not.

### 2.4 Safety rules

- **Never overwrite existing work without checking it first** (read the file, check `git status`).
- **Never delete important files, migrations or data without explicit permission.**
- Never run destructive DB commands (`prisma migrate reset`, `DROP`, `TRUNCATE`) against any database except a disposable one, and announce it first. The **only** standing exception is the dedicated test database (`TEST_DATABASE_URL`, a separate Neon branch), which `npm run test:integration` wipes and rebuilds by design. Never point it at dev or production; the harness refuses if it matches `DATABASE_URL`.
- Ask before installing large or unusual dependencies; explain why each new dependency is needed.

---

## 3. Architecture

### 3.1 Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 16 (App Router, Cache Components, Turbopack) + React 19 + TypeScript |
| Styling | Tailwind CSS 4 (theme tokens in `apps/web/src/app/globals.css`) |
| Backend API | Node.js 26 + Express 5 + TypeScript (ESM, `NodeNext`) |
| Database | PostgreSQL on **Neon** (hosted; pooled URL for the API, direct URL for the Prisma CLI) |
| ORM | Prisma 7 with `@prisma/adapter-pg`; URL configured in `apps/api/prisma.config.ts` |
| Validation | Zod 4 (API now; shared with web via `packages/shared` from the auth phase) |
| Unit / integration tests | Vitest 5 (+ Supertest for HTTP) |
| End-to-end tests | Playwright (desktop + mobile Chromium) |
| Local infrastructure | None. No Docker; the database is Neon. CI uses a temporary PostgreSQL service container |
| Package management | npm workspaces |
| TypeScript | 5.9 (typescript-eslint does not support 6.1+/7 yet) |

Version choices and reasons: `docs/architecture/decisions/0002-phase-1-tooling-and-runtime-choices.md`.
Next.js 16 differs from older versions: read `apps/web/AGENTS.md` and the docs in
`node_modules/next/dist/docs/` before writing web code.

### 3.2 Repository layout

```
mero-stay/
├── apps/
│   ├── web/                 # Next.js frontend (customer, partner, admin UIs)
│   └── api/                 # Express REST API — owns ALL business logic + DB access
│       └── prisma/          # schema.prisma, migrations, seed
├── packages/
│   └── shared/              # (from the auth phase) Zod schemas, shared types, enums
├── e2e/                     # Playwright tests
├── .github/workflows/       # CI
├── docs/                    # Project documentation
├── CLAUDE.md
└── README.md
```

### 3.3 Key architectural decisions

- **Separate Express API, Next.js as the UI layer.** The Express API is the single source of
  truth for business rules and the only component that talks to the database. Next.js renders
  pages (server-side for SEO-critical public pages like listings and property details) and calls
  the API. *Why:* future mobile apps and other verticals (tours, bus, flights) can reuse the same API.
- **Next.js must not import Prisma** or access the database directly.
- **Layered API:** `routes → controllers → services → repositories (Prisma)`.
  - Routes: URL + middleware wiring only.
  - Controllers: parse/validate input (Zod), call a service, shape the HTTP response.
  - Services: business rules (pricing, availability, booking state machine). No `req`/`res`.
  - Repositories: Prisma queries only.
- **Shared contracts:** request/response Zod schemas live in `packages/shared` and are used by both apps.
- **Feature modules:** API code is grouped by domain (`modules/auth`, `modules/providers`,
  `modules/listings`, `modules/inventory`, `modules/trips`, `modules/payments`, `modules/finance`,
  `modules/admin`), not by technical layer and **not by vertical**. Pure rules live in `src/domain/`.
- **REST, versioned:** all endpoints under `/api/v1/...`. JSON in, JSON out.
- **Consistent error shape:** `{ "error": { "code": "BOOKING_UNAVAILABLE", "message": "...", "details"?: ... } }`.
- **Money in API responses is a digit string in minor units** (`"totalMinor": "957110"`) with `currency` and
  `currencyExponent`, produced by explicit serializers (ADR 0005). Never a JSON number; never a global BigInt patch.
- **Database constraint violations are mapped centrally** (`lib/database-errors.ts`) to 409/422; raw PostgreSQL text never reaches clients.
- **Trip writes** run in one transaction holding a row lock on the trip; inventory is reserved by atomic increments that the overbooking CHECK guards.
- **Trips are always authenticated and owner-scoped in the data layer** (`WHERE customer_id = session user`); another
  user's trip is a 404, never a 403. Customer responses never include commission or provider-payout data.
- **Payments (ADR 0007):** amounts are computed on the server; one open intent per trip; confirmation is idempotent;
  database guard triggers keep allocations ≤ captured and ≤ item total, item payment status = allocations, and
  invoice amount = linked commission. The simulated gateway is refused in production. `/admin…` requires role ADMIN.
- **Partners and admins (ADR 0008):** `/partner…` needs role PARTNER and acts for one owned provider (`X-Provider-Id`
  when several); another provider's data is a 404. Wrong role for an area is 403 before any data is read. Admin writes
  and sensitive partner writes call `recordAudit` inside their transaction (append-only, secrets redacted). Bank
  account numbers are only ever returned masked; partners see customers by name only. Retryable writes use
  `Idempotency-Key` (`lib/idempotency.ts`).
- **Web app (ADR 0010):** browsers call only `/api/v1/*` on the web origin, rewritten to the API (`API_URL`, baked in
  at build time), so the session cookie is first-party. Auth state (user + CSRF token) lives in memory, never in
  localStorage. Public pages are Server Components inside `<Suspense>`; account pages are Client Components. Money is
  formatted from the API's strings with string operations only (`apps/web/src/lib/money.ts`); the UI computes no totals.
- **Client IP behind the proxy (ADR 0014):** the production web server (`apps/web/server.mts`, `npm start`) appends the
  connecting address to `X-Forwarded-For`; plain `next start` would forward a client's header unchanged. The API's
  `trust proxy` is a function, **never `true`**: an entry counts only within `TRUST_PROXY_HOPS` and from
  `TRUST_PROXY_ADDRESSES` (both required in production). Rate limits are per client (IPv6 by /64); audit rows use
  the same IP (`lib/client-ip.ts`).

### 3.4 Multi-vertical design (ADR 0004)

- Core tables (`providers`, `listings`, `inventory_slots`, `trips`, `booking_items`, payments,
  payouts, reviews, notifications) are **vertical-agnostic**. Never add vertical-specific
  columns to them.
- A vertical is a `listing_types` row (lookup table, seeded by migration). Type-specific fields go
  in a 1:1 `*_details` table (when search must query them) or `listings.attributes` JSON.
- Adding a vertical must only **add** things: a listing-type row, optionally a detail table,
  validation/display code. Guide: `docs/architecture/data-model.md#adding-a-new-vertical`.
- Integration hooks exist (`integration_type`, `external_id`, `external_booking_ref`); the MVP is
  an aggregator: partners list their own inventory.
- No mobile-specific code now; the API stays stateless-friendly for future mobile clients.

### 3.5 Domain rules (non-negotiable)

- **Money is stored as 64-bit integers (`BIGINT`) in minor units** (paisa for NPR) **with an ISO currency code** — never
  floats. In TypeScript amounts are **`bigint`**, never `number` (numbers lose precision above 2^53). Rates are integer
  basis points. Use `src/domain/money.ts`; format only at display time. `bigint` does not serialise to JSON: convert at the API boundary.
- **Database CHECK constraints re-verify every money formula** (commission, VAT, totals, payout);
  never bypass or drop them.
- **All timestamps stored in UTC**; converted to `Asia/Kathmandu` for display.
- **Service dates are calendar dates** (`DATE`); ranges are start-inclusive, end-exclusive (nights = checkout − checkin).
- **No overbooking.** Bookings increment `inventory_slots.capacity_booked` in one DB transaction;
  a CHECK constraint rejects anything above capacity. This must have automated tests.
- **Prices, commission rate and cancellation policy are snapshotted on each booking item**;
  later changes never alter existing bookings.
- **Trip totals = sum of item amounts**, kept in sync by the service that writes items.
- **Listing lifecycle:** `DRAFT → PENDING_REVIEW → APPROVED | REJECTED`, plus `SUSPENDED`, `ARCHIVED`. Only `APPROVED` listings of an active listing type are public.
- **Booking item lifecycle:** `PENDING → CONFIRMED → IN_PROGRESS → COMPLETED`, with `CANCELLED` / `NO_SHOW` / `EXPIRED`.
  Payment and commission status changes follow `src/domain/booking-item-status.ts`.

---

## 4. Security rules

- **Secrets:** never hard-code or log API keys, passwords, tokens or connection strings. Load from
  environment variables, validated at startup with Zod. Commit only `.env.example` with placeholders.
- **Passwords:** hash with Argon2id (or bcrypt cost ≥ 12). Never store or log plaintext.
- **Sessions/auth (ADR 0006):** opaque session token in an `httpOnly`, `SameSite=Lax` cookie (`Secure` +
  `__Host-` prefix in production); only its SHA-256 is stored in `sessions`; logout deletes the row. State-changing
  requests with a session need `X-CSRF-Token`. Passwords: Argon2id (node:crypto, OWASP parameters). Never put
  tokens in `localStorage`. Never return password hashes: select users through `PUBLIC_USER_SELECT`.
- **Authorization on the server, every time.** Role checks (`CUSTOMER` / `PARTNER` / `ADMIN`) *and*
  ownership checks (a partner can only edit their own properties; a customer can only see their own bookings).
  Hiding a button in the UI is not authorization.
- **Validate all input** with Zod at the API boundary (body, params, query). Reject unknown fields.
- **SQL:** use Prisma's query builder. Raw SQL only with parameterized `Prisma.sql`, never string concatenation.
- **HTTP hardening:** `helmet`, strict CORS allow-list, rate limiting on auth and payment endpoints, body size limits.
- **Payments:** never trust the client about amount or status. Amount is computed on the server; payment
  status is confirmed by server-to-server verification with the provider. Handlers are idempotent.
- **File uploads (property photos):** validate MIME type and size, re-encode/strip metadata, random file
  names, store outside the web root / in object storage — never trust the original filename.
- **Errors:** never leak stack traces or internal details to clients in production.
- **PII:** collect only what is needed; never log full passwords, tokens, payment details or ID documents.
- **Dependencies:** run `npm audit` each phase; avoid unmaintained packages.

---

## 5. Coding conventions

### TypeScript
- `strict: true` everywhere. No `any` (use `unknown` + narrowing). No `@ts-ignore` without a comment explaining why.
- Prefer explicit return types on exported functions.
- Use `type` for unions/shapes, `interface` for extendable object contracts — be consistent within a module.
- No default exports except where a framework requires them (Next.js pages/layouts).

### Naming
- Files: `kebab-case.ts`; React components: `PascalCase.tsx`.
- Variables/functions: `camelCase`; types/components: `PascalCase`; constants/enums: `UPPER_SNAKE_CASE`.
- Prisma models `PascalCase` singular (`Property`, `Room`, `Booking`); DB tables mapped to `snake_case` plural.

### Frontend
- Server Components by default; add `"use client"` only when interactivity requires it.
- **Mobile-first, responsive** Tailwind layouts — every page must work from 360px wide upward.
- **Follow the owner's design references** in `docs/design/`. Do not invent a different visual style.
- Accessible by default: semantic HTML, labels on inputs, keyboard navigation, sufficient contrast, `alt` text.
- Optimise images (`next/image`), avoid heavy client bundles.

### Backend
- Async/await only; centralised error-handling middleware; no unhandled promise rejections.
- Structured logging (no `console.log` in committed code outside scripts).
- Config read once from a validated `env.ts`, never from `process.env` scattered through code.

### Formatting & linting
- ESLint + Prettier (configured in Phase 1). Code must pass `lint` and `typecheck` before commit.

---

## 6. Testing rules

- **Vitest** for unit and integration tests; **Supertest** for API endpoints; **Playwright** for end-to-end flows.
- Every phase adds tests for what it builds. Business rules (pricing, availability, booking transitions,
  authorization) must have unit tests.
- Integration tests run against a **separate test database** (`TEST_DATABASE_URL`, a Neon `test` branch locally; a temporary PostgreSQL in CI), never the dev database. The runner wipes it and applies all migrations each run.
- Critical E2E journeys (added as features land): register → search → book → pay; partner submits property;
  admin approves property.
- Never mark a phase complete with failing or skipped tests unless the owner has agreed and the reason is documented.

---

## 7. Documentation

| Path | Purpose |
|---|---|
| `docs/README.md` | Documentation index |
| `docs/product/requirements.md` | Users, MVP features, user stories |
| `docs/architecture/overview.md` | System architecture |
| `docs/architecture/data-model.md` | Entity reference, money formulas, how to add a vertical |
| `docs/architecture/api.md` | `/api/v1` endpoints, auth, money-as-string convention, error codes |
| `docs/development/operational-gaps.md` | Known gaps that must be closed before launch |
| `docs/architecture/decisions/` | Architecture Decision Records (ADRs) |
| `docs/development/roadmap.md` | Phase-by-phase plan |
| `docs/development/git-workflow.md` | Branching, commits, pushing |
| `docs/security/security-guidelines.md` | Detailed security practices |
| `docs/design/` | Design references supplied by the owner |
| `docs/phases/` | One report per completed phase |

When an important technical decision is made, add an ADR (`docs/architecture/decisions/NNNN-title.md`).

---

## 8. Commands

Full guide: `docs/development/local-setup.md`.

```bash
npm install                  # install all workspaces
npm run db:generate          # regenerate Prisma client
npm run db:check             # verify Prisma ↔ Neon connectivity (pooled + direct)
npm run db:migrate           # apply migrations to the dev database (direct URL)
npm run db:migrate:status    # show applied/pending migrations
npm run db:seed              # insert SAMPLE data into the dev database (once)
npm run dev                  # API :4000 + web :3000 with reload
npm run build                # production builds
npm start                    # run production builds
npm run format | format:check
npm run lint
npm run typecheck            # api + web (runs next typegen) + e2e
npm test                     # unit tests (no DB needed)
npm run test:integration     # integration tests: WIPES + migrates the TEST database
npm run test:e2e             # build + Playwright: Phase 1 checks (uses the dev API read-only)
E2E_DATABASE_URL=… npm run test:e2e:booking   # + booking journey on a DISPOSABLE database (never dev)
npm run jobs:hold-release    # release abandoned inventory holds once (cron); :watch = every 60 s (dev runs it)
```

Before committing: `npm run format:check && npm run lint && npm run typecheck && npm test && npm run test:integration`.

---

## 9. Current status

- **Phase 0, Repository setup & documentation:** complete.
- **Phase 1, Project foundation & dev environment:** complete, merged, tagged `v0.1.0`.
- **Phase 2, Multi-vertical data model:** complete, merged, tagged `v0.2.0`.
- **Phase 3, Search & booking API:** merged to `main`, tagged `v0.3.0`.
- **Phase 4, Authentication & ownership:** merged to `main`, tagged `v0.4.0`.
- **Phase 5, Payments, invoices & hold-release job:** merged to `main`, tagged `v0.5.0`.
  (Roadmap renumbered: payments moved ahead of provider onboarding at the owner's request.)
- **Phase 6, Partner & admin backend:** merged to `main`, tagged `v0.6.0`.
- **Phase 7, Web frontend:** merged to `main`, tagged `v0.7.0` (customer, partner and admin; ADRs 0009–0012).
- **Phase 8, Listing rules & admin lists:** merged to `main`, tagged `v0.8.0` (gaps 22 and 25, ADR 0013).
- **Phase 9, Rate limits behind the proxy & E2E in CI:** complete on branch `phase/09-rate-limits-e2e-ci`, awaiting
  owner review. Gap 5 closed (per-client limits behind the web proxy, ADR 0014) and gap 21 closed (Playwright
  journeys in CI on a disposable database, `docs/development/ci.md`). Neon end-of-phase run not clean: attempt 1 lost the
  endpoint; attempt 2 199/209 (one stalled request in partner-admin plus 9 dependent failures; that file passed 22/22 on
  Neon in attempt 1; local and CI integration green). Roadmap rows after 8 moved down by one
  (Hardening is Phase 17). 18 gaps open; **no launch blocker** (gap 4, the in-memory rate-limit store, matters only
  with more than one API instance). Admin moderation (gaps 9, 13, 15) is not yet scheduled.
- **Next:** owner review of Phase 9. Phase 10 only after approval.
