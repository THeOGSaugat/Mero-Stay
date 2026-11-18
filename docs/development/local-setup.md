# Local Development Setup

How to install, configure, run and test MeroStay on your machine.

## 1. Prerequisites

| Software | Version | Check with |
|---|---|---|
| Node.js | 24 or newer (project pins **26** in `.nvmrc`) | `node -v` |
| npm | 11 or newer (comes with Node) | `npm -v` |
| Docker Desktop | Any recent version, **running** | `docker info` |
| Git | Any recent version | `git --version` |

A local PostgreSQL install is **not** needed; the database runs in Docker.

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
├── docker-compose.yml            # Local PostgreSQL
├── playwright.config.ts
├── tsconfig.base.json            # Shared strict TypeScript settings
└── package.json                  # npm workspaces + root scripts
```

## 3. First-time setup

```bash
# 1. Install all workspace dependencies (root, api, web)
npm install

# 2. Create your local environment files from the examples
cp .env.example .env                       # Docker Compose (PostgreSQL credentials)
cp apps/api/.env.example apps/api/.env     # API
cp apps/web/.env.example apps/web/.env.local  # Web

# 3. Choose a local database password: set the SAME value in
#    .env (POSTGRES_PASSWORD) and apps/api/.env (inside DATABASE_URL).

# 4. Start PostgreSQL and generate the Prisma client
npm run db:up
npm run db:generate

# 5. Verify Prisma can reach the database
npm run db:check
#   ✔ Prisma connected to PostgreSQL at localhost:5432/merostay in 53 ms

# 6. (Once) download the browser used by end-to-end tests
npm run test:e2e:install
```

> `.env`, `apps/api/.env` and `apps/web/.env.local` are git-ignored. Never commit them.

## 4. Environment variables

| File | Variable | Purpose |
|---|---|---|
| `.env` | `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | Credentials for the Docker PostgreSQL container |
| `.env` | `POSTGRES_PORT` | Host port for PostgreSQL (default `5432`) |
| `apps/api/.env` | `DATABASE_URL` | PostgreSQL connection string used by Prisma (**required**) |
| `apps/api/.env` | `PORT` | API port (default `4000`) |
| `apps/api/.env` | `NODE_ENV` | `development` / `test` / `production` |
| `apps/api/.env` | `LOG_LEVEL` | `fatal` … `trace`, or `silent` (default `info`) |
| `apps/web/.env.local` | `API_URL` | API base URL for server-side rendering. Server-only; required in production |

The API validates its variables on startup and exits with a clear message listing any
invalid ones (without printing their values).

## 5. Daily commands

| Command | What it does |
|---|---|
| `npm run db:up` | Start PostgreSQL (waits until healthy) |
| `npm run db:down` | Stop PostgreSQL. **Data is kept** in the `merostay-pgdata` volume |
| `npm run db:logs` | Follow PostgreSQL logs |
| `npm run db:check` | Verify Prisma ↔ PostgreSQL connectivity |
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
| `npm run test:integration` | Vitest integration tests against real PostgreSQL | **Yes** |
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
| `failed to connect to the docker API … docker.sock` | Docker Desktop is not running. Start it and wait until `docker info` succeeds |
| `Set POSTGRES_PASSWORD in .env` from Docker Compose | Create the root `.env` from `.env.example` |
| `port is already allocated` / port 5432 in use | Another PostgreSQL is running. Set `POSTGRES_PORT=5433` in `.env` **and** change the port in `DATABASE_URL` in `apps/api/.env` |
| Port 3000 or 4000 in use | Find the process: `lsof -nP -iTCP:3000 -sTCP:LISTEN`, then stop it |
| `Invalid environment configuration: DATABASE_URL: is required` | Create `apps/api/.env` from its example |
| `npm run db:check` → `password authentication failed` | Password in `DATABASE_URL` doesn't match `POSTGRES_PASSWORD`. Note: the password is fixed when the Docker volume is **first** created; changing `.env` later doesn't change it (see the reset note below) |
| `Cannot find module '../generated/prisma/client.js'` | Run `npm run db:generate` |
| `LayoutProps` / route type errors in the web app | Run `npm run typecheck` (it runs `next typegen` first) |
| Status panel shows **API Unavailable** | API isn't running or `API_URL` in `apps/web/.env.local` is wrong |
| Status panel shows **Database Unavailable** | Run `npm run db:up`, then `npm run db:check` |
| Playwright: `Executable doesn't exist` | Run `npm run test:e2e:install` |

**Resetting the local database** (⚠ deletes all local data): `docker compose down -v` then
`npm run db:up`. Only ever do this against your local Docker database.
