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
#    In the Neon console press "Connect" and copy TWO connection strings:
#      - the POOLED one   (host contains "-pooler")  -> DATABASE_URL
#      - the DIRECT one   (pooling switched off)     -> DATABASE_URL_UNPOOLED
#    Both must end with ?sslmode=require

# 3. Create your local environment files and paste the strings in
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local
#    edit apps/api/.env: set DATABASE_URL and DATABASE_URL_UNPOOLED

# 4. Generate the Prisma client and verify the Neon connection
npm run db:generate
npm run db:check
#   ✔ Pooled (API runtime): Prisma connected to ep-….neon.tech/… in 412 ms
#   ✔ Direct (Prisma CLI): Prisma connected to ep-….neon.tech/… in 389 ms

# 5. (Once) download the browser used by end-to-end tests
npm run test:e2e:install
```

> `apps/api/.env` and `apps/web/.env.local` are git-ignored and contain real credentials.
> Never commit them, paste them into chat, or share screenshots of them.

## 4. Environment variables

| File | Variable | Purpose |
|---|---|---|
| `apps/api/.env` | `DATABASE_URL` | Neon **pooled** connection string used by the running API (**required**; must include `sslmode=require` in production) |
| `apps/api/.env` | `DATABASE_URL_UNPOOLED` | Neon **direct** connection string used by the Prisma CLI, migrations and integration tests |
| `apps/api/.env` | `PORT` | API port (default `4000`) |
| `apps/api/.env` | `NODE_ENV` | `development` / `test` / `production` |
| `apps/api/.env` | `LOG_LEVEL` | `fatal` … `trace`, or `silent` (default `info`) |
| `apps/web/.env.local` | `API_URL` | API base URL for server-side rendering. Server-only; required in production |

The API validates its variables on startup and exits with a clear message listing any
invalid ones (without printing their values).

## 5. Daily commands

| Command | What it does |
|---|---|
| `npm run db:check` | Verify Prisma ↔ Neon connectivity (pooled and direct) |
| `npm run db:generate` | Regenerate the Prisma client after editing `schema.prisma` |
| `npm run dev` | Start API (http://localhost:4000) **and** web (http://localhost:3000) with reload |
| `npm run dev:api` / `npm run dev:web` | Start just one of them |
| `npm run build` | Production build of API and web |
| `npm start` | Run the production builds (after `npm run build`) |

Open http://localhost:3000. The **System status** panel should show Web app, API and
Database as **Operational**.

## 6. Quality checks and tests

| Command | What it does | Needs DB? |
|---|---|---|
| `npm run format` | Format all files with Prettier | No |
| `npm run format:check` | Check formatting (CI) | No |
| `npm run lint` | ESLint for API and web | No |
| `npm run typecheck` | TypeScript for API, web and e2e | No |
| `npm test` | Vitest unit tests (API + web) | No |
| `npm run test:integration` | Vitest integration tests against a real database (your Neon, read-only; CI uses a temporary PostgreSQL) | **Yes** |
| `npm run test:e2e` | Builds, starts both apps, runs Playwright (desktop + mobile) | **Yes** |

Run before every commit: `npm run format:check && npm run lint && npm run typecheck && npm test`.

Playwright HTML report: `npx playwright show-report`.

## 7. Health endpoints

| Endpoint | Meaning | Status codes |
|---|---|---|
| `GET /api/health` | Liveness: the API process is up. Does not touch the DB | `200` |
| `GET /api/health/ready` | Readiness: the API can reach PostgreSQL (3 s timeout) | `200` ready / `503` not ready |

## 8. Troubleshooting

| Problem | Fix |
|---|---|
| Port 3000 or 4000 in use | Find the process: `lsof -nP -iTCP:3000 -sTCP:LISTEN`, then stop it |
| `Invalid environment configuration: DATABASE_URL: is required` | Create `apps/api/.env` from its example |
| `db:check`: `password authentication failed` | Wrong password in `DATABASE_URL` / `DATABASE_URL_UNPOOLED`. Copy the strings again from the Neon console (reset the role password there if needed) |
| `db:check`: `DATABASE_URL_UNPOOLED is not set` | Add the direct connection string to `apps/api/.env` |
| `db:check`: timeout / `ECONNREFUSED` | Neon pauses idle databases; retry once. Check your internet connection and that the strings end with `?sslmode=require` |
| API exits: `DATABASE_URL: must include sslmode=require in production` | Add `?sslmode=require` to the connection string |
| `prisma` CLI commands fail through the pooler | They must use the **direct** URL (`DATABASE_URL_UNPOOLED`), which `prisma.config.ts` does already |
| `Cannot find module '../generated/prisma/client.js'` | Run `npm run db:generate` |
| `LayoutProps` / route type errors in the web app | Run `npm run typecheck` (it runs `next typegen` first) |
| Status panel shows **API Unavailable** | API isn't running or `API_URL` in `apps/web/.env.local` is wrong |
| Status panel shows **Database Unavailable** | Run `npm run db:check`. After idle, Neon can take a few seconds to wake; reload once |
| Playwright: `Executable doesn't exist` | Run `npm run test:e2e:install` |

**Resetting data:** use the Neon console (delete and recreate the branch or database). Never reset a database that holds data you need.
