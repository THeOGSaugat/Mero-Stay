# MeroStay API (v1)

Base path: `/api/v1`. JSON in, JSON out. Design decisions:
[ADR 0005](decisions/0005-search-and-booking-api-conventions.md) (search/booking conventions),
[ADR 0006](decisions/0006-authentication.md) (authentication),
[ADR 0007](decisions/0007-payments-and-invoices.md) (payments, invoices, hold-release job).
Data model: [data-model.md](data-model.md).

| Area | Access |
|---|---|
| `/api/health…`, `/api/v1/listing-types`, `/api/v1/listings…` | **Public** (browsing needs no account) |
| `/api/v1/auth/register`, `/api/v1/auth/login` | Public, rate-limited, JSON only |
| `/api/v1/auth/me`, `/api/v1/auth/logout` | Session required |
| `/api/v1/trips…` (including `/trips/:id/payments…`) | **Session required, owner only.** Writes also need `X-CSRF-Token` |
| `/api/v1/admin…` | **Session with role `ADMIN`** (403 for everyone else). Writes also need `X-CSRF-Token` |

## Conventions

### Authentication (ADR 0006)

- **Session cookie:** `merostay_session` (`__Host-merostay_session` over HTTPS): `HttpOnly`,
  `SameSite=Lax`, `Path=/`, `Secure` in production, absolute lifetime 7 days. Set by register and
  login; cleared by logout. Browsers send it automatically.
- **CSRF:** every state-changing request with a session (`POST`/`PATCH`/`DELETE` on `/trips…` and
  `/auth/logout`) must send `X-CSRF-Token: <csrfToken>`. The token comes back in the body of
  register, login and `GET /auth/me`; re-fetch it from `/auth/me` after a page reload.
- **Ownership:** a trip is visible and editable only by the user who created it. Anyone else gets
  `404 TRIP_NOT_FOUND`, exactly as for a trip that does not exist (existence never leaks).
- **No password data is ever returned** (no hash, no password, no session token in any body).

### Money

| Rule | Example |
|---|---|
| Every money field ends in `Minor` and is a **string of digits** in minor units | `"totalMinor": "957110"` = Rs 9,571.10 |
| Every money-bearing object has `currency` and `currencyExponent` | `"currency": "NPR", "currencyExponent": 2` |
| Rates are JSON numbers in basis points | `"commissionRateBps": 1500` = 15% |
| Money inputs use the same digit-string format | `GET /listings?minPrice=180000` |
| Money is never a JSON number | (a test fails the build if one appears) |

Display: `amount = BigInt(totalMinor)`, then divide by `10 ** currencyExponent`. Do not use
`parseFloat`/`Number` on large values.

### Dates

`YYYY-MM-DD` calendar dates. Ranges are start-inclusive, end-exclusive: `startDate=2027-01-10`,
`endDate=2027-01-12` = the nights of the 10th and 11th. Single-date items (bus seat, tour
departure) send only `startDate`. "Today" is Nepal time (UTC+05:45); past start dates are rejected.

### Errors

```json
{ "error": { "code": "INSUFFICIENT_AVAILABILITY", "message": "Not enough availability...", "details": { "date": "2027-01-10", "requested": 1 } } }
```

