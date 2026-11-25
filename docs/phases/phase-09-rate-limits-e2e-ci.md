# Phase 09: Rate limits behind the proxy & E2E in CI

- **Status:** complete, awaiting owner review. **The end-of-phase Neon run is not clean.**
  Attempt 1: the test endpoint disappeared. Attempt 2: 199/209, with one stalled request in
  `partner-admin` (see below).
- **Branch:** `phase/09-rate-limits-e2e-ci`
- **Date:** 2026-11-25

## Scope (as approved)

Close **gap 5** (per-IP rate limits were one global limit behind the web proxy; the last launch
blocker) and **gap 21** (E2E journeys not in CI): backend, web server, CI, tests and docs. Nothing
else.

**Not built (confirmed):**

- live payment gateway, refunds, payout execution;
- reviews, notifications;
- OAuth, 2FA, email verification and reset;
- cancellation policies (gap 23), document uploads (gap 14);
- admin moderation (gaps 9, 13, 15).

Phase 10 has not been started.

## What was built

### Gap 5: per-client limits behind the proxy (ADR 0014)

**The finding that shaped the fix.** Checked on Next.js 16.4.6 with `next start` in front of an
echo server, the rewrite proxy forwarded a client's `X-Forwarded-For` **unchanged** and added
**nothing**:

- with no header, the API got none;
- a forged header arrived as written.

So enabling Express `trust proxy` alone would have let every browser pick its own bucket.

