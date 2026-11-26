# 0017. Live payment gateways: eSewa and Khalti

- **Status:** Accepted
- **Date:** 2026-11-26
- **Phase:** 11 (closes operational gaps 7 and 8; builds on ADR 0007)

## Context

Phase 5 (ADR 0007) built provider-agnostic payment intents, allocations and database guards, with
only a simulated gateway that production refuses. So in production no one could pay online
(gap 7). A real gateway can also report success after the trip's hold expired and the hold-release
job cancelled the payment (gap 8).

The owner's brief for this phase:

- eSewa and Khalti, sandbox only (no production credentials, no real money);
- one gateway abstraction;
- never mark a payment paid from the browser redirect alone;
- gateway units normalised to `bigint` paisa inside the adapters;
- late success recorded and flagged, never dropped;
- refunds as a stored shape only;
- production refuses to start without gateway configuration.

The owner chose local fake gateways for every automated test, plus an opt-in script against the
real UAT/sandbox. The simulated gateway stays for development and tests only, and customers are
offered only eSewa and Khalti.

Facts below were checked against the gateways' own documentation on 2026-11-26
(developer.esewa.com.np, rendered with a headless browser because the page is client-side only;
docs.khalti.com).

## Decision

### One interface, three adapters

`apps/api/src/lib/payment-gateways/` defines `PaymentGatewayAdapter`:

| Method | Does |
|---|---|
| `createCheckout(request)` | Returns what the browser does next (`form` / `redirect` / `simulated`), the gateway's reference and an optional expiry. Never contains a secret |
| `verifyPayment(payment, callback)` | Checks what the browser brought back (eSewa `data`, Khalti `pidx`), then asks the gateway |
| `lookup(payment)` | Asks the gateway, server to server |

Results are normalised to:

- `status`: `pending`, `paid`, `failed` or `expired`;
- `amountMinor`: `bigint` paisa;
- `gatewayReference` and `transactionId`;
- `reason`, e.g. `amount_mismatch`, `canceled`;
- `raw`: the gateway's answer without secrets, kept for reconciliation.

Errors are a `GatewayError` with one of three codes:

| Code | API response |
|---|---|
| `GATEWAY_UNAVAILABLE` | 502 |
| `GATEWAY_REJECTED` | 422 |
| `INVALID_CALLBACK` | 422 `PAYMENT_CALLBACK_INVALID` |

The underlying cause is kept for the server log only. Every gateway request has a 10 s timeout and
`redirect: "manual"`.

`payments.gateway` gains a CHECK (`simulated`, `esewa`, `khalti`), and a unique
(`gateway`, `gateway_reference`).

### eSewa ePay v2

- **Checkout.** The API builds the form the browser POSTs to eSewa:
  - `amount = total_amount` in rupees as text: `paisaToRupees`, e.g. 360000 → `"3600"` and
    10050 → `"100.50"`;
  - `tax_amount`, service and delivery charges `"0"`, because MeroStay's amounts already include
    tax;
  - `transaction_uuid` = our payment id;
  - `product_code`;
  - the success and failure URLs;
  - `signed_field_names = total_amount,transaction_uuid,product_code`;
  - `signature` = base64 HMAC-SHA256 over `total_amount=…,transaction_uuid=…,product_code=…`.
- **Return.** eSewa sends the customer to `success_url?data=<base64 JSON>`. The API decodes it and
  requires `total_amount`, `transaction_uuid`, `product_code` and `status` among the signed fields.
  It recomputes the signature over eSewa's own `signed_field_names`, which include that field
  itself, and compares in constant time. It also requires our `transaction_uuid` and our product
  code.
- **Status API.** A valid signature is not enough on its own. eSewa's status API
  (`…/api/epay/transaction/status/?product_code&total_amount&transaction_uuid`) must say `COMPLETE`
  for the same amount. A signed callback whose own amount or status differs is `failed`
  (`callback_mismatch`).
