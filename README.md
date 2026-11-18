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

## License

Proprietary. All rights reserved.
