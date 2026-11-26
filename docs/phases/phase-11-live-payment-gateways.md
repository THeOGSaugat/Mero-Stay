# Phase 11: Live payment gateways (eSewa, Khalti)

- **Status:** complete, awaiting owner review.
- **Branch:** `phase/11-live-payment-gateways`
- **Date:** 2026-11-26

## Scope (as approved)

Close **gap 7** (no live gateway) and **gap 8** (late success). The brief asked for:

- one gateway abstraction with eSewa ePay v2 and Khalti ePayment v2;
- gateway units normalised to paisa inside the adapters;
- never paid from the client redirect;
- verified, idempotent callbacks;
- late success recorded and flagged;
- a refund shape with each gateway's refund capability, but no execution;
- gateway config enforced at production start-up;
- Fonepay and Stripe documented only;
- tests, docs, and 3–4 commits.

**Not built (confirmed):**

- payout execution;
- refund execution;
- reviews, notifications;
- OAuth, 2FA, email verification and reset;
- admin moderation;
- production credentials and real money.

Phase 12 has not been started. The bookkeeping item was already done in `9acdf67` (on `main`
before this phase); it was not repeated.

**Owner decisions (asked at the start):**

| Question | Answer |
|---|---|
| Phase numbering | "Follow the brief": 11 Live payment gateways, 12 Commission & payouts, 13 Admin moderation, 14 Search UX, 15 Cancellations & refunds, 16 Reviews, 17 Notifications, 18 Hardening. Gap targets updated to match |
| Sandbox in tests | "Fake gateways + opt-in live check": every automated test (local, Neon, CI) uses local fake eSewa/Khalti servers; a separate script calls the real UAT/sandbox when the owner adds keys |
| Simulated gateway | "Keep it, dev/test only": a third adapter, refused in production; the customer UI offers only eSewa and Khalti |

## What was built

Details and reasons: [ADR 0017](../architecture/decisions/0017-live-payment-gateways.md); endpoints:
[api.md](../architecture/api.md#payments-adr-0007-adr-0017).

- **Gateway interface** (`apps/api/src/lib/payment-gateways/`):
  - `createCheckout`, `verifyPayment`, `lookup`;
  - normalised status (pending, paid, failed, expired), amount in `bigint` paisa, gateway
    reference and transaction id;
  - `GatewayError` codes UNAVAILABLE, REJECTED and INVALID_CALLBACK, with the cause kept for logs.
- **eSewa:**
  - a signed form in rupees (`paisaToRupees`);
  - the callback's base64 `data` is verified with HMAC-SHA256 in constant time, for our uuid and
    product code;
  - then the status API must say `COMPLETE` for the same amount;
  - `"1,000.0"` style amounts are parsed without floats.
- **Khalti:**
  - initiate in paisa with `Authorization: Key …` (minimum Rs 10), then redirect;
  - the return's `pidx` must be the payment's own;
  - lookup must say `Completed` with the exact amount; a different amount is `failed`
    (`amount_mismatch`).
- **Outcome decision** (`domain/gateway-outcome.ts`, pure): record success, replay, reconcile
  (5 reasons), close, or none. It is carried out inside one trip-locked transaction.
- **Endpoints:**
  - intent takes `{ gateway }` and returns the `checkout`;
  - `POST /payment-callbacks/:gateway`: no session, 30/min per client, `no-store`;
  - owner `refresh`;
  - admin: reconciliation list and resolve, refund-request create and list (audited).
- **Late success (gap 8):**
  - `payment_reconciliations` (new): one row per gateway transaction; the database refuses edits
    and deletes of what the gateway said;
  - the hold-release job first asks eSewa/Khalti about open payments of holds ending within
    2 minutes, so customers who paid but never returned are applied or recorded.
- **Refunds (shape only):** `refund_requests` (new) records the request. The database:
  - keeps it `REQUESTED`/`REJECTED`;
  - keeps it within the allocation or the late amount, in the payment's gateway and currency.

  Each response includes the gateway's refund capability (Khalti: documented API; eSewa: none,
  merchant portal) and `executed: false`.
