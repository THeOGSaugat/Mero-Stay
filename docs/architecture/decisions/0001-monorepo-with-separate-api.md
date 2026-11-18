# 0001. Monorepo with a separate Express API

- **Status:** Proposed (to be confirmed by the owner before Phase 1)
- **Date:** 2026-11-18
- **Phase:** 0

## Context

MeroStay needs a web frontend (Next.js) and a backend (Express) sharing TypeScript types and validation.
Future plans include mobile apps and new verticals (tours, bus, flights) that will need the same backend.

## Decision

1. **One repository (monorepo)** using **npm workspaces**: `apps/web`, `apps/api`, `packages/shared`.
2. **Express owns all business logic and database access.** Next.js is a UI layer that calls the API.
3. **Zod schemas in `packages/shared`** are the single definition of request/response contracts.
4. **Prisma lives in `apps/api`** only.

## Alternatives considered

- **Next.js only (Route Handlers + Server Actions, no Express):** simpler deploy, but couples business
  logic to the web framework and makes reuse by mobile apps awkward. Express was also specified in the stack.
- **Two separate repositories:** duplicated types and harder coordinated changes for a small team.
- **pnpm / Turborepo:** good tools, but npm is already installed and enough at this size; we can add
  Turborepo later if build times grow.

## Consequences

- Clear separation; the API can serve web, mobile and future products.
- Two deployable services instead of one, so CORS and cookie settings need care.
- Shared package must stay framework-agnostic (no React or Express imports).
