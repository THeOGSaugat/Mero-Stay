# Online payments in development (eSewa, Khalti)

How to run and test online payments locally (ADR 0017). Sandbox / UAT only: **no production
credentials, no real money**. Real keys go only in the git-ignored `apps/api/.env` (or the
production secret store), never in a committed file.

## Three ways to pay locally

| Setup | What happens | Network |
|---|---|---|
| `PAYMENT_GATEWAYS=simulated` | Test gateway: pay through `POST …/payments/:id/confirm` (API only; the web UI does not offer it) | None |
| Local fakes (what tests use) | `npm run fake-gateways -w @merostay/api` with test keys, and the API pointed at it (below) | None |
| eSewa UAT / Khalti sandbox | The real test services, with the sandbox keys below | Internet |

### Using the local fakes by hand

```bash
# terminal 1: fake eSewa + Khalti on :4180 (any test keys; never real ones)
ESEWA_PRODUCT_CODE=EPAYTEST ESEWA_SECRET_KEY=local-test-key KHALTI_SECRET_KEY=local-test-key \
  FAKE_GATEWAYS_PORT=4180 npm run fake-gateways -w @merostay/api
```

Then in `apps/api/.env` (development only; the API refuses these overrides in production):

```bash
PAYMENT_GATEWAYS=esewa,khalti,simulated
PAYMENT_MODE=uat
PUBLIC_WEB_URL=http://localhost:3000
ESEWA_PRODUCT_CODE=EPAYTEST
ESEWA_SECRET_KEY=local-test-key
KHALTI_SECRET_KEY=local-test-key
ESEWA_FORM_URL=http://127.0.0.1:4180/esewa/form
ESEWA_STATUS_URL=http://127.0.0.1:4180/esewa/status
KHALTI_API_URL=http://127.0.0.1:4180/khalti
```

`npm run dev`, confirm a trip with an online item, open it and choose **Pay online**. The fake
pages have "Pay" and "Cancel" buttons. Do not use port 4190: Node's `fetch` refuses it.

## eSewa UAT (ePay v2)

Published by eSewa for testing (developer.esewa.com.np, checked 2026-11-26). These are public
test values, not secrets:

| What | Value |
|---|---|
| Product code (merchant) | `EPAYTEST` |
| Secret key (UAT) | `8gBm/:&EnhH.1/q` |
| Form URL | `https://rc-epay.esewa.com.np/api/epay/main/v2/form` |
| Status API | `https://rc.esewa.com.np/api/epay/transaction/status/` |
| Test eSewa IDs | `9711111111`, `9711111112`, `9711111113` |
| Password / MPIN / token | `Nepal@123` / `1122` / `123456` |

To use them, put the product code and secret in `apps/api/.env` as `ESEWA_PRODUCT_CODE` and
`ESEWA_SECRET_KEY`, set `PAYMENT_GATEWAYS=esewa`, `PAYMENT_MODE=uat`, and leave the URL overrides
unset. eSewa must be able to redirect the browser back to `PUBLIC_WEB_URL` (localhost works for a
browser on the same machine).

Note: the signature result printed in eSewa's docs does not reproduce for the inputs shown
(ADR 0017); the unit test uses an independently computed vector, and the sandbox check below shows
whether UAT accepts our signature.

## Khalti sandbox (ePayment v2)

| What | Value |
|---|---|
| API base | `https://dev.khalti.com/api/v2` |
| Secret key | Your own **test** secret key from a merchant account at `test-admin.khalti.com` (put it in `apps/api/.env` as `KHALTI_SECRET_KEY`) |
| Test Khalti IDs | `9800000000` … `9800000005` |
| MPIN / OTP | `1111` / `987654` |
| Minimum amount | Rs 10 (1000 paisa) |

## Opt-in check against the real sandbox

Not part of any test suite (it needs the internet and your sandbox keys):

```bash
npm run payment:sandbox-check -w @merostay/api
# after paying the printed Khalti page with a test wallet:
npm run payment:sandbox-check -w @merostay/api -- --khalti-lookup <pidx>
```

- eSewa: posts a signed Rs 10 form to UAT, plus one with a wrong signature for contrast, and asks
  the status API.
- Khalti: starts a Rs 10 payment, looks it up (expect `pending`/Initiated) and prints the payment
  page.

It refuses to run with `PAYMENT_MODE=production` or `NODE_ENV=production` and never prints keys.
Paste its output into the phase report.

## What is never trusted

- The browser's return: eSewa's `data` must be correctly signed **and** confirmed by eSewa's status
  API; Khalti's `pidx` only selects the payment, and Khalti's lookup decides.
- Amounts from the client: the API computes them; gateways' amounts are converted to paisa inside
  the adapters and must match exactly.

Late or unusable money is recorded in `payment_reconciliations` for an admin
(`GET /api/v1/admin/payment-reconciliations`), never dropped (gap 8).
