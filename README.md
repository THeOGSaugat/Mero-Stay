# MeroStay

**MeroStay** is a Nepal-focused accommodation booking marketplace for hotels, guesthouses and homestays.

> Status: **Phase 1, project foundation.** Web app, API, database and CI are set up; product
> features start in later phases. See the [roadmap](docs/development/roadmap.md).

## Who it serves

- **Customers:** search, book and pay for stays across Nepal
- **Hotel partners:** list properties, manage rooms, pricing, availability and bookings
- **MeroStay admins:** approve properties and oversee the marketplace

## Tech stack

Next.js · React · TypeScript · Tailwind CSS · Node.js · Express · PostgreSQL · Prisma · Vitest · Playwright

## Documentation

- [CLAUDE.md](CLAUDE.md) — project rules, architecture, security and conventions (start here)
- [docs/](docs/README.md) — full documentation index

## Getting started

Requires Node.js 24+ (26 recommended) and a free [Neon](https://neon.tech) PostgreSQL project.

```bash
npm install
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local
# paste your Neon connection string into apps/api/.env (DATABASE_URL)

npm run db:generate    # generate the Prisma client
npm run db:check       # verify the Neon connection
npm run dev            # API → http://localhost:4000, web → http://localhost:3000
```

Tests: `npm test` · `npm run test:integration` · `npm run test:e2e`

Full guide, including troubleshooting: [docs/development/local-setup.md](docs/development/local-setup.md)

## Deployment notes

- **`ALLOW_UNAUTHENTICATED_TRIPS_API` must stay `false` (or unset) on every public deployment.**
  Until authentication arrives (Phase 4), the trip endpoints take a `userId` in the request body and
  check no ownership. The default is **off** in every environment: `/api/v1/trips…` returns
  `403 TRIPS_API_DISABLED`. Set it to `true` only on your own machine to try the trip API; the
  API logs a warning at startup whenever it is on.
- Set `NODE_ENV=production`; the API then also requires `sslmode=require` in `DATABASE_URL`.
- Apply migrations with `npm run db:migrate` (uses the direct database URL) before starting a new release.
- Known gaps before launch: [docs/development/operational-gaps.md](docs/development/operational-gaps.md).

## License

Proprietary. All rights reserved.