- **Configuration:** `PAYMENT_GATEWAYS`, `PAYMENT_MODE`, `ESEWA_PRODUCT_CODE`, `ESEWA_SECRET_KEY`,
  `KHALTI_SECRET_KEY`, `PUBLIC_WEB_URL`, and test-only URL overrides. In production the API
  refuses to start:
  - without gateways or with `simulated`;
  - without production mode;
  - without each listed gateway's keys or an https URL;
  - with any override.

  The old `PAYMENT_GATEWAY` is refused with a "renamed" message.
- **Web:**
  - "Pay online" on the trip page (eSewa or Khalti);
  - return and failure pages that post to the callback and show the outcome;
  - customer messages for the new errors.
- **Test tooling:**
  - `src/testing/fake-gateways.ts`: both documented contracts, in-process for integration and as
    a Playwright web server on port 4180 for E2E;
  - `npm run payment:sandbox-check -w @merostay/api`: opt-in, against the real UAT/sandbox.

### Migration

`20261126130000_live_payment_gateways` (new; no applied migration edited):

- `payments.gateway_reference`, `checkout` and `checkout_expires_at`;
- a CHECK on `payments.gateway`, and a unique (gateway, gateway_reference);
- `payment_reconciliations` with its guard trigger;
- `refund_requests` with the not-executed CHECK and the within-payment guard trigger.

Money columns are `BIGINT` with `> 0` CHECKs (`*_minor` count 21 → 23).

## Verification (real results)

| Check | Result |
|---|---|
| `format:check`, `lint`, `typecheck` (API, web, e2e), `build` | Pass |
| API unit | **327/327** (287 + 40 new) |
| Web unit | **97/97** (91 + 6 new) |
| API integration, disposable PostgreSQL 17 (local) | **258/258**, 17 files (233 + 25 new in `payment-gateways.integration.test.ts`), twice after the fix |
| E2E local (booking mode) | **30/30** (26 + 4 new), with default, 1 and 8 workers |
| Commit 1 on its own (separate worktree) | format, lint, typecheck pass; API unit 287, web unit 91, integration 233/233 (16 files), E2E 26/26 |
| `npm audit` | 0 vulnerabilities |
| CI on `8284c99` (first push) | Run `45826935715`: `e2e` ✔, `verify` ✘ (integration: the concurrency race below) |
| CI on `49c0ae5` | Run `45827753684`: `verify` ✔ (format, lint, typecheck, unit, integration, build), `e2e` ✔ |
| **Neon integration (end of phase)** | **17/17 files, 258/258 tests**, 2,814.92 s, exit 0 (on committed `49c0ae5`, below) |
| **Opt-in sandbox check** (`payment:sandbox-check`, real eSewa UAT + Khalti sandbox) | **Pass**: eSewa UAT accepts our signature (wrong signature refused); Khalti payment completed by the owner with a test wallet and confirmed `paid` for the exact amount (below) |

### Cases

