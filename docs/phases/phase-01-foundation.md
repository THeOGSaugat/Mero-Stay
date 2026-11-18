# Phase 01: Project Foundation & Development Environment

- **Status:** Awaiting review
- **Branch:** `phase/01-foundation`
- **Date completed:** 2026-11-18

## Scope (as approved)

Monorepo foundation only: Next.js + Tailwind web app, Express + TypeScript API, Docker
PostgreSQL, Prisma (no business models), ESLint/Prettier, Vitest/Playwright, GitHub Actions,
health checks end to end, documentation. **No product features.**

## What was built

- **Workspace:** npm workspaces (`apps/api`, `apps/web`), shared strict `tsconfig.base.json`,
  Prettier, `.nvmrc` (Node 26), root scripts for dev/build/lint/typecheck/test/db.
- **API:** Express 5 app factory with injected dependencies; Zod env validation; helmet; pino
  request logging with request IDs and header redaction; central error handler with uniform
  error shape; JSON 404; 100 kB body limit; graceful shutdown;
  `GET /api/health` (liveness) and `GET /api/health/ready` (DB check, 3 s timeout, 503 when down).
- **Database:** `docker-compose.yml` with PostgreSQL 17 (localhost-only port, health check,
  named volume); Prisma 7 + pg adapter; empty schema; `npm run db:check`.
- **Web:** Next.js 16 placeholder landing page (responsive), system-status panel rendered
  on the server at request time from the API readiness endpoint; server-only `API_URL`;
  baseline security headers; brand colours as replaceable theme tokens.
- **Tests:** API unit (23) + integration against real PostgreSQL (3); web unit (16);
  Playwright E2E on desktop + mobile Chromium (8).
- **CI:** `.github/workflows/ci.yml` on every push and pull request.
- **Docs:** local setup + troubleshooting guide, ADR 0002, updated CLAUDE.md, roadmap,
  architecture overview, business decisions in requirements §6.

## Important technical decisions

See [ADR 0002](../architecture/decisions/0002-phase-1-tooling-and-runtime-choices.md). Highlights:
- **Prisma 7.10.1, not 8:** npm's `latest` tag points to a release candidate.
- **TypeScript 5.9:** typescript-eslint does not support 6.1+/7 yet.
- **Liveness vs readiness split**, so a DB outage doesn't cause restart loops.
- **Web calls the API server-side** with `API_URL` read at request time: no CORS, one build for all environments.
- **`packages/shared` deferred** to the auth phase (only one shared type exists today).

## Verification (real results, 2026-11-18)

| Check | Result |
|---|---|
| `npm run format:check` | All files use Prettier code style |
| `npm run lint` | exit 0 (API + web) |
| `npm run typecheck` | exit 0 (API, web incl. `next typegen`, e2e) |
| `npm test` | API 23/23 passed, web 16/16 passed |
| `npm run test:integration` | 3/3 passed against PostgreSQL 17.12 |
| `npm run build` | API `tsc` OK; web: `/` built as Partial Prerender (static shell + dynamic status) |
| `npm run test:e2e` | 8/8 passed (desktop-chromium + mobile-chromium) |
| `npm run db:up` | `merostay-postgres` healthy, bound to `127.0.0.1:5432` |
| `npm run db:check` | `✔ Prisma connected to PostgreSQL at localhost:5432/merostay` |
| Production API (`node dist/server.js`) | `/api/health` 200; `/ready` 200 → **503 with DB stopped** → 200 after restart; 404 JSON; SIGTERM exit 0 |
| Web ↔ API (production) | Status panel: all Operational; DB stopped → "Database Unavailable"; API stopped → "API Unavailable / Database Unknown" |
| `npm run dev` | API and web both start; page shows all Operational |
| Log hygiene | Real DB password found 0 times in production logs |

## Security checklist

- [x] No secrets in any commit (staged diff scanned; real local password count 0)
- [x] `.env`, `apps/api/.env`, `apps/web/.env.local` ignored; examples contain placeholders only
- [x] Local DB password randomly generated, stored only in ignored files (mode 600)
- [x] PostgreSQL port bound to localhost only
- [x] Error responses never include internal error text; env errors never echo values
- [x] CI uses throwaway credentials for a disposable container; no repository secrets needed

## Known limitations / follow-ups

1. **`npm audit`: 16 "high" findings, all from ONE advisory:** picomatch ReDoS
   (GHSA-fc5q-39xc-vjpf, `picomatch <=4.0.7`). No patched release exists yet; npm's suggested
   "fix" is a downgrade of Vitest/typescript-eslint. Affects **dev tooling only** (ESLint, Vitest
   file globbing on our own patterns), not production code. Accepted; re-check each phase.
2. **E2E tests are not in CI yet.** They pass locally; adding them to CI (browser download +
   both servers) is planned for when real user journeys exist (roadmap Phase 14, or earlier if wanted).
3. **Workflow lint (actionlint) not run locally:** pulling its Docker image was blocked by the
   local permission policy. The workflow is validated by its first real run on GitHub.
4. **No Content-Security-Policy on the web app yet:** added once third-party scripts (maps,
   payment widgets) are known.
5. **Separate test database** not created yet; needed from Phase 2 when tests write data.
6. Placeholder landing page and colours until design references are provided.

## How to review

1. Follow [local-setup.md](../development/local-setup.md) from a fresh clone.
2. `npm run db:up && npm run db:check`, then `npm run dev` and open http://localhost:3000.
3. Run the checks: `npm run format:check && npm run lint && npm run typecheck && npm test && npm run test:integration && npm run test:e2e`.
4. Check the GitHub Actions run for branch `phase/01-foundation`.
