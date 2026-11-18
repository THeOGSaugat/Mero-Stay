# 0002. Phase 1 tooling and runtime choices

- **Status:** Accepted (pending owner review of Phase 1)
- **Date:** 2026-11-18
- **Phase:** 01

## Context

Phase 1 sets up the foundation. Several current package releases are very new or
pre-release, so each version and tool was checked before adoption.

## Decisions

| Area | Choice | Why |
|---|---|---|
| Node.js | 26 (`.nvmrc`), engines `>=24` | Current LTS line; all dependencies support it |
| Workspaces | npm workspaces (`apps/api`, `apps/web`) | Built into npm; no extra tool needed at this size |
| TypeScript | **5.9.3** (not 6.x/7.x) | `typescript-eslint` supports `<6.1`; Next's template targets `^5`; TS 6 changes defaults (`types: []`) |
| API module format | ESM (`"type": "module"`, `NodeNext`) | Native Node ESM; `tsc` output runs directly with `node` |
| API framework | Express **5.3** | Native async error handling; stack choice |
| ORM | Prisma **7.10.1** + `@prisma/adapter-pg` | npm's `latest` tag points to `8.0.0-rc` (a release candidate), so stable 7.x was chosen. Prisma 7 requires a driver adapter; URL lives in `prisma.config.ts` |
| Prisma output | `src/generated/prisma`, `importFileExtension = "js"`, git-ignored | Generated code compiles with `tsc` and runs on Node ESM |
| Database | PostgreSQL **17** (Docker, `postgres:17-alpine`) | Mature, fully supported by Prisma; bound to `127.0.0.1` only |
| Env validation | Zod 4 in `config/env.ts`; Node's built-in `process.loadEnvFile` | No `dotenv` dependency; errors never echo secret values |
| Logging | pino + pino-http, header redaction, request IDs | Structured JSON logs; `pino-pretty` only in development |
| Security middleware | helmet; JSON body limit 100 kB | Safe defaults from day one |
| Health checks | `/api/health` (liveness) and `/api/health/ready` (DB, 3 s timeout) | A DB outage marks the API "not ready" without causing restarts |
| Frontend | Next.js **16.4** (App Router, Cache Components, Turbopack), React 19.3, Tailwind 4.3 | Official `create-next-app` defaults |
| Web → API | Server-side `fetch` using server-only `API_URL` read at request time (`connection()`) | No CORS needed yet; one build works in any environment; future auth can use same-site cookies |
| Shared package | **Deferred** to the auth phase | Only one shared type exists today; adding a build step for it would be premature. `packages/shared` will hold Zod contracts once forms/endpoints exist |
| Tests | Vitest 5 (unit + `integration` project), Supertest, Playwright 1.65 (desktop + Pixel 7) | Integration tests use a real PostgreSQL; E2E runs production builds |
| Lint / format | ESLint 9 flat config (type-aware for API, `eslint-config-next` for web), Prettier 3 | ESLint 9 is what `eslint-config-next` 16 supports |
| CI | GitHub Actions on every push and PR, PostgreSQL service container | No repository secrets required |

## Consequences

- `npm run db:generate` must run after install (CI does this; documented for developers).
- When TypeScript-ESLint supports TS 6+, upgrade TypeScript in one step across the repo.
- Revisit Prisma 8 after it reaches a stable release.
- E2E tests are not yet in CI (they need browser download and both servers). Planned for
  when real user journeys exist.