| Status | Codes | Meaning |
|---|---|---|
| 400 | `VALIDATION_ERROR`, `INVALID_JSON` | Malformed request; `details` lists `{ path, message }` |
| 401 | `UNAUTHENTICATED`, `INVALID_CREDENTIALS` | No valid session / wrong email or password (one generic message) |
| 403 | `CSRF_TOKEN_INVALID`, `ACCOUNT_DISABLED`, `FORBIDDEN` | Missing/invalid CSRF token on a write / suspended account (only after a correct password) / not an admin |
| 404 | `NOT_FOUND`, `LISTING_NOT_FOUND`, `TRIP_NOT_FOUND`, `ITEM_NOT_FOUND`, `PAYMENT_NOT_FOUND` | The resource in the URL does not exist (or is not yours) |
| 409 | `INSUFFICIENT_AVAILABILITY`, `NOT_AVAILABLE`, `TRIP_NOT_EDITABLE`, `TRIP_EXPIRED`, `TRIP_EMPTY`, `ITEM_NO_LONGER_BOOKABLE`, `EMAIL_TAKEN`, `PHONE_TAKEN`, `CONFLICT`, `TRIP_NOT_CONFIRMED`, `NOTHING_DUE`, `PAYMENT_NOT_OPEN`, `PAYMENT_INTENT_STALE`, `ITEM_NOT_CONFIRMED` | Conflicts with current state, availability or an existing account |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Login/register sent as something other than `application/json` |
| 422 | `CURRENCY_MISMATCH`, `LISTING_NOT_BOOKABLE`, `UNKNOWN_LISTING`, `UNKNOWN_LOCATION`, `UNKNOWN_LISTING_TYPE`, `INVALID_DATE_RANGE`, `DATE_IN_PAST`, `PRICING_INVARIANT_VIOLATED`, `INVALID_CAPTURED_AMOUNT`, `ITEM_NOT_PAY_AT_PROPERTY`, `PAYMENT_INVARIANT_VIOLATED` | Well-formed, but breaks a business rule |
| 429 | `RATE_LIMITED` | Too many login/registration attempts; see `Retry-After` |
| 500 | `INTERNAL_ERROR` | Unexpected; details only in server logs |
| 503 | `PAYMENTS_UNAVAILABLE` | No payment gateway is configured (`PAYMENT_GATEWAY` unset) |

