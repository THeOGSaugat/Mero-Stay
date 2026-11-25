# Local Development Setup

How to install, configure, run and test MeroStay on your machine.

## 1. Prerequisites

| Software | Version | Check with |
|---|---|---|
| Node.js | 24 or newer (project pins **26** in `.nvmrc`) | `node -v` |
| npm | 11 or newer (comes with Node) | `npm -v` |
| Neon account | Free tier is enough | https://neon.tech |
| Git | Any recent version | `git --version` |

No local PostgreSQL or Docker is needed; the database is hosted on Neon.

## 2. Project structure

```
mero-stay/
├── apps/
│   ├── api/                      # Express API (@merostay/api)
│   │   ├── prisma/schema.prisma  # Database schema (no models yet)
│   │   ├── prisma.config.ts      # Prisma CLI config (reads DATABASE_URL)
│   │   └── src/
│   │       ├── app.ts            # Express app factory (middleware + routes)
│   │       ├── server.ts         # Process entry: env, DB client, listen, shutdown
│   │       ├── config/env.ts     # Zod-validated environment variables
│   │       ├── lib/              # prisma client, logger, errors, helpers
│   │       ├── middleware/       # error handler, 404 handler
│   │       ├── modules/health/   # /api/health and /api/health/ready
│   │       ├── scripts/db-check.ts
│   │       └── generated/        # Prisma client (generated, git-ignored)
│   └── web/                      # Next.js app (@merostay/web)
│       └── src/
│           ├── app/              # App Router pages, layout, global CSS
│           ├── components/       # React components
│           └── lib/              # config + API client helpers
├── e2e/                          # Playwright end-to-end tests
├── docs/                         # Documentation
├── .github/workflows/ci.yml      # GitHub Actions
├── playwright.config.ts
├── tsconfig.base.json            # Shared strict TypeScript settings
└── package.json                  # npm workspaces + root scripts
```

## 3. First-time setup

```bash
# 1. Install all workspace dependencies (api, web)
npm install

# 2. Create a Neon project at https://neon.tech (any region; choose PostgreSQL 17).
#    In the Neon console press "Connect" and copy the connection string (pooled).
#    It must end with ?sslmode=require

# 3. Create your local environment files and paste the strings in
cp apps/api/.env.example apps/api/.env
#    edit apps/api/.env: also set SESSION_SECRET (required by the API server):
#      SESSION_SECRET=$(openssl rand -base64 48)
cp apps/web/.env.example apps/web/.env.local
#    edit apps/api/.env: paste the string as DATABASE_URL (the only value to change)

# 4. Generate the Prisma client and verify the Neon connection
npm run db:generate
npm run db:check
#   ✔ Pooled (API runtime): Prisma connected to ep-….neon.tech/… in 412 ms
#   ✔ Direct (Prisma CLI): Prisma connected to ep-….neon.tech/… in 389 ms

# 5. Create the tables in your dev database, and (optionally) add sample data
npm run db:migrate
npm run db:seed        # sample providers, listings and two trips; refuses to run twice

# 6. Set up the separate TEST database (see "Test database" below)

# 7. (Once) download the browser used by end-to-end tests
npm run test:e2e:install
```

> `apps/api/.env`, `apps/api/.env.test` and `apps/web/.env.local` are git-ignored and contain
> real credentials. Never commit them, paste them into chat, or share screenshots of them.

### Test database

Integration tests **delete everything** in their database and rebuild it from the migrations on
every run, so they use a **separate** database, never your dev data.

1. In the Neon console, open your project → **Branches** → **Create branch**, name it `test`
   (branch from `main`; it is free and isolated).
2. On the `test` branch press **Connect** and copy its **pooled** connection string.
3. `cp apps/api/.env.test.example apps/api/.env.test` and paste it as `TEST_DATABASE_URL`.
4. Run `npm run test:integration`.

Safety: the tests read **only** `TEST_DATABASE_URL`, never `DATABASE_URL`; they never load
`apps/api/.env`; and they **refuse to run** if the test URL points at the same database as
`DATABASE_URL`. CI uses its own temporary PostgreSQL instead of Neon.

## 4. Environment variables

