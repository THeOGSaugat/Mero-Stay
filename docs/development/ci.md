# Continuous integration

Workflow: [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml). It runs on every push and
pull request. A newer push to the same branch cancels the older run. **No secrets:** both jobs use
their own throwaway PostgreSQL container, and nothing in CI reaches Neon.

| Job | What it runs | Typical time |
|---|---|---|
| `verify`: format, lint, typecheck, test, build | Prettier, ESLint, TypeScript (API, web, e2e), unit tests, integration tests (wipes and migrates its container database), production build | ~1.5 min |
| `e2e`: E2E journeys (gap 21) | The whole Playwright suite on production builds, desktop and mobile Chromium | ~1.5–2 min (the suite itself ~20 s) |

The two jobs run in parallel; either failing fails the run.

## The E2E job (Phase 9)

1. **Database:** PostgreSQL 17 service container `merostay_e2e`. `E2E_DATABASE_URL` points at it.
   Playwright's global setup (`e2e/global-setup.ts` → `apps/api/src/testing/e2e-world.ts`) applies
   every migration and seeds a fresh test world. The seed refuses the dev database.
2. **Install:**
   - `npm ci` with the npm cache;
   - the Prisma client;
   - Chromium, cached in `~/.cache/ms-playwright` and keyed on the lockfile. Its system
     libraries are installed either way.
3. **Build:** `npm run build` with `API_URL=http://localhost:4100`. Next.js bakes the `/api/v1`
   rewrite target into the build (ADR 0010), so the build and the running servers use the same
   value.
4. **Run:** `npx playwright test`. Playwright starts the API (4100, `NODE_ENV=test`, simulated
   gateway, a random session secret, `TRUST_PROXY_HOPS=1` / `loopback`) and the web server (3100,
   `apps/web/server.mts`). Then it runs every spec:
   - Phase 1 home and health;
   - the customer, partner and admin journeys.
5. **On failure:**
   - the HTML report and traces are uploaded as `playwright-report-<run>-<attempt>` (kept 14
     days; download from the run's page);
   - the `github` reporter also writes each failure as an annotation on the run, so the reason is
     visible without downloading anything.

### Choices

- **Desktop and mobile on every push.** The suite takes about 20 s, so splitting it (desktop on
  PRs, both nightly) would save nothing worth the complexity.
- **Its own build.** The `verify` job builds with `API_URL=http://localhost:4000`. Reusing that
  build would mean an artifact hand-over between jobs and a second port convention, for about
  15 s saved.
- **No retries, traces on failure.** The journeys change data, so a retried journey fails for a
  different reason (for example, its provider is already approved). Each retried registration also
  spends the 5-per-hour limit; the suite registers 4 accounts per run. The first failure probe
  showed retries adding unrelated `429` failures.
  - CI therefore runs each test once and keeps the trace of every failing test
    (`trace: retain-on-failure`).
  - `failOnFlakyTests` is on in CI as a guard, should retries ever be added.
- **Tests must not depend on each other's order.** CI runs fewer workers than a laptop, so
  ordering differs. The first CI run found two hidden dependencies, and a 1-worker local run found
  a third (Phase 9 report). The fixture room's per-night capacity, shared by every spec, is written
  down in `e2e/admin.spec.ts` (`bookNights`).

### Proof that it fails

A scratch branch renamed the customer's "Add to trip" button: a real app change that no unit test
catches.

- **First probe (run 45637352496):**
  - the `e2e` job failed at `booking.spec.ts:87` ("waiting for getByRole('button', { name: 'Add
    to trip' })") on desktop and mobile;
  - the report and traces were uploaded;
  - `verify` passed.
- **Second probe (run 45638124103):** repeated after retries were removed. Exactly the two broken
  journeys failed and 18 passed, with nothing unrelated; the artifact was uploaded.

Both scratch branches were deleted afterwards.

### Running the same thing locally

```bash
E2E_DATABASE_URL="postgresql://…disposable…" npm run test:e2e:booking   # builds, then runs
CI=1 E2E_DATABASE_URL="…" npx playwright test --workers=2             # CI settings, existing build
```

Never point `E2E_DATABASE_URL` at the dev database (the seed refuses it).