Database constraint violations are mapped (overbooking → 409, money checks → 422, payment/invoice
guards → 422 `PAYMENT_INVARIANT_VIOLATED`). Raw PostgreSQL text is never returned.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health`, `/api/health/ready` | Liveness / readiness (unchanged) |
| POST | `/api/v1/auth/register` | Create a customer account and log in |
| POST | `/api/v1/auth/login` | Log in |
| POST | `/api/v1/auth/logout` | Log out (deletes the session) |
| GET | `/api/v1/auth/me` | Current user + CSRF token |
| GET | `/api/v1/listing-types` | All verticals and whether they are active/bookable |
| GET | `/api/v1/listings` | Search bookable listings |
| GET | `/api/v1/listings/:id` | Listing details + availability calendar |
| POST | `/api/v1/trips` | Create a draft trip |
| GET | `/api/v1/trips/:id` | Trip with items, money and statuses |
| POST | `/api/v1/trips/:id/items` | Add a booking item (holds inventory) |
| PATCH | `/api/v1/trips/:id/items/:itemId` | Change dates/quantity/payment method |
| DELETE | `/api/v1/trips/:id/items/:itemId` | Remove an item (releases inventory) |
| POST | `/api/v1/trips/:id/quote` | Dry-run pricing, optionally with candidate items |
| POST | `/api/v1/trips/:id/confirm` | Submit the trip (no payment taken; issues commission invoices) |
| POST | `/api/v1/trips/:id/payments/intent` | Create (or reuse) the payment intent for what is due online |
| POST | `/api/v1/trips/:id/payments/:paymentId/confirm` | Record the gateway result (simulated this phase) |
| GET | `/api/v1/trips/:id/payments` | The trip's payments and their allocations |
| POST | `/api/v1/admin/trips/:id/payments/at-property/settle` | ADMIN: record that pay-at-property items were paid on arrival |
| GET | `/api/v1/admin/trips/:id/invoices` | ADMIN: the trip's commission invoices |

### POST /api/v1/auth/register → 201 (+ session cookie)

```json
{ "email": "ram@example.com", "password": "at least 12 characters", "fullName": "Ram Bahadur", "phone": "+9779812345678" }
```

Email is trimmed and lower-cased. Password: 12–128 characters, not a common password. `phone` is
optional (international format). New accounts are `CUSTOMER`s. Duplicate email → `409 EMAIL_TAKEN`,
duplicate phone → `409 PHONE_TAKEN`. Limit: 5 per hour per IP.

### POST /api/v1/auth/login → 200 (+ session cookie)

```json
{ "email": "ram@example.com", "password": "…" }
```

Any failure → `401 INVALID_CREDENTIALS` "Email or password is incorrect." (same for unknown email,
wrong password, or an account without a password). A new session replaces any session the browser
already held. Limits: 10 per 15 min per email, 30 per 15 min per IP.

Register, login and `GET /auth/me` all return:

```json
{ "data": {
  "user": { "id": "…", "email": "ram@example.com", "phone": null, "fullName": "Ram Bahadur",
            "role": "CUSTOMER", "status": "ACTIVE", "createdAt": "…" },
  "csrfToken": "…",
  "sessionExpiresAt": "…"
} }
```

### POST /api/v1/auth/logout → 204

Requires the session and `X-CSRF-Token`. Deletes the session server-side and clears the cookie.

### GET /api/v1/auth/me → 200 / 401

### GET /api/v1/listing-types

```json
{ "data": [
  { "code": "bus_ticket", "name": "Bus ticket", "unitLabel": "seat", "isBookable": true, "isActive": true },
  { "code": "flight_ticket", "name": "Flight ticket", "unitLabel": "seat", "isBookable": true, "isActive": false },
  { "code": "hotel", "name": "Hotel / property", "unitLabel": "property", "isBookable": false, "isActive": true }
] }
```

### GET /api/v1/listings

Query (all optional): `type` (listing type code), `location` (slug; includes everything inside it,
e.g. a province), `startDate`, `endDate`, `quantity` (units per date, default 1), `minPrice`,
`maxPrice` (minor-unit strings), `currency`, `sort` (`price_asc` | `price_desc` | `title`),
`page`, `pageSize` (≤ 50). Unknown parameters → 400.

Returns only listings that are APPROVED, from VERIFIED providers, of an **active and bookable**
type (so flights and hotel containers never appear). With `startDate`, only listings with an OPEN
inventory row on **every** date and at least `quantity` free units (held units count as taken).

```json
{
  "data": [{
    "id": "…", "title": "Double room", "slug": "…",
    "listingType": { "code": "hotel_room", "name": "Hotel room", "unitLabel": "night" },
    "provider": { "id": "…", "name": "Hillside Homestay" },
    "location": { "id": "…", "name": "Shree Antu", "slug": "shree-antu" },
    "parent": { "id": "…", "title": "Hillside Homestay", "slug": "…" },
    "currency": "NPR", "currencyExponent": 2,
    "basePriceMinor": "350000", "serviceChargeRateBps": 1000, "taxRateBps": 1300,
    "attributes": {},
    "availability": { "startDate": "2027-01-10", "endDate": "2027-01-12", "quantity": 1, "dates": 2,
                      "minAvailable": 3, "estimatedSubtotalMinor": "770000" }
  }],
  "pagination": { "page": 1, "pageSize": 20, "total": 1, "totalPages": 1 }
}
```

### GET /api/v1/listings/:id

Query: `from`, `to` (calendar window, default today → +14 days, max 60). Returns any publicly
visible listing (including containers, which list their bookable `children` and have no calendar).
`details` is the row from the listing's detail table (e.g. bus origin/destination, room capacity),
or `null`. 404 for inactive verticals, drafts and unverified providers.

```json
{ "data": {
  "id": "…", "title": "…", "listingType": { "code": "bus_ticket", "isBookable": true, "…": "…" },
  "provider": { "id": "…", "name": "…", "providerType": "bus_operator" },
  "currency": "NPR", "currencyExponent": 2, "basePriceMinor": "180000",
  "details": { "departureTime": "06:30", "durationMinutes": 300,
               "origin": { "slug": "inaruwa" }, "destination": { "slug": "shree-antu" } },
  "cancellationPolicy": { "id": "…", "name": "Flexible", "rules": [ … ] },
  "children": [],
  "calendar": { "from": "…", "to": "…", "currency": "NPR", "currencyExponent": 2,
                "slots": [{ "date": "2027-01-10", "status": "OPEN", "available": 33, "unitPriceMinor": "180000" }] }
} }
```

### POST /api/v1/trips → 201

```json
{ "currency": "NPR", "contact": { "name": "…", "phone": "…", "email": "…" } }
```

The owner is the logged-in user. Both fields are optional (`currency` defaults to `NPR`, contact
defaults to the user's details). Sending `userId` is rejected (400).

### POST /api/v1/trips/:id/items → 201 (full trip)

```json
{ "listingId": "uuid", "startDate": "2027-01-10", "endDate": "2027-01-12",
  "quantity": 1, "travellerCount": 2, "paymentMethod": "online | pay_at_property",
  "attributes": { "seatNumbers": ["A1"] } }