| Part | What |
|---|---|
| Web server `apps/web/server.mts` (`npm start`) | Next.js's custom-server API plus one step: **appends** the connecting address to `X-Forwarded-For` before Next handles the request (`src/lib/forwarded-for.mts`). Never overwrites; an unknown peer is written as `unknown`. Node runs it with type stripping. Checked through the real rewrite: nothing → `::ffff:127.0.0.1`; `198.51.100.7` → `198.51.100.7, ::ffff:127.0.0.1` |
| Trusted chain (`lib/client-ip.ts`) | Express `trust proxy` is a **function, never `true`**. An entry counts only when its hop is below `TRUST_PROXY_HOPS` **and** its address is in `TRUST_PROXY_ADDRESSES` (IPs, CIDRs, `loopback`/`linklocal`/`uniquelocal`). A direct caller from elsewhere is not a proxy; entries left of the trusted hop are the client's own writing |
| Configuration (`config/env.ts`) | Both variables are **required in production**. `true`, `*`, `all`, `any` and `/0` are refused with the variable named. Dev and test default to 1 hop from loopback. `createApp` trusts nothing unless configured. Topologies are in ADR 0014 and the README |
| Keying | Login per IP and registration per IP keyed by the resolved client: IPv4 address (IPv4-mapped counts as IPv4), **IPv6 by /64**. One limiter per action. **Login per email unchanged** (spans clients) |
| Audit | `audit_log.ip` is the same resolved, normalised client IP |
| Storage | Still in process memory: correct for one API instance (today's deployment). The multi-instance shared store stays **gap 4** (Hardening, Phase 17); the limiter's `consume(key)` is the seam for it. No new dependency |
| Responses | Unchanged: `429 RATE_LIMITED` + `Retry-After`, now per client |

### Gap 21: E2E in CI

| Part | What |
|---|---|
| Job `e2e` in `.github/workflows/ci.yml` | Runs in parallel with `verify` on every push and PR. PostgreSQL 17 service container (throwaway credentials, **no secrets, nothing reaches Neon**). Playwright's global setup migrates and seeds the test world |
| Build and start | `npm run build` with `API_URL=http://localhost:4100` (baked into the web build); Playwright starts the API (4100) and `server.mts` (3100) with the same value |
| Run | The whole suite: Phase 1 checks plus the customer, partner and admin journeys, on desktop and mobile Chromium |
| Caching | npm cache via setup-node; Chromium cached in `~/.cache/ms-playwright` keyed on the lockfile |
| On failure | HTML report and traces uploaded for 14 days. The `github` reporter writes each failure as a run annotation |
| Retries | **None.** Traces are kept for failing tests (`retain-on-failure`); `failOnFlakyTests` stays on as a guard. Why: see "Retries" below |
| Docs | `docs/development/ci.md` |

**What CI found, and the fixes** (commit `2c64ff8`). The first CI run failed two journeys that
always passed locally, where 8 workers make the ordering different. A local run with 1 worker found
a third:

| Problem | Cause | Fix |
|---|---|---|
| Admin journey: no invoice row | It relied on the customer journey's pay-at-property booking happening first | It books its own pay-at-property night |
| Booking journey (mobile): strict-mode violation on the price text | While results stream in, React briefly keeps a hidden copy of them in the DOM | Locator scoped to the room's visible result card |
| Partner journey (1 worker): `409 INSUFFICIENT_AVAILABILITY` | My first fix booked day 0, which the partner journeys fill | Pay-at-property night on day 3; per-night use of the shared fixture room written down in `e2e/admin.spec.ts` |

Afterwards, locally in CI mode: **20/20 with 1, 2, 2 and 8 workers**.

**Retries.** The first failure probe showed retries making failures harder to read:

- each retried booking journey registered again;
- the partner journey then hit the 5-per-hour registration limit (`429`).

The first CI run had already shown that a retried journey fails for a different reason, because
the journeys change data. CI therefore runs each test once and keeps traces (commit `9eb807a`).

## Verification (real results)

| Check | Result |
|---|---|
| `format:check`, `lint`, `typecheck` (API, web, e2e) | Pass |
| API unit | **250/250** (227 + 23 new in `client-ip.test.ts`) |
| Web unit | **83/83** (80 + 3 new in `forwarded-for.test.ts`) |
| API integration, disposable PostgreSQL 17 (local) | **209/209** (200 + 9 new in `rate-limit-per-client.integration.test.ts`) |
| E2E local (booking mode, disposable DB) | **20/20**, desktop and mobile; CI mode with 1, 2, 2 and 8 workers |
| `npm audit` | 0 vulnerabilities |
| CI `b1bc350` (first run with the E2E job) | Run `45635367284`: `verify` ✔, **`e2e` ✘** (2 journeys, the dependencies above) |
| CI `2c64ff8` | Run `45636903736`: `verify` ✔ (104 s), **`e2e` ✔ 20 passed (21.4 s)**, job 99 s |
| CI `9eb807a` | Run `45638096999`: `verify` ✔, **`e2e` ✔ 20 passed (19.9 s)** |
| **Neon integration (end of phase)** | Attempt 1: the test endpoint disappeared mid-run. Attempt 2: **199/209, 13/14 files**; the 10 failures are one 12-minute stalled request in `partner-admin` and the 9 tests after it (below). Not clean |

### Gap 5 cases

| Case | Level | Result |
|---|---|---|
| Client A exhausts its login budget (limit 3); client B | Integration | A: 401 ×3, then 429 with `Retry-After`. B: its own 401 ×3, then 429; A still 429 |
| Five requests each forging a different left entry before A's appended entry | Integration | 401, 401, 401, 429, 429. A long forged chain still counts as A; B is unaffected |
| Untrusted source (loopback not a configured proxy) rotating `X-Forwarded-For` | Integration | 401 ×3, then 429 (one bucket: the socket). Same with the default app (no trust configured) |
| Web server + edge (2 hops, `10.0.0.0/8`) | Integration | The edge-reported client is the bucket; another client is unaffected |
| IPv6 addresses in one /64 | Integration | Share a budget (429 on the 4th); another /64 is unaffected |
| Per-email limit across 4 clients | Integration | 401 ×3, then 429 (email dimension kept) |
| Registration (limit 2): A, A, A; A forging; B ×2; B | Integration | 201, 201, 429; 429; 201, 201; 429 |
| Registration from an untrusted source with rotating headers | Integration | 201, 201, 429 |
| Audit row of a partner onboarding with a forged header | Integration | `ip` = the proxy-reported client, never the forged entry |
| Resolution: no proxy, trusted web server, forged left entries, untrusted source, 2 hops, hop limit through trusted addresses | Unit (real Express) | As designed |
| Keys: IPv4-mapped, /64 grouping, unknown; per-client budgets; IPv6 rotation in a /64 | Unit | As designed |
| `TRUST_PROXY_*`: names, IPs, CIDRs accepted; `true`, `*`, `all`, `/0`, bad prefixes, hostnames refused; production requires the chain; hops 0 needs no addresses; hops 6 refused | Unit | As designed |
| Admin journey sends a forged `X-Forwarded-For` on every request through the real web server | E2E | The approval's audit row shows `127.0.0.1` / `::1`, never `198.51.100.7` |

**Mutation checks** (each change reverted afterwards):

| Mutation | Result |
|---|---|
| Trust no proxy (the old behaviour) | 6 of 9 integration tests fail |
| `trust proxy = true` | 6 of 9 fail: every forged-header and untrusted-source test |
| Raw-IP keys, no /64 | The IPv6 test fails |
| Web server back to plain `next start` | The E2E check fails on desktop and mobile: the row showed `Anita Admin … (admin) · 198.51.100.7` |

### Gap 21: proof that the job fails

| Probe | Commit | Run | Result |
|---|---|---|---|
| 1 (with retries) | `83e05ff`: "Add to trip" renamed to "Add to my trip" | `45637352496` | **`e2e` ✘** at `booking.spec.ts:87` ("waiting for getByRole('button', { name: 'Add to trip' })"), desktop and mobile. Artifact `playwright-report-45637352496-1` uploaded (3.1 MB, 14 days). `verify` ✔: no unit test covers the label. Side effect: the retries' extra registrations made the partner journey `429` (hence no retries) |
| 2 (no retries) | `025f590`: same break, on `9eb807a` | `45638124103` | **`e2e` ✘**: exactly the 2 broken booking journeys (desktop and mobile) at `booking.spec.ts:87`; **18 passed**, no unrelated failures. Artifact `playwright-report-45638124103-1` uploaded (3.1 MB). `verify` ✔ |

Both scratch branches (`ci/e2e-failure-probe`, `ci/e2e-failure-probe-2`) were deleted after their
runs; the runs and artifacts stay on GitHub.

## Neon integration run (end of phase)

Command: `caffeinate -i npm run test:integration` on committed code `9eb807a` (every API file
committed; the working tree held only docs and one web code comment), against the Neon test branch
from `apps/api/.env.test` (endpoint `ep-plain-bird-beob278r`, file unchanged since 24 Nov 21:06).

| Attempt | Started (UTC) | Result |
|---|---|---|
| 1 | 15:03:10 | **Infrastructure failure, not a code result.** Global setup succeeded (wipe + all migrations), and 74 tests passed. Then the endpoint refused every request: `User was denied access on the database (not available)` (Prisma), and once `P1001 Can't reach database server`. **11 of 14 files failed: 52 failed, 74 passed, 83 skipped** (their `beforeAll` failed). 1,177 s, ended 15:22:48 |
| 2 | 15:52:38 | After the owner recreated the test branch (new endpoint `ep-gentle-salad-beigu8ag`, `.env.test` updated 21:37 local). Run on `eafe96d` (no API change since `9eb807a`). **13 of 14 files passed; 199 passed, 10 failed.** 2,454.98 s, ended 16:33:33. All 10 failures are in `partner-admin.integration.test.ts`: one test stalled (below) and 9 failed after it |

- **Diagnosis, without printing secrets.** One diagnostic connection after the run (not a retry of
  the suite) printed only the error code and message:
  - both test URLs (pooled and direct) answered `28000 The requested endpoint could not be
    found, or you don't have access to it`;
  - the dev database still connected.
  - The test endpoint existed when the run started and was gone or inaccessible part-way through.
    That fits the test branch or its compute being deleted, reset or replaced in the Neon
    console, or access being revoked. Every failure is a refused connection; none is an
    assertion about behaviour.
- **What passed before access ended:** all of `rate-limit-per-client` (this phase's gap 5 tests,
  9/9), `partner-admin` and `payments`, plus 5 tests inside the failing files.
- **No retry was made after attempt 1, and no credential was changed by the agent.** The owner
  recreated the test branch, then asked for attempt 2.

**Attempt 2: what failed.**

- **The stall:** "status moves: submit for review yes, self-approval never" took **739,609 ms**
  for a handful of listing PATCHes and hit its 300 s timeout. One request waited about 12 minutes
  on the database.
- **The 9 failures after it:** they continue the file's shared scenario (it is written as one
  story), and the listing was never submitted and approved. So they got, for example,
  `422` (not bookable) instead of `201` when booking it, then `409`, `404` and empty lists.