- **Status mapping:**

  | eSewa status | Result |
  |---|---|
  | `COMPLETE` | paid |
  | `PENDING`, `AMBIGUOUS` | pending |
  | `NOT_FOUND` | expired |
  | `CANCELED`, `FULL_REFUND`, `PARTIAL_REFUND` | failed |
  | anything unknown | pending (hold, never pay) |

- **Amounts.** The callback writes `total_amount` like `"1,000.0"`; the status API writes a JSON
  number. `rupeesToPaisa` accepts both and refuses more than 2 decimals, negatives, exponents and
  garbage. No float ever holds money: numbers are checked with `toFixed(3)` and then handled as
  text.
- **Signature test vector.** The result printed in eSewa's documentation (`4Ov7pCI1…`) does not
  reproduce with standard HMAC-SHA256 for the message and UAT secret shown next to it, and neither
  does the demo form's signature. We verified this with openssl and with key variants. The unit
  test therefore uses that message and secret with the value openssl computes independently
  (`5DZywcrT…`), and a second openssl-computed vector for the field order. Whether eSewa UAT
  accepts our signature is what `npm run payment:sandbox-check` shows.
- **No refund API and no webhook** are documented. Refunds go through the merchant portal.

### Khalti ePayment v2

- **Initiate.** `POST {base}/epayment/initiate/` with `Authorization: Key <secret>` and:
  - `amount` in paisa: a JSON integer, at least 1000 (Rs 10);
  - `return_url` and `website_url`;
  - `purchase_order_id` = our payment id;
  - `purchase_order_name`.

  The response gives `pidx` (our gateway reference), `payment_url` (the browser is redirected
  there) and `expires_at`.
- **Return.** Khalti redirects to `return_url?pidx=…&status=…&amount=…`. Only `pidx` is used, and
  only to choose which payment to look up; it must equal the payment's stored reference.
- **Lookup.** `POST {base}/epayment/lookup/ {pidx}`. Only `Completed` with `total_amount` equal to
  what we asked counts as paid. A `Completed` lookup with another amount is `failed`
  (`amount_mismatch`). Status mapping:

  | Khalti status | Result |
  |---|---|
  | `Completed` | paid |
  | `Pending`, `Initiated` | pending |
  | `Expired` (HTTP 400 with a body) | expired |
  | `User canceled` (HTTP 400 with a body) | failed |
  | `Refunded`, `Partially Refunded` | failed |
  | anything unknown | pending |

- **Refunds.** A merchant refund API is documented (full or partial, by transaction id) and
  recorded as the gateway's refund capability; it is not called in this phase. **No webhook.**

### The simulated adapter

Phase 5's test gateway is a third adapter. Its `verifyPayment` and `lookup` always reject;
`POST …/confirm` stays its only way to pay. It is refused in production and never offered in the
customer UI.

### Applying a verified result: one pure decision

`domain/gateway-outcome.ts` (`decideGatewayOutcome`) decides, and the payments service carries it
out inside one transaction holding the trip lock:

| Gateway result | Payment / trip | Action |
|---|---|---|
| pending | any | none |
| failed / expired | open | close the payment (`FAILED`, or `CANCELLED` if expired) |
| failed with `amount_mismatch` and money taken | any | **reconcile** `AMOUNT_MISMATCH`; close the payment `FAILED` if open |
| paid | `SUCCEEDED`, same transaction | **replay** (nothing changes) |
| paid | `SUCCEEDED`, another transaction | **reconcile** `DUPLICATE_PAYMENT` |
| paid | `CANCELLED` / `FAILED` | **reconcile** `PAYMENT_NOT_OPEN` (typically: the hold expired first) |
| paid | open, trip no longer awaiting payment | **reconcile** `TRIP_NOT_AWAITING_PAYMENT`; close `CANCELLED` |
| paid | open, amount due changed | **reconcile** `INTENT_STALE`; close `CANCELLED` |
| paid | open, trip awaiting, same amount due | **record success**: Phase 5 allocation, items `PAID`/`CONFIRMED` |