```

Server-side, in one transaction: validates the listing is bookable and in the trip's currency,
resolves each date's unit price (`price_override_minor` or the listing base price), computes
service charge, VAT, commission (15% of the subtotal, per item, half-up), provider payout, freezes
the cancellation policy, **reserves inventory** (CHECK constraint → 409 on overbooking), writes the
item and per-date lines, and recomputes trip totals. Clients never send money.

### PATCH /api/v1/trips/:id/items/:itemId → 200

Any of `startDate`, `endDate` (null clears it), `quantity`, `travellerCount`, `paymentMethod`,
`attributes`. Re-prices and re-reserves atomically; if the change can't be booked, the item is
left exactly as it was.

### DELETE /api/v1/trips/:id/items/:itemId → 200

Releases the item's inventory and recomputes totals.

### Trip responses are the customer view

Trip and quote responses show what the customer pays. **Commission rate/amount, provider payout,
commission status and payout status are not included**; they are stored per item for MeroStay
and providers (admin/partner views come in later phases).

### GET /api/v1/trips/:id → 200

```json
{ "data": {
  "id": "…", "reference": "MS-7K3F9QXR", "status": "DRAFT",
  "currency": "NPR", "currencyExponent": 2,
  "totals": {
    "subtotalMinor": "2030000", "serviceChargeMinor": "77000", "taxMinor": "110110",
    "totalMinor": "2217110", "payOnlineMinor": "1260000", "payAtPropertyMinor": "957110"
  },
  "items": [{
    "id": "…", "status": "PENDING",
    "listing": { "id": "…", "title": "…", "listingType": "hotel_room", "provider": { "id": "…", "name": "…" } },
    "startDate": "2027-01-10", "endDate": "2027-01-12", "travellerCount": 1, "quantity": 2,
    "paymentMethod": "pay_at_property", "paymentStatus": "PAY_AT_PROPERTY",
    "currency": "NPR", "currencyExponent": 2,
    "lines": [
      { "date": "2027-01-10", "units": 1, "unitPriceMinor": "350000", "amountMinor": "350000" },
      { "date": "2027-01-11", "units": 1, "unitPriceMinor": "420000", "amountMinor": "420000" }
    ],
    "money": { "subtotalMinor": "770000", "serviceChargeRateBps": 1000, "serviceChargeMinor": "77000",
               "taxRateBps": 1300, "taxMinor": "110110", "totalMinor": "957110",
               "paidMinor": "0", "refundedMinor": "0" },
    "cancellationPolicy": { "policyId": "…", "name": "Moderate", "rules": [ … ], "capturedAt": "…" },
    "attributes": {}
  }],
  "onlinePayment": { "paidMinor": "0", "dueMinor": "1260000" },
  "expiresAt": "…", "confirmedAt": null
} }
```

Totals: the first four are the stored trip aggregates (sum of active items). The split by
payment method is derived from the items: `payOnlineMinor + payAtPropertyMinor = totalMinor`.
`onlinePayment` (Phase 5): money received online so far (`paidMinor`, sum of allocations from
succeeded payments) and still to pay online (`dueMinor = payOnlineMinor − paidMinor`). Per item,
`money.paidMinor` is what has been allocated to that item.

### POST /api/v1/trips/:id/quote → 200 (dry run, nothing is written)

Body (optional): `{ "items": [ <same shape as add-item>, … ] }` = candidate items to price
alongside the trip's own items. Response: one line per item (`itemId` for existing items,
`candidateIndex` for candidates) with `money` (current prices), `heldMoney` (the price held on the
item), `priceChanged`, `available` and `unavailableDates`, plus `totals` in the same shape as the
trip. Mixed currencies → 422 `CURRENCY_MISMATCH`.

### POST /api/v1/trips/:id/confirm → 200

No payment is taken here (see payments below).

| Item paid… | Item status (in the response) | Stored commission status | Notes |
|---|---|---|---|
| at the property | `CONFIRMED` | `INVOICED` | Provider owes the commission; one **issued commission invoice per provider** is created in the same transaction (ADR 0007) |
| online | stays `PENDING` | `PENDING` | Awaits online payment; commission later deducted from the payout |

Trip → `CONFIRMED` when every item is confirmed; otherwise `PENDING` (awaiting payment) with a new
`expiresAt`. Money is not re-priced. A confirmed/pending trip can't be edited (409), so a retried
confirm never creates a second invoice.

## Payments (ADR 0007)

Online payment is a two-step flow: create an intent for what is due, then confirm it with the
gateway's result. **This phase has only a simulated gateway** (`PAYMENT_GATEWAY=simulated`,
refused in production); without a gateway both steps return `503 PAYMENTS_UNAVAILABLE`. Amounts
are always computed on the server; the client never sends a price. All endpoints are owner-only
(another user's trip → `404 TRIP_NOT_FOUND`) and writes need `X-CSRF-Token`.

**Per-item payment status**

| Status | Method | Meaning |
|---|---|---|
| `UNPAID` | online | Nothing received yet |
| `PARTIALLY_PAID` | online | Part of the total received; the item stays `PENDING` and is **never expired** by the hold-release job |
| `PAID` | online | Allocations equal the item total; the item is `CONFIRMED` |
| `PAY_AT_PROPERTY` | at property | Due to the provider on arrival |
| `PAID_AT_PROPERTY` | at property | Settled at the property (recorded by an admin) |
| `PARTIALLY_REFUNDED`, `REFUNDED` | online | Refunds (later phase) |

**Payment (transaction) status:** `INITIATED` (open intent) → `SUCCEEDED` / `FAILED` / `CANCELLED`
(cancelled when replaced by a new intent or when the hold-release job sweeps the trip). A finished
payment never changes.

### POST /api/v1/trips/:id/payments/intent → 201 (new) / 200 (existing)

Body: none or `{}`. The trip must be `PENDING` (confirmed, awaiting payment) and inside its hold
window. Due lines = every pending online item's `total − paid`, in item order.

```json
{ "data": {
  "created": true,
  "currency": "NPR", "currencyExponent": 2,
  "payment": {
    "id": "…", "tripId": "…", "kind": "CHARGE", "gateway": "simulated", "status": "INITIATED",
    "currency": "NPR", "currencyExponent": 2,
    "amountMinor": "1260000", "capturedMinor": "0", "gatewayTransactionId": null,
    "allocations": [], "createdAt": "…", "completedAt": null
  },
  "due": {
    "lines": [ { "itemId": "…", "dueMinor": "360000" }, { "itemId": "…", "dueMinor": "900000" } ],
    "totalDueMinor": "1260000"
  }
} }
```

`payment.id` is the payment reference (send it to the gateway as the order id). **Idempotent:**
while the due lines are unchanged, every call (also concurrent ones) returns the same open intent
with `200` and `created: false`. A trip has at most one open intent (enforced by the database).
Errors: `409 TRIP_NOT_CONFIRMED` (draft), `409 NOTHING_DUE`, `409 TRIP_EXPIRED`.

### POST /api/v1/trips/:id/payments/:paymentId/confirm → 200

Simulated gateway callback. Body (all optional):

| Field | Default | Meaning |
|---|---|---|
| `outcome` | `"succeeded"` | `"failed"` records a failed attempt (nothing allocated) |
| `capturedAmountMinor` | full `amountMinor` | Digit string; less than the intent amount simulates a partial capture |
| `gatewayTransactionId` | `SIM-<uuid>` | Unique per gateway |

On success the captured amount is allocated to the due lines **in order**: an item becomes `PAID`
(and `CONFIRMED`) only when fully covered, otherwise `PARTIALLY_PAID`. The trip becomes `CONFIRMED`
when no item is pending; after a partial payment, a new intent covers the remainder.

```json
{ "data": { "replayed": false, "payment": { "id": "…", "status": "SUCCEEDED",
  "amountMinor": "1260000", "capturedMinor": "500000",
  "allocations": [ { "itemId": "…", "amountMinor": "360000" }, { "itemId": "…", "amountMinor": "140000" } ],
  "currency": "NPR", "currencyExponent": 2, "…": "…" } } }