| File | Variable | Purpose |
|---|---|---|
| `apps/api/.env` | `DATABASE_URL` | Neon **pooled** connection string used by the running API (**required**; must include `sslmode=require` in production) |
| `apps/api/.env` | `DATABASE_URL_UNPOOLED` | *Optional.* Direct connection used by the Prisma CLI. Normally leave unset: it is derived from `DATABASE_URL` by removing `-pooler` from the host |
| `apps/api/.env` | `PORT` | API port (default `4000`) |
| `apps/api/.env` | `NODE_ENV` | `development` / `test` / `production` |
| `apps/api/.env` | `LOG_LEVEL` | `fatal` … `trace`, or `silent` (default `info`) |
| `apps/api/.env.test` | `TEST_DATABASE_URL` | Pooled URL of the **test** Neon branch. Wiped by every integration test run |
| `apps/api/.env.test` | `TEST_DATABASE_URL_UNPOOLED` | *Optional.* Derived from `TEST_DATABASE_URL` like the dev one |
| `apps/api/.env` | `SESSION_SECRET` | **Required by the API server.** ≥ 32 characters; signs CSRF tokens. Generate: `openssl rand -base64 48`. Never commit it |
| `apps/api/.env` | `SESSION_TTL_HOURS` | *Optional.* Session lifetime in hours (default 168 = 7 days) |
| `apps/api/.env` | `SESSION_COOKIE_SECURE` | *Optional.* HTTPS-only cookie. Default `true` in production (where `false` is refused), `false` locally |
| `apps/api/.env` | `PAYMENT_GATEWAY` | *Optional.* `simulated` enables the test-mode payment gateway for local development (ADR 0007). Unset = online payment endpoints return 503. Refused in production |
| `apps/api/.env` | `HOLD_RELEASE_INTERVAL_SECONDS` | *Optional.* Seconds between hold-release runs in watch mode (default 60) |
| `apps/web/.env.local` | `API_URL` | API base URL for server-side rendering. Server-only; required in production |

The API validates its variables on startup and exits with a clear message listing any
invalid ones (without printing their values).

## 5. Daily commands