| Case | Level | Result |
|---|---|---|
| eSewa checkout | Unit + integration | Form in rupees (`"3600"`, `"4500.50"`), our return URLs, `signed_field_names`, signature correct; the fake eSewa accepts it only with a valid signature; no secret in any response |
| eSewa signature | Unit | eSewa's documented message + UAT secret → the openssl-computed value; field order matters; tampered amount, another merchant's key, amount not signed, garbage → refused |
| Khalti initiate | Unit + integration | `amount: 360000` (paisa), `Authorization: Key <secret>`, return/website URLs; below Rs 10, non-NPR and a wrong key → rejected |
| Verified callback → paid | Integration + E2E | eSewa (signed `data` + status API) and Khalti (lookup): payment `SUCCEEDED`, one allocation, item `PAID`, trip `CONFIRMED` |
| Redirect alone is not enough | Unit + integration | Signed eSewa `COMPLETE` but status API `PENDING` → pending; Khalti return `status=Completed` while lookup says Initiated → pending |
| Duplicate / concurrent callbacks | Integration | 3 at once after success → all `replayed`; 1 allocation, 0 reconciliations |
| Forged / foreign callbacks | Integration | Bad signature → `422 PAYMENT_CALLBACK_INVALID`; another payment's `pidx` → 422; unknown payment or wrong gateway → 404; nothing changes |
| Amount mismatch | Unit + integration | Khalti `Completed` for Rs 10 instead of Rs 3,600 → payment `FAILED`, reconciliation `AMOUNT_MISMATCH` (1000 paisa), nothing allocated |
| Cancel, then pay again | Integration + E2E | Khalti `User canceled` / eSewa `CANCELED` → "Payment not completed", payment `FAILED`; a new intent works; the second attempt is paid |
| Outage | Unit + integration | Callback → `502 PAYMENT_GATEWAY_UNAVAILABLE`, payment stays open; initiate during an outage → 502 and the intent is closed `FAILED` |
| Late success after expiry | Integration | Trip swept (payment `CANCELLED`), then a verified callback → `reconciliation` `PAYMENT_NOT_OPEN`, 360000 paisa, `OPEN`, no allocation; callback again and refresh → the same record |
| Customer never returns | Integration | Khalti paid, hold ending in 1 min → the job applies it (trip `CONFIRMED`); eSewa paid, found after the hold → recorded (`TRIP_NOT_AWAITING_PAYMENT`), payment `CANCELLED`, trip `EXPIRED`; unpaid → left open; outage → counted, not fatal; holds far away → no lookup |
| Refund shape | Integration | Request on a late payment and on an item's allocation stored `REQUESTED`, `executed: false`, capability shown (eSewa `none`, Khalti `documented`); over the amount → `422 REFUND_EXCEEDS_PAID`; non-admin → 403; audit row; DB refuses `COMPLETED` and an over-refund written directly; no `REFUND` payment |
| Reconciliation records | Integration | DB refuses `UPDATE amount_minor` and `DELETE`; admin resolves once with a note (audited), second time 409 |
| Startup refused | Integration + unit | `node --import tsx src/server.ts` with `NODE_ENV=production` and no gateway settings → exit 1, `PAYMENT_GATEWAYS: is required in production`; unit: each missing key, http URL, uat mode, overrides, `simulated`, legacy `PAYMENT_GATEWAY`; no secret echoed |
| Money at the boundary | Integration | Every response's money is a digit string with its currency (checker found one missing currency on an error detail; fixed) |

### What testing found

- **CI found a race (fixed in `49c0ae5`).** On the first push (`8284c99`, run `45826935715`),
  `verify` failed on Phase 5's "five simultaneous intent requests share ONE open intent": the
  statuses were `[200, 200, 200, 201, 409]`, while E2E passed. The new intent is written under the
  trip lock and the gateway is then called outside it. A request taking the lock in between saw
  the intent without its checkout and answered `409 PAYMENT_IN_PROGRESS`, which breaks Phase 5's
  contract (all concurrent callers get the same intent). Locally the timing hid it. Fix: such a
  request now waits (up to 12 s, just above the gateway time limit) for the checkout and returns
  the same intent with 200; 409 remains only if it never appears. A new test makes the race
  deterministic with a gateway that answers in 400 ms. On the committed code it fails with four
  409s; with the fix it passes.

Found and fixed before committing:

- **eSewa's documented signature example does not reproduce.** With standard HMAC-SHA256, the
  printed result (`4Ov7pCI1…`) does not match the message and UAT secret shown next to it, and the
  demo form's signature does not match either. Checked with openssl and secret variants. The test
  pins an independently computed vector instead. The sandbox check then confirmed that UAT accepts our
  signature and refuses a wrong one.
- **E2E: port 4190 is a fetch "bad port".** Chromium reached the fake on 4190 but Node's `fetch`
  refused it ("bad port"), so every API → gateway call failed. Moved to 4180. Found by keeping
  gateway error causes in the server log, which is now permanent and never sent to clients.
- **Customers who never come back.** Neither gateway calls back, so the hold-release job now asks
  the gateways before releasing holds (above). The rest is gap 33.
- A refund error's `availableMinor` lacked its currency (the money-boundary checker caught it).
- The migration folder and two "checked on" notes carried the wrong date (27 instead of 26
  November); renamed and corrected before the Neon run and before committing.