```

**Idempotent:** confirming a payment that already succeeded returns it with `replayed: true` and
changes nothing (no second capture, no second allocation, also under concurrency). Errors:
`404 PAYMENT_NOT_FOUND` (not a payment of this trip), `409 PAYMENT_NOT_OPEN` (failed/cancelled),
`409 PAYMENT_INTENT_STALE` (the amount due changed; create a new intent), `409 TRIP_EXPIRED`,
`422 INVALID_CAPTURED_AMOUNT` (more than the intent).

### GET /api/v1/trips/:id/payments → 200

`{ "data": { "currency": "NPR", "currencyExponent": 2, "payments": [ <payment>, … ] } }`, oldest first.

## Admin endpoints (ADR 0007)

Admin = the session user has role `ADMIN` (re-read on every request). No API grants that role;
an operator sets it in the database. Every other user gets `403 FORBIDDEN` for every `/admin` URL
before any data is read. Admin writes are logged with the admin's user id.

### POST /api/v1/admin/trips/:id/payments/at-property/settle → 200

Body: `{ "itemIds": ["…"] }` (1–50 distinct ids of the trip's items). Records that the customer
paid the provider on arrival: `PAY_AT_PROPERTY → PAID_AT_PROPERTY`. No money moves through MeroStay;
the commission stays `INVOICED`. Idempotent per item (`changed: false` the second time). Errors:
`404 TRIP_NOT_FOUND`, `404 ITEM_NOT_FOUND`, `422 ITEM_NOT_PAY_AT_PROPERTY`, `409 ITEM_NOT_CONFIRMED`.

```json
{ "data": { "tripId": "…", "items": [ { "id": "…", "status": "CONFIRMED",
  "paymentMethod": "pay_at_property", "paymentStatus": "PAID_AT_PROPERTY", "changed": true } ] } }
