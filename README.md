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
- **Client IP and rate limits (ADR 0014).** Set `TRUST_PROXY_HOPS` and `TRUST_PROXY_ADDRESSES`
  on the API. In production they are **required**; `true`, `*` and `/0` ranges are refused.
  - Web server and API on one host: `1` and `loopback`.
  - Separate hosts: `1` and the web server's private address or subnet.
  - An edge or load balancer in front of the web server: `2` and the web server's **and** the
    edge's addresses. The edge must **append** to `X-Forwarded-For`, not replace it.
  - Limits are per client: login 30 / 15 min and registration 5 / hour per client IP, login
    10 / 15 min per email.
- Rate-limit counters are kept in process memory: run **one** API instance until a shared store is
  added (operational gap 4).
- **Verification documents (ADR 0016)** are private files. Set `STORAGE_DRIVER` (required in
  production):
  - `s3` with `S3_BUCKET` and `S3_REGION` (plus `S3_ENDPOINT` for Cloudflare R2, MinIO or
    Backblaze). The bucket must block all public access. Use least-privilege keys
    (`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`, kept in the secret manager) or an instance role.
  - `local` with an absolute, backed-up `STORAGE_LOCAL_DIR` outside any web root, for one
    instance only.
  - Files are only ever served by the API to the owning partner and to admins.
  - Uploads are at most 10 MB; the web server refuses larger `/api/v1` bodies, matching
    `experimental.proxyClientMaxBodySize` in `apps/web/next.config.ts`.
  - Not yet covered: malware scanning, backup and retention (operational gaps 26–28).
- **Run the hold-release job** (ADR 0007), otherwise abandoned trips keep their inventory held:
  either schedule `node apps/api/dist/scripts/hold-release.js` every minute with the platform's
  cron/scheduler, or run `node apps/api/dist/scripts/hold-release.js --watch` as one always-on worker
  process. It is idempotent and safe if two runs overlap. It needs `DATABASE_URL` and the payment
  settings (it asks eSewa/Khalti about payments of holds about to end; ADR 0017).
- **Online payments (ADR 0017):** set `PAYMENT_GATEWAYS=esewa,khalti` (`simulated` is refused),
  `PAYMENT_MODE=production`, the production eSewa product code and secret, the Khalti live secret
  key (from the secret store, never a committed file) and `PUBLIC_WEB_URL` (the public https web
  origin customers return to). The API refuses to start without them, or with the test URL
  overrides. Run `npm run payment:sandbox-check -w @merostay/api` with sandbox keys first; sandbox
  credentials: [docs/development/payments.md](docs/development/payments.md).
- **Admins:** the FIRST admin is created by an operator in the database (`UPDATE users SET role =
  'ADMIN' WHERE email = '…';` for an account with a password). Further admins are added in the
  console (Admins → Add admin): it shows a one-time setup link (24 h) to hand over in person or by
  phone; the new admin chooses their own password (ADR 0018). The last active admin can never be
  suspended.
- **Payouts** (ADR 0018): once a month, Payouts → Prepare payouts for last month, Schedule each
  batch (the provider's bank account must be verified), make the bank transfer outside MeroStay,
  then Record as paid with the bank's reference. The hold-release job also re-checks closed
  eSewa/Khalti payments, so it must keep running. Scheduling deducts clawbacks of voided paid-out
  bookings from the provider's batch (ADR 0020).
- **Refunds** (ADR 0020): Refund requests → Approve → Refund through Khalti (its refund API, the
  same secret key), or for eSewa start a manual refund, refund in the eSewa merchant portal and
  record its reference. Confirm Khalti's refund amounts in the sandbox before going live (launch
  checklist). Customers cancel their own bookings from the trip page; the refund follows the
  booking's frozen policy, counted from the actual start time (check-in, departure, start).
- **Web app (`apps/web`):** set `API_URL` (the API's base URL) for **both** `npm run build` and
  `npm start`. Browsers call `/api/v1/*` on the web origin and Next.js proxies it to `API_URL`; the
  proxy target is fixed at build time (ADR 0010).
  - Start it with **`npm start`**, which runs `apps/web/server.mts`. That is the Next.js production
    server plus one step: it appends the connecting address to `X-Forwarded-For`, which the API's
    per-client limits rely on.
  - Plain `next start` forwards a client's header unchanged and adds nothing.
  - It listens on `PORT` (default 3000).
- Set `NODE_ENV=production`; the API then also requires `sslmode=require` in `DATABASE_URL`.
- Apply migrations with `npm run db:migrate` (uses the direct database URL) before starting a new release.
- Known gaps before launch: [docs/development/operational-gaps.md](docs/development/operational-gaps.md).

## License

Proprietary. All rights reserved.