Two details:

- **Replay key.** One key per gateway transaction (`transactionId`, or `<gateway>:<reference>` when
  a gateway gives none) is both what success stores and what replays compare. Repeats and
  concurrent callbacks therefore apply once; the database's unique transaction id and allocation
  guards back this up.
- **Reconciliation rows.** `payment_reconciliations` (new) holds money that cannot be applied:
  - unique per (gateway, gateway transaction), so a repeat finds the same row;
  - the gateway's answer is stored;
  - a trigger refuses deletes and any change except closing an open record with a note (`OPEN` →
    `RESOLVED`, who and when; `payment_reconciliations_immutable_chk`);
  - nothing is ever allocated from it, so finished payments stay immutable (Phase 5 guard).

### Endpoints and the web flow

- `POST /trips/:id/payments/intent` takes `{ gateway }` and returns the `checkout`.
  - The intent is written under the trip lock first. The gateway is called afterwards, with no lock
    held over the network, and its checkout stored on the intent.
  - The same due lines, gateway and still-valid checkout return the same intent (idempotent).
  - Another gateway or a changed amount cancels the open intent and makes a new one.
  - Concurrent requests share one intent (ADR 0007): a request that finds the intent still waiting
    for its checkout waits for it (up to 12 s, just above the gateway time limit) and returns the
    same intent with `200`. Only if the checkout never appears, or starting it failed, does it get
    `409 PAYMENT_IN_PROGRESS` (retry). CI found the race: before this, those requests got 409.
  - A gateway failure while starting closes the intent as `FAILED`.
- `POST /payment-callbacks/:gateway`:
  - no session and no CSRF token, because nothing in it is trusted;
  - rate limited to 30 per minute per client;
  - `Cache-Control: no-store`;
  - body `{ paymentId, data }` (eSewa) or `{ paymentId, pidx }` (Khalti); without them, a lookup.