```

### GET /api/v1/admin/trips/:id/invoices → 200

The trip's commission invoices (internal view; provider-facing invoice endpoints arrive with the
partner dashboards). One invoice per provider with pay-at-property items:

```json
{ "data": [ { "id": "…", "number": "INV-20261121-K7Q3ZP2M", "status": "ISSUED", "tripId": "…",
  "provider": { "id": "…", "name": "…" }, "currency": "NPR", "currencyExponent": 2,
  "amountMinor": "115500", "issuedAt": "…", "dueOn": null, "paidAt": null,
  "items": [ { "id": "…", "listingType": "hotel_room", "paymentStatus": "PAY_AT_PROPERTY",
    "commissionStatus": "INVOICED", "subtotalMinor": "770000", "commissionRateBps": 1500,
    "commissionMinor": "115500" } ] } ] }
```

`amountMinor` always equals the sum of its items' `commissionMinor` (checked by the database when
the invoice is issued).

## Why the API is vertical-agnostic

No endpoint knows about hotels, buses or guides. The listing type comes from data
(`listing_types`), type-specific fields are returned generically as `details`/`attributes`, every
vertical uses the same inventory rows and the same pricing path, and the date shape is chosen by the
client. A new vertical (e.g. permits) is a `listing_types` row, an optional detail table (added to
`DETAIL_INCLUDE` in `listings.repository.ts`) and inventory rows. No new endpoints.

## Future extensions without endpoint changes

| Extension | How |
|---|---|
| Flights | Set `listing_types.is_active = true` for `flight_ticket`; flights then appear in search and can be added like any item |
| New verticals | Data only (see above); optional per-type filters can be added as optional query parameters |
| Live payment gateways (eSewa, Khalti) | New `gateway` values; the intent response gains the provider's redirect data and confirm verifies server-to-server. Paths and shapes stay |
| Refunds / cancellation | New `/trips/:id/items/:itemId/cancel`, using the frozen `cancellationPolicy` snapshot; `REFUND` payments (ADR 0007 plan) |
| Payouts / provider invoices | Finance and partner endpoints reading `payouts`, `provider_invoices`, `commissionStatus` / `payoutStatus` |
| Multi-currency trips | `currency` is already on every money-bearing object |

## Authentication history

Phase 3 served the trips API with a temporary `userId` and an opt-in flag. Phase 4 replaced both
with sessions and ownership (ADR 0006); the paths and the response shapes (minus `userId` and the
commission/payout fields) stayed the same.
