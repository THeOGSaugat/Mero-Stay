# Architecture Overview

> Rules are binding; see [CLAUDE.md](../../CLAUDE.md) §3. Phase 1 implemented the skeleton below
> (web, API, PostgreSQL, health checks). `packages/shared` is planned for the auth phase
> (see [ADR 0002](decisions/0002-phase-1-tooling-and-runtime-choices.md)).
> Setup instructions: [local-setup.md](../development/local-setup.md).
>
> **Database provider:** PostgreSQL hosted on [Neon](https://neon.tech)
> ([ADR 0003](decisions/0003-switch-database-to-neon.md)). The API connects through Neon's pooled
> endpoint; the Prisma CLI uses the direct endpoint.
>
> **How web talks to the API today:** Next.js Server Components call the API over HTTP using the
> server-only `API_URL` (read at request time). Browsers never call the API directly yet, so no
> CORS is needed.

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

## API module layout

Existing: `app.ts`, `server.ts`, `config/`, `lib/`, `middleware/` (error + 404), `modules/health/`,
`domain/` (pure rules: money/commission, booking-item status transitions), `db/` (sample seed),
`testing/` (test-database harness). Everything else below is planned.

```
apps/api/src/
├── app.ts              # express app (middleware, routes)
├── server.ts           # starts the HTTP server
├── config/             # Zod-validated environment, database URL helpers
├── domain/             # pure business rules shared by services (no I/O)
├── lib/                # prisma client, logger, errors
├── middleware/         # auth, role guard, error handler, rate limit
└── modules/            # one per domain, NOT per vertical
    ├── health/
    ├── auth/
    ├── providers/      # onboarding + verification for every provider type
    ├── listings/       # all listing types; per-vertical validation plugs in here
    ├── inventory/
    ├── search/
    ├── trips/          # trip + booking items
    ├── payments/
    ├── finance/        # commission invoices, payouts
    ├── reviews/
    ├── notifications/
    └── admin/
```

Each module contains `*.routes.ts`, `*.controller.ts`, `*.service.ts`, `*.repository.ts` and `*.test.ts`.

## Core data model: Listing → Trip → BookingItem

MeroStay is multi-vertical, so the core tables are **vertical-agnostic**
([ADR 0004](decisions/0004-multi-vertical-data-model.md); full reference in [data-model.md](data-model.md)):

```
Provider (hotel, bus operator, guide, ...) ──< Listing (typed by ListingType) ──< InventorySlot (per date)
                                                  │ 1:1 optional *_details table (hotel room, bus route, ...)
User (customer) ──< Trip ──< BookingItem >── Listing
                              ├──< BookingItemSlot >── InventorySlot   (per-date units and prices)
                              ├── commission, payment status, cancellation policy snapshot, payout
                              └──< PaymentAllocation >── Payment
```

- A **Listing** is anything sellable. Its `listing_type` (a lookup row, not a column per vertical)
  says what kind; vertical-specific fields live in an optional **detail table** or the
  `attributes` JSON.
- A **Trip** is one customer order; its **BookingItems** can be different types from different
  providers. Money, payment status, cancellation and commission are tracked **per item**; trip
  totals are stored sums.
- Adding a vertical **adds** a listing-type row and optionally a detail table. `listings`,
  `trips` and `booking_items` never change. That's why the model is future-proof.

## Cross-cutting concerns

- **Money:** 64-bit integers (`BIGINT`, `bigint` in TypeScript) in minor units (paisa) plus an ISO currency code; rates in basis points; computed only on the server and re-checked by database CHECK constraints.
- **Time:** UTC in storage, `Asia/Kathmandu` for display; stay dates as `DATE`.
- **Concurrency:** booking creation increments `inventory_slots.capacity_booked` in a transaction; a CHECK constraint makes overbooking impossible.
- **Errors:** uniform `{ error: { code, message, details? } }` shape.
- **Observability:** structured logs with request IDs; no secrets/PII in logs.

See [decisions/](decisions/) for the reasoning behind these choices.