- `POST /trips/:id/payments/:paymentId/refresh` (owner): a lookup, applied the same way.
- Web:
  - the trip page offers "Pay online" with eSewa or Khalti while the hold lasts;
  - it follows only `http(s)` checkout URLs: an eSewa form is posted as a normal navigation, a
    Khalti redirect is assigned;
  - `/payments/[gateway]/return/[paymentId]` and `/failure/[paymentId]` post to the callback and
    show the outcome. They use `no-referrer` (the address carries the gateway's response) and are
    not indexed;
  - the UI computes nothing.
- Return URLs are `${PUBLIC_WEB_URL}/payments/<gateway>/return|failure/<paymentId>`.

### Late success and customers who never come back (gap 8)

Neither gateway calls MeroStay. Beyond callbacks and refresh, the hold-release job first calls
`checkExpiringPayments`:

- every open eSewa/Khalti payment of a trip whose hold ends within 2 minutes is looked up and the
  result applied as above;
- money paid in time is applied, and money found after the hold is recorded for reconciliation;
- a gateway that does not answer is counted and skipped, and the sweep still runs.

What remains is gap 33: money paid after that check by a customer who never returns.

### Refunds: shape only

`refund_requests` (new) records:

- the payment;
- either a booking item (refunding its allocation) or a reconciliation (an unapplied late payment);
- gateway, amount, currency, reason, status, and who asked.

Admin endpoints record and list them, include the gateway's refund capability, and are audited.
The database enforces the limits:

- `refund_requests_not_executed_chk` allows only `REQUESTED` or `REJECTED`, with no gateway refund
  reference. The refunds phase relaxes it in its own migration;
- `refund_requests_within_payment_chk` (a trigger) keeps open requests within the allocation (or
  the late amount), in the payment's gateway and currency, and only for charges.

Nothing calls a gateway, and no `REFUND` payment is written.

The **refund clock reference** stays open for the Cancellations & refunds phase (15): for a rule
like "72+ hours before the start", is the start midnight Nepal time of the service date, or the
check-in or departure time? ADR 0015 froze the rule, not the clock.

### Configuration and start-up

The settings:

- `PAYMENT_GATEWAYS`: a comma list, replacing `PAYMENT_GATEWAY`, which is now refused with a
  "renamed" message instead of being ignored;
- `PAYMENT_MODE`: `uat` or `production`, which chooses the gateways' base URLs;
- `ESEWA_PRODUCT_CODE`, `ESEWA_SECRET_KEY`, `KHALTI_SECRET_KEY`, `PUBLIC_WEB_URL`;
- tests only: `ESEWA_FORM_URL`, `ESEWA_STATUS_URL`, `KHALTI_API_URL`.

In production the API refuses to start without:

- at least one gateway, and not `simulated`;
- `PAYMENT_MODE=production`;
- each listed gateway's keys;
- an https `PUBLIC_WEB_URL`;
- and with any test override set.

Errors name the setting, never its value. The start-up log shows gateway names and mode only.

### Tests and the opt-in live check

- `src/testing/fake-gateways.ts` is a local HTTP server that implements both documented contracts:
  - eSewa: the signed form (it rejects bad signatures), a payment page, a signed `data` redirect
    and the status API;
  - Khalti: initiate with `Key` auth and its Rs 10 minimum, a payment page, a `pidx` return and
    lookup;
  - test controls for amounts, statuses and outages.

  Integration tests run it in-process with random keys. E2E starts it as a Playwright web server
  (`npm run fake-gateways`) on port 4180. **Not 4190**: that port is on the fetch "bad ports"
  list, so Node refused it while Chromium allowed it. It refuses to start in production.
- `npm run payment:sandbox-check -w @merostay/api` is not part of any suite. With the owner's
  sandbox keys in `apps/api/.env`, it:
  - posts a signed Rs 10 eSewa UAT form (and a wrongly signed one, for contrast) and asks the UAT
    status API;
  - starts a Rs 10 Khalti sandbox payment, looks it up and prints the payment page so it can be
    finished with a test wallet; `--khalti-lookup <pidx>` shows the result.

  It refuses production mode and never prints keys. Sandbox credentials are in
  `docs/development/payments.md`, never in `.env` files.

### Future adapters (documented only, no code)

- **Fonepay** (QR / web payment). Needs:
  - a Fonepay merchant account and the merchant integration documentation, which Fonepay issues on
    onboarding;
  - its request signing and verification call;
  - an adapter mapping its statuses.

  The interface fits as is: a redirect checkout and a server-side verification.
- **Stripe** (cards, mainly for foreign travellers). Needs:
  - a Stripe account that can settle funds. Nepal is not a supported Stripe country, so this
    implies a foreign entity or a platform partner, an owner and legal decision;
  - multi-currency trips (future in CLAUDE.md);
  - signed webhooks, the first gateway with a push channel.

  Its adapter would return a redirect (Checkout Session) and verify by retrieving the session or
  payment intent.

## Consequences

- Customers can pay online with eSewa and Khalti (UAT/sandbox keys until merchant onboarding,
  gap 32). Pay at property is unchanged.
- No code path marks a payment paid from the browser. eSewa needs a valid signature **and** the
  status API; Khalti needs its lookup.
- Money confirmed by a gateway is either applied once or recorded once for an admin. Repeats are
  harmless.
- Every new money column is `BIGINT` minor units with a CHECK (`*_minor` count 21 → 23), and every
  API amount is a digit string with its currency.
- Residuals:
  - refund execution (gap 31, Phase 15);
  - production accounts (gap 32, launch checklist);
  - money after the last check from customers who never return (gap 33, Phase 12);
  - admin screens for reconciliation and refunds (gap 34, Phase 13);
  - payout execution (gap 16, Phase 12).
- A future Content-Security-Policy must allow eSewa's form URL in `form-action`.