## Sandbox check against the real eSewa UAT and Khalti sandbox

Run after the owner added sandbox keys to `apps/api/.env` (keys never printed; Rs 10, test
money only). Output as printed:

```text
$ npm run payment:sandbox-check -w @merostay/api

== eSewa ePay v2 (UAT) ==
transaction_uuid: d7d168d2-9a89-4fd1-9a4d-5e05a67c29ad
signed form, our signature: {"httpStatus":302,"redirectsTo":"https://rc-epay.esewa.com.np/epay","bodyMentionsError":false}
signed form, WRONG signature (contrast): {"httpStatus":400,"redirectsTo":null,"bodyMentionsError":true}
status API (expect PENDING or NOT_FOUND: nothing was paid): {"status":"pending","reason":null,"amountMinor":"1000","transactionId":null,"gatewayStatus":"PENDING"}

== Khalti ePayment v2 (sandbox) ==
pidx: bXiaRGNXRSY93awH53XaN7
expires_at: 2026-11-26T15:33:40.329Z
payment_url: https://test-pay.khalti.com/?pidx=bXiaRGNXRSY93awH53XaN7
lookup (expect pending / Initiated): {"status":"pending","reason":null,"amountMinor":"1000","transactionId":null,"gatewayStatus":"Pending"}

# the owner paid payment_url with a Khalti test wallet, then:
$ npm run payment:sandbox-check -w @merostay/api -- --khalti-lookup bXiaRGNXRSY93awH53XaN7

== Khalti ePayment v2 (sandbox) ==
lookup: {"status":"paid","reason":null,"amountMinor":"1000","transactionId":"WNFJqffe2Vs5BvNkAk9qrx","gatewayStatus":"Completed"}
(exit 0)
```

What this confirms:

- **eSewa accepts our signature.** Our signed form is taken (302 to the payment page); the same
  form with a wrong signature is refused (400). This settles the doubt from eSewa's documented
  example, which does not reproduce (ADR 0017): our HMAC-SHA256 message format is the one UAT
  checks. The UAT status API answers for our uuid and amount (`PENDING`, Rs 10 = 1000 paisa).
- **Khalti, end to end:** initiate in paisa with the `Key` header works; before payment the lookup
  is not paid; after the owner's test-wallet payment the lookup is `Completed` for 1000 paisa
  (exactly what was asked) with a transaction id, which our adapter maps to `paid`.
- **One difference from Khalti's docs:** right after initiate the sandbox reports `Pending`, not
  `Initiated`. Both already map to pending (never paid), so no code change was needed.
- Not covered here: an eSewa UAT payment completed through the browser back to MeroStay (the
  check verifies signing and the status API; the full round trip with eSewa's redirect is covered
  against the fake in E2E).

## Neon integration run (end of phase)

Command: `caffeinate -i npm run test:integration` on committed code `49c0ae5` (all code
committed; the working tree held only docs), against the Neon test branch from
`apps/api/.env.test` (no URL printed).

| Attempt | Started (UTC) | Result |
|---|---|---|
| 1 | ~12:50 | **Stopped by me** after a few minutes, before any result: the migration folder carried the wrong date (renamed before committing) and `schema.integration.test.ts` reads that folder |
| 2 | ~12:57 | **Stopped by me**: CI found the concurrency race, so the code under test was about to change |
| 3 | 13:17:55 | **Clean: 17/17 files, 258/258 tests passed**, 2,814.92 s (about 47 min), exit 0, ended 14:04:50. No stalls, no connection or timeout errors, no retries |

The same 258 tests pass locally on PostgreSQL 17 and in CI `verify` (run `45827753684`).

## Operational gaps

- **Closed:** 7 (live gateways) and 8 (late success).
- **New residuals:**
  - 31: refunds recorded, not executed (Phase 15);
  - 32: production gateway accounts (on the launch checklist);
  - 33: money after the last check from customers who never return (Phase 12);
  - 34: admin screens for reconciliation and refunds (Phase 13).
  - Gap 16 (payout execution) notes that online money now really arrives.