- **The other 13 files passed in full**, including this phase's `rate-limit-per-client` (9/9).

**Why this is not a code result:**

- the same file passed **22/22 on Neon in attempt 1**, on identical API code (`9eb807a`);
- it passes locally (209/209) and in CI `verify` on every push;
- Phase 9 changed nothing on the listing-update path; its only API changes are the client IP for
  rate limits and audit rows.

**Not retried.** A third full run (~40 min) waits for the owner's decision. The end-of-phase
Neon run is therefore **not clean: 199/209**, with the 10 failures explained above.
- **The same committed code passed locally:** 209/209 on the disposable PostgreSQL 17, and CI
  `verify` ran the integration suite green on every push.

## Operational gaps

- **Closed:** 5 (per-client limits) and 21 (E2E in CI).
- **Still open, 18:** 1–4, 6–10, 12–17, 20, 23, 24. **No launch blocker remains.**
- **Gap 4** (in-memory rate-limit store) is the residual of gap 5. It only matters with more than
  one API instance (Hardening, Phase 17); it is not a launch blocker for a single-instance
  launch.
- **Renumbered:** Phase 9 was inserted, so every later phase moved down by one (listing media 10,
  search UX 11, live gateways 12, cancellations 13, commission & payouts 14, reviews 15,
  notifications 16, hardening 17). Gap targets were updated to match; admin moderation (gaps 9,
  13, 15) is still not scheduled.

