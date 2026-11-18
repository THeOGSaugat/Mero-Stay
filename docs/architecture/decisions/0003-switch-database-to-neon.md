# 0003. Switch the database from local Docker PostgreSQL to Neon

- **Status:** Accepted
- **Date:** 2026-11-18
- **Phase:** 01 (on branch `phase/01-foundation`, before merge to `main`)
- **Supersedes in part:** the "Database" row of [ADR 0002](0002-phase-1-tooling-and-runtime-choices.md)
  (PostgreSQL 17 in Docker). ADR 0002 is left unchanged as a historical record.

## Context

Phase 1 ran PostgreSQL in Docker Compose. In practice this caused friction: a password
mismatch between the root `.env` (read by Docker) and `apps/api/.env` (read by the API)
produced authentication failures (`28P01`), and Docker's password is fixed when its volume is
first created, so fixing `.env` later did not help. It also required every developer to run
Docker Desktop. No business tables or data exist yet, so nothing needed migrating.

## Decision

1. **Use Neon (hosted PostgreSQL) for local development and production.** No local Docker.
2. **Two connection strings**, both with `sslmode=require`:
   - `DATABASE_URL`: **pooled** (host contains `-pooler`). Used by the running API.
   - `DATABASE_URL_UNPOOLED`: **direct**. Used by the Prisma CLI (`prisma.config.ts`),
     future migrations and integration tests. The Prisma CLI does not work through
     Neon's pooler.
3. **Keep the standard `pg` driver adapter** (`@prisma/adapter-pg`). `@prisma/adapter-neon` is
   for serverless/edge runtimes without TCP; this is a long-running Node server.
   Revisit if the API moves to a serverless/edge platform.
4. **CI keeps its own temporary PostgreSQL service container** and uses **no Neon secrets**.
5. **Production refuses to start** if `DATABASE_URL` lacks `sslmode=require`.

## Alternatives considered

- **Keep Docker and fix the password setup:** works, but keeps the Docker dependency and the
  same class of mistake (two files that must agree).
- **CI against a Neon branch:** needs a Neon API key stored as a GitHub secret and creates
  hosted resources per run. Rejected for now: CI needs no secrets today.
- **Use only the pooled URL for everything:** the Prisma CLI/migrations fail through PgBouncer.

## Consequences

- Developers need a (free) Neon project and must paste two connection strings into `apps/api/.env`.
- Local development, tests and the dev database are shared hosted state: integration tests are
  read-only, and Phase 2 must add a **separate Neon branch/database for tests** before tests write data.
- Neon scales idle databases to zero; the first request after idle can take a few seconds,
  which can make `/api/health/ready` (3 s timeout) report "unavailable" once. Retry resolves it.
- Credentials are real secrets: only in git-ignored `.env` files, never in commits or CI.
- CI's temporary PostgreSQL still uses a localhost connection string inside the CI job only.