- **Targets renumbered** to the owner's order.
- **Launch checklist** gains: live gateway settings and the sandbox check; the hold-release job
  needs the payment settings.
- **Open, 23:** 1–4, 6, 9, 10, 12, 13, 15–17, 20, 24, 26–34. **No launch blocker.**

## Commits

| Hash | Message |
|---|---|
| `2c95a64` | feat(api): eSewa and Khalti gateways, verified callbacks, late-payment reconciliation (gaps 7, 8) |
| `25a019c` | test(api): cover gateway adapters, outcome decisions, payment config and late payments (gaps 7, 8) |
| `8284c99` | feat(web): pay online with eSewa or Khalti; E2E payment journeys through local fake gateways |
| `49c0ae5` | fix(api): concurrent intent requests wait for the first one's checkout instead of 409 |
| (this commit) | docs: record Phase 11 live payment gateways, ADR 0017, gaps 7 and 8 closed, roadmap order |

Five commits instead of 3–4: the fix came from CI after the first push, and pushed history is
never rewritten. Commit 1 includes the existing tests and E2E specs that had to send the new `gateway` field, and
the Playwright settings (the old `PAYMENT_GATEWAY` is now refused), so it builds and passes on its
own.

## Security checklist

- **Never paid from the browser.**
  - eSewa: signature (constant time) **and** status API, same uuid, product code and amount.
  - Khalti: lookup only, exact amount.
  - Unknown gateway statuses hold (pending), never pay.
- **Callback endpoint:** no session, and nothing trusted from it; Zod-validated body; rate
  limited; `no-store`. The return pages are `no-referrer` and not indexed.
- **Secrets:**
  - gateway keys are server-only, never in a checkout or a response, never logged (the start-up
    log shows gateway names and mode only);
  - config errors name the setting, never its value;
  - the sandbox check never prints keys and refuses production mode;
  - the fakes refuse production.
- **Production start-up** refuses missing keys, `simulated`, uat mode, an http return URL, and
  test URL overrides.
- **Money:** `bigint` paisa everywhere; gateway text and numbers are converted with string rules
  (no float holds money); DB CHECKs on new money columns; digit strings at the API boundary.
- **Data integrity:**
  - reconciliation records and refund requests are guarded by the database;
  - refunds cannot be executed;
  - admin writes are audited;
  - the browser follows only http(s) checkout URLs.
- **Secret scan** before every commit: no real values. Keyword hits were variable names,
  `.env.example` placeholders, random per-run test keys, eSewa's public UAT test key (a documented
  test value) and fake database URLs (`.invalid`, the existing fixture).

## Known limitations / follow-ups

- **Sandbox check done** (above). A full eSewa UAT payment through the browser back to a running
  MeroStay was not done; it can be tried with the UAT test IDs in
  [payments.md](../development/payments.md) when MeroStay runs locally with the UAT settings.
- **Refund clock reference** (for the Cancellations & refunds phase, 15): is "72+ hours before the
  start" counted from midnight Nepal time of the service date, or from the check-in or departure
  time?
- **Refund execution, payout execution, production accounts, unseen late money, admin screens:**
  gaps 31, 16, 32, 33, 34.
- **Future gateways:** Fonepay and Stripe are documented only (ADR 0017 §Future adapters). Stripe
  needs an owner and legal decision: Nepal is not a Stripe country.
- **A future CSP** must allow eSewa's form URL in `form-action`.

## How to review

1. Read [ADR 0017](../architecture/decisions/0017-live-payment-gateways.md) and the migration.
2. Locally with the fakes ([payments.md](../development/payments.md)): run
   `npm run fake-gateways -w @merostay/api` and set the `.env` lines shown there. Then
   `npm run dev`: confirm a trip with an online bus seat, **Pay online**, choose eSewa or Khalti,
   then cancel or pay on the fake page and return.
3. With sandbox keys: `npm run payment:sandbox-check -w @merostay/api`.
4. `E2E_DATABASE_URL="postgresql://…disposable…" npm run test:e2e:booking`.
