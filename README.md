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

- **`SESSION_SECRET` is required**: the API refuses to start without it. Generate a separate value
  per environment (`openssl rand -base64 48`), store it in the host's secret manager, never in Git.
  Rotating it only invalidates CSRF tokens (clients re-fetch them from `GET /api/v1/auth/me`).
- **Serve the API over HTTPS.** With `NODE_ENV=production` session cookies are `Secure` with the
  `__Host-` prefix, and `SESSION_COOKIE_SECURE=false` is refused.
- Trips (booking) endpoints always require a logged-in user and only show a user their own trips
  (ADR 0006). Search stays public.
- Login/registration rate limits are kept in process memory: run **one** API instance until a
  shared store is added, and configure the proxy's client IP before relying on per-IP limits (see
  operational gaps).
- **Run the hold-release job** (ADR 0007), otherwise abandoned trips keep their inventory held:
  either schedule `node apps/api/dist/scripts/hold-release.js` every minute with the platform's
  cron/scheduler, or run `node apps/api/dist/scripts/hold-release.js --watch` as one always-on worker
  process. It is idempotent and safe if two runs overlap. It needs only `DATABASE_URL`.
- **Online payments:** leave `PAYMENT_GATEWAY` unset in production (the simulated test gateway is
  refused there; payment endpoints answer 503). Live eSewa/Khalti come in a later phase.
- **Admins** are users with role `ADMIN`, set directly in the database by an operator (no endpoint
  grants it): `UPDATE users SET role = 'ADMIN' WHERE email = '…';`. Use it sparingly.
- Set `NODE_ENV=production`; the API then also requires `sslmode=require` in `DATABASE_URL`.
- Apply migrations with `npm run db:migrate` (uses the direct database URL) before starting a new release.
- Known gaps before launch: [docs/development/operational-gaps.md](docs/development/operational-gaps.md).

## License

Proprietary. All rights reserved.
