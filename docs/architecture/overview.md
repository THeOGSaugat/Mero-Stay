# Architecture Overview

> Target architecture. Code is created starting in Phase 1. Rules are binding; see [CLAUDE.md](../../CLAUDE.md) §3.

## Components

```
            ┌──────────────────────────────┐
 Browser ──▶│  apps/web  (Next.js, React)  │   SSR public pages, dashboards (customer/partner/admin)
            └──────────────┬───────────────┘
                           │ HTTPS  /api/v1/*  (JSON, httpOnly cookies)
            ┌──────────────▼───────────────┐
 Future  ──▶│  apps/api  (Express, TS)     │   ALL business logic, auth, authorization
 mobile     │  routes → controllers →      │
 apps       │  services → repositories     │
            └───────┬──────────────┬───────┘
                    │ Prisma       │ HTTPS (server-to-server)
            ┌───────▼──────┐  ┌────▼─────────────────┐
            │  PostgreSQL  │  │ eSewa / Khalti, email │
            └──────────────┘  │ SMS, object storage   │
                              └──────────────────────┘

 packages/shared: Zod schemas, types and enums used by both web and api
```

## Responsibilities

| Component | Owns | Must NOT |
|---|---|---|
| `apps/web` | Rendering, routing, forms, client-side UX | Access the DB, hold secrets, enforce business rules alone |
| `apps/api` | Validation, auth, authorization, pricing, availability, bookings, payments | Render HTML |
| `packages/shared` | Contracts (Zod), enums, pure helpers | Import from either app |
| PostgreSQL | Persistent state, integrity constraints | n/a |

## API module layout (planned)

```
apps/api/src/
├── app.ts              # express app (middleware, routes)
├── server.ts           # starts the HTTP server
├── config/env.ts       # Zod-validated environment
├── lib/                # prisma client, logger, errors
├── middleware/         # auth, role guard, error handler, rate limit
└── modules/
    ├── auth/
    ├── users/
    ├── properties/
    ├── rooms/
    ├── availability/
    ├── search/
    ├── bookings/
    ├── payments/
    └── admin/
```

Each module contains `*.routes.ts`, `*.controller.ts`, `*.service.ts`, `*.repository.ts` and `*.test.ts`.

## Core domain entities (planned; finalised in the data-model phase)

`User` (role) · `PartnerProfile` · `Property` · `PropertyPhoto` · `Amenity` · `Location`
`RoomType` · `RoomRate` / `DailyInventory` · `Booking` · `BookingItem` · `Payment` · `AuditLog`

## Cross-cutting concerns

- **Money:** integer paisa; computed only on the server.
- **Time:** UTC in storage, `Asia/Kathmandu` for display; stay dates as `DATE`.
- **Concurrency:** booking creation locks inventory rows in a transaction.
- **Errors:** uniform `{ error: { code, message, details? } }` shape.
- **Observability:** structured logs with request IDs; no secrets/PII in logs.

See [decisions/](decisions/) for the reasoning behind these choices.