| Command | What it does |
|---|---|
| `npm run db:check` | Verify Prisma ↔ Neon connectivity (pooled and direct) |
| `npm run db:generate` | Regenerate the Prisma client after editing `schema.prisma` |
| `npm run db:migrate` | Apply pending migrations to the dev database (`prisma migrate deploy`, direct URL) |
| `npm run db:migrate:status` | Show which migrations are applied |
| `npm run db:seed` | Insert sample data into the dev database (once) |
| `npm run dev` | Start API (http://localhost:4000), web (http://localhost:3000) **and** the hold-release worker, with reload |
| `npm run dev:api` / `npm run dev:web` | Start just one of them (no worker) |
| `npm run jobs:hold-release` | Release inventory held by abandoned trips once, then exit |
| `npm run jobs:hold-release:watch` | Same, every `HOLD_RELEASE_INTERVAL_SECONDS` until stopped (Ctrl+C) |
| `npm run build` | Production build of API and web |
| `npm start` | Run the production builds (after `npm run build`) |

Open http://localhost:3000. The **System status** panel should show Web app, API and
Database as **Operational**.

### Scheduled jobs (ADR 0007)

The **hold-release job** gives back inventory held by abandoned trips (draft or unpaid trips whose
30-minute hold has passed). In development `npm run dev` runs it every minute. In production run
the built script either from the platform's scheduler every minute
(`node apps/api/dist/scripts/hold-release.js`, exits when done) or as one always-on worker
(`node apps/api/dist/scripts/hold-release.js --watch`). Overlapping runs are safe: each stale trip
is released exactly once (`FOR UPDATE SKIP LOCKED`). It needs only `DATABASE_URL`. CI does not run
it on a schedule; its behaviour is covered by `src/jobs/*.test.ts`.

### Trying payments locally

Set `PAYMENT_GATEWAY=simulated` in `apps/api/.env`, confirm a trip with online items, then
`POST /api/v1/trips/:id/payments/intent` and `POST /api/v1/trips/:id/payments/:paymentId/confirm`
(optionally `{"capturedAmountMinor": "100000"}` for a partial payment). See
[api.md](../architecture/api.md#payments-adr-0007). To use the admin endpoints, promote your local
user: `UPDATE users SET role = 'ADMIN' WHERE email = 'you@example.com';`.

## 6. Quality checks and tests

| Command | What it does | Needs DB? |
|---|---|---|
| `npm run format` | Format all files with Prettier | No |
| `npm run format:check` | Check formatting (CI) | No |
| `npm run lint` | ESLint for API and web | No |
| `npm run typecheck` | TypeScript for API, web and e2e | No |
| `npm test` | Vitest unit tests (API + web) | No |
| `npm run test:integration` | Wipes the **test** database, applies all migrations, then tests migrations, constraints, money maths against PostgreSQL, and the seed. CI uses a temporary PostgreSQL | **Test DB** |
| `npm run test:e2e` | Builds, starts both apps, runs Playwright (desktop + mobile) | **Yes** |

Run before every commit: `npm run format:check && npm run lint && npm run typecheck && npm test && npm run test:integration`.

Creating a migration: see [data-model.md → Working with migrations](../architecture/data-model.md#working-with-migrations).

Playwright HTML report: `npx playwright show-report`.

### End-to-end tests (Playwright)

| Command | What runs | Database |
|---|---|---|
| `npm run test:e2e` | Phase 1 home and health checks | The API's `apps/api/.env` (dev), read-only |
| `E2E_DATABASE_URL="postgresql://…" npm run test:e2e:booking` | The above + the customer booking journey (desktop and mobile Chromium) | **A disposable database only.** Migrated and seeded with a fresh test world; the seed refuses the dev database |

The booking run builds the web app for an API on port **4100** and starts the API (4100) and web app
(3100) itself, so it never touches a running `npm run dev`. Afterwards, run `npm run build` again
before `npm start`. Details: [frontend.md](../architecture/frontend.md#tests).

**CI runs the booking mode on every push** (Phase 9, gap 21) against its own PostgreSQL container:
[ci.md](ci.md). To reproduce CI's settings locally on an existing build:
`CI=1 E2E_DATABASE_URL="…disposable…" npx playwright test --workers=2`.

## 7. Health endpoints

| Endpoint | Meaning | Status codes |
|---|---|---|
| `GET /api/health` | Liveness: the API process is up. Does not touch the DB | `200` |
| `GET /api/health/ready` | Readiness: the API can reach PostgreSQL (3 s timeout) | `200` ready / `503` not ready |

## 8. Troubleshooting

| Problem | Fix |
|---|---|
| API exits: `SESSION_SECRET: is required` | Add `SESSION_SECRET=$(openssl rand -base64 48)` to `apps/api/.env` |
| Trip requests return `401` / `403 CSRF_TOKEN_INVALID` | Log in first (`POST /api/v1/auth/login`), keep the cookie, and send the `csrfToken` as `X-CSRF-Token` on writes. See [api.md](../architecture/api.md#authentication-adr-0006) |
| `TEST_DATABASE_URL is not set` | Create the Neon `test` branch and `apps/api/.env.test` (see "Test database") |
| `Refusing to run: TEST_DATABASE_URL points at the same database as DATABASE_URL` | Your test URL is your dev database. Use the `test` branch's connection string |
| `db:seed`: `Sample data is already present` | Expected on a second run; nothing was changed |
| Port 3000 or 4000 in use | Find the process: `lsof -nP -iTCP:3000 -sTCP:LISTEN`, then stop it |
| `Invalid environment configuration: DATABASE_URL: is required` | Create `apps/api/.env` from its example |
| `db:check`: `password authentication failed` | Wrong password in `DATABASE_URL`. Copy the string again from the Neon console (reset the role password there if needed) |
| `db:check`: timeout / `ECONNREFUSED` | Neon pauses idle databases; retry once. Check your internet connection and that the strings end with `?sslmode=require` |
| API exits: `DATABASE_URL: must include sslmode=require in production` | Add `?sslmode=require` to the connection string |
| `prisma` CLI commands fail through the pooler | They must use the direct URL, which `prisma.config.ts` derives from `DATABASE_URL` for you |
| `Cannot find module '../generated/prisma/client.js'` | Run `npm run db:generate` |
| `LayoutProps` / route type errors in the web app | Run `npm run typecheck` (it runs `next typegen` first) |
| Status panel shows **API Unavailable** | API isn't running or `API_URL` in `apps/web/.env.local` is wrong |
| Status panel shows **Database Unavailable** | Run `npm run db:check`. After idle, Neon can take a few seconds to wake; reload once |
| Playwright: `Executable doesn't exist` | Run `npm run test:e2e:install` |
| API exits: `TRUST_PROXY_HOPS: is required in production` (or `TRUST_PROXY_ADDRESSES`) | Production must state its proxy chain (ADR 0014). On one machine: `TRUST_PROXY_HOPS=1` and `TRUST_PROXY_ADDRESSES=loopback`. Development and tests default to exactly that |
| API exits: `TRUST_PROXY_ADDRESSES: "…" would trust every address` | `true`, `*` and `/0` ranges are refused on purpose. List the web server's (and any edge's) addresses or subnets |
| Everyone shares one login/registration limit in production | The web app runs under plain `next start`, or the trust settings don't match the topology. Use `npm start` (`apps/web/server.mts`) and see the README deployment notes |

**Resetting data:** use the Neon console (delete and recreate the branch or database). Never reset a database that holds data you need.
