# CLAUDE.md — MeroStay

This file is the operating manual for anyone (human or AI) working on MeroStay.
Read it fully before making changes. When this file and a request conflict, stop and ask.

---

## 1. Product summary

**MeroStay** is a Nepal-focused accommodation booking marketplace connecting travellers
with hotels, guesthouses and homestays across Nepal.

### Users

| Role | Description |
|---|---|
| `CUSTOMER` | Travellers who search, book and pay for stays |
| `PARTNER` | Hotel / homestay owners who list and manage properties |
| `ADMIN` | MeroStay staff who approve properties, moderate content and oversee bookings |

### MVP scope

1. Customer registration and login
2. Hotel partner registration
3. Property submission and admin approval
4. Hotel and homestay listings
5. Room management
6. Pricing and availability
7. Search and filters
8. Property details
9. Booking management
10. Customer dashboard
11. Hotel partner dashboard
12. Admin dashboard
13. Payment integration
14. Reviews and ratings (verified stays only)

### Business decisions (details: `docs/product/requirements.md` §6)

- **Decided by the owner:** MeroStay takes a **commission on every booking**; customers can pay
  **online or at the property**; **each property sets its own cancellation policy**.
- **Delegated to the tech lead (owner may override):** partner verification documents, reviews in
  the MVP (verified stays only), Sparrow SMS + Amazon SES for notifications.
- Open details (commission rate, how pay-at-property commission is collected, policy format) are
  raised with the owner at the start of the phase that needs them. **Never invent business policy.**

### Future (NOT in MVP — do not build until explicitly approved)

- Tour guides
- Bus tickets
- Flight tickets
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
- Never run destructive DB commands (`prisma migrate reset`, `DROP`, `TRUNCATE`) against anything except a disposable local DB, and announce it first.
- Ask before installing large or unusual dependencies; explain why each new dependency is needed.

---

## 3. Architecture

### 3.1 Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 16 (App Router, Cache Components, Turbopack) + React 19 + TypeScript |
| Styling | Tailwind CSS 4 (theme tokens in `apps/web/src/app/globals.css`) |
| Backend API | Node.js 26 + Express 5 + TypeScript (ESM, `NodeNext`) |
| Database | PostgreSQL 17 |
| ORM | Prisma 7 with `@prisma/adapter-pg`; URL configured in `apps/api/prisma.config.ts` |
| Validation | Zod 4 (API now; shared with web via `packages/shared` from the auth phase) |
| Unit / integration tests | Vitest 5 (+ Supertest for HTTP) |
| End-to-end tests | Playwright (desktop + mobile Chromium) |
| Local infrastructure | Docker Compose (PostgreSQL) |
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
├── docker-compose.yml       # Local PostgreSQL
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
- **Feature modules:** API code is grouped by domain (`modules/auth`, `modules/properties`,
  `modules/rooms`, `modules/bookings`, `modules/payments`, `modules/admin`), not by technical layer.
- **REST, versioned:** all endpoints under `/api/v1/...`. JSON in, JSON out.
- **Consistent error shape:** `{ "error": { "code": "BOOKING_UNAVAILABLE", "message": "...", "details"?: ... } }`.

### 3.4 Designing for future verticals

Tours, bus and flight tickets will be added later. To keep that possible without rewrites:

- Keep accommodation-specific logic inside its own modules; do not hard-code "hotel" into
  generic concepts like users, payments, reviews or notifications.
- Payments reference a generic "bookable" order, not a hotel-specific table.
- No mobile-specific code now — but the API stays stateless-friendly and documented so a
  mobile client can consume it.

### 3.5 Domain rules (non-negotiable)

- **Money is stored as integers in paisa** (1 NPR = 100 paisa) — never floats. Format only at display time.
- **All timestamps stored in UTC**; converted to `Asia/Kathmandu` for display.
- **Stay dates are calendar dates** (`DATE`), check-in inclusive, check-out exclusive (nights = checkout − checkin).
- **No double bookings.** Availability checks and booking creation happen in a single DB transaction
  with appropriate locking/constraints. This must have automated tests.
- **Prices are snapshotted on the booking** at creation time; later price changes never alter existing bookings.
- **Property lifecycle:** `DRAFT → PENDING_REVIEW → APPROVED | REJECTED`, plus `SUSPENDED`. Only `APPROVED` properties are publicly visible.
- **Booking lifecycle:** `PENDING_PAYMENT → CONFIRMED → CHECKED_IN → COMPLETED`, with `CANCELLED` / `EXPIRED` / `REFUNDED` branches. Transitions are enforced in the service layer.

---

## 4. Security rules

- **Secrets:** never hard-code or log API keys, passwords, tokens or connection strings. Load from
  environment variables, validated at startup with Zod. Commit only `.env.example` with placeholders.
- **Passwords:** hash with Argon2id (or bcrypt cost ≥ 12). Never store or log plaintext.
- **Sessions/auth:** tokens in `httpOnly`, `Secure`, `SameSite` cookies — not `localStorage`.
  Short-lived access tokens + rotating refresh tokens. Final design decided and documented in the auth phase.
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
- Integration tests run against a **separate test database**, never the dev database.
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
npm run db:up                # start PostgreSQL (Docker) and wait until healthy
npm run db:down              # stop PostgreSQL (data kept)
npm run db:generate          # regenerate Prisma client
npm run db:check             # verify Prisma ↔ PostgreSQL connectivity
npm run dev                  # API :4000 + web :3000 with reload
npm run build                # production builds
npm start                    # run production builds
npm run format | format:check
npm run lint
npm run typecheck            # api + web (runs next typegen) + e2e
npm test                     # unit tests (no DB needed)
npm run test:integration     # integration tests (needs DB)
npm run test:e2e             # build + Playwright (needs DB)
```

Before committing: `npm run format:check && npm run lint && npm run typecheck && npm test && npm run test:integration`.

---

## 9. Current status

- **Phase 0, Repository setup & documentation:** complete.
- **Phase 1, Project foundation & dev environment:** complete on branch `phase/01-foundation`, awaiting owner review.
- **Next:** Phase 2, Data model (awaiting approval).