## Commits

| Hash | Message |
|---|---|
| `424c4ad` | fix(api): resolve client IP via trusted proxy and rate-limit per client (gap 5) |
| `c532a08` | test(api): prove per-client rate limits and spoofed-header rejection (gap 5) |
| `b1bc350` | ci: run Playwright E2E against a disposable database (gap 21) |
| `2c64ff8` | test(e2e): make the journeys independent of worker count and streaming (gap 21) |
| `9eb807a` | ci: no E2E retries; keep the trace of every failing test (gap 21) |
| (this commit) | docs: record Phase 9 rate limits behind the proxy and E2E in CI; update gaps |

That is six commits, not the planned 3–4. The first E2E run in CI found test dependencies, and
the first probe found the retry problem. Each fix is its own tested commit, because pushed commits
are never rewritten.

## Security checklist

- **`trust proxy`:**
  - never `true`;
  - explicit hops and addresses, required in production;
  - trust-everything values refused at startup.
- **Untrusted `X-Forwarded-For`** never changes a bucket or an audit IP. This is proven at the
  unit, integration and E2E levels and mutation-checked.
- **Unchanged:** auth, scoping, CSRF, idempotency and money-as-string. No responses changed apart
  from per-client 429s.
- **CI** uses throwaway container credentials only; no repository secrets were added.
- **Secret scan** before every commit: real values from the git-ignored `.env` files, plus generic
  patterns. The only hits were the documented throwaway CI credentials and test placeholders.

## Known limitations / follow-ups

- **`npm run dev` uses `next dev`,** which does not append the client address. Development is not a
  security boundary.
- **An edge that replaces `X-Forwarded-For`** instead of appending needs its own hop accounting
  (README).
- **Standalone output** cannot be combined with the custom server; the project doesn't use it.
- **Shared rate-limit store** for several API instances: gap 4.
- **The E2E suite's fixture room is full on days 0 and 3.** A new spec that books it must use the
  table in `e2e/admin.spec.ts`.
- **Polling GitHub's API:** run status was checked with unauthenticated API calls (60 per hour);
  polling every 20 s used the quota up once during this phase.

## How to review

1. Read [ADR 0014](../architecture/decisions/0014-rate-limiting-behind-proxy.md) and
   [ci.md](../development/ci.md).
2. `apps/web/server.mts`, `apps/api/src/lib/client-ip.ts`, and the `TRUST_PROXY_*` handling in
   `config/env.ts`.
3. The integration file `apps/api/src/modules/auth/rate-limit-per-client.integration.test.ts`.
4. The CI runs listed above, including the failing probe runs.
