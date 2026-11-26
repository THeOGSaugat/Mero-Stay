# MeroStay API (v1)

Base path: `/api/v1`. JSON in, JSON out. Design decisions:
[ADR 0005](decisions/0005-search-and-booking-api-conventions.md) (search/booking conventions),
[ADR 0006](decisions/0006-authentication.md) (authentication),
[ADR 0007](decisions/0007-payments-and-invoices.md) (payments, invoices, hold-release job),
[ADR 0008](decisions/0008-partner-admin-and-audit.md) (partner/admin backend, audit log, idempotency keys).
Data model: [data-model.md](data-model.md).

| Area | Access |
|---|---|
| `/api/health…`, `/api/v1/listing-types`, `/api/v1/listings…`, `/api/v1/provider-types`, `/api/v1/locations` | **Public** (browsing needs no account) |
| `/api/v1/auth/register`, `/api/v1/auth/login` | Public, rate-limited, JSON only |
| `/api/v1/auth/me`, `/api/v1/auth/logout` | Session required |
| `/api/v1/trips…` (including `/trips/:id/payments…`) | **Session required, owner only.** Writes also need `X-CSRF-Token` |
| `/api/v1/partner/onboarding` | Session with role `CUSTOMER` or `PARTNER`. Needs `X-CSRF-Token` |
| `/api/v1/partner…` (everything else) | **Session with role `PARTNER`**; scoped to the partner's own provider (another provider's data → 404). Writes also need `X-CSRF-Token` |
| `/api/v1/admin…` | **Session with role `ADMIN`** (403 for everyone else). Writes also need `X-CSRF-Token` and are audited |

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

### Rate limits and the client IP (ADR 0014)

| Limit | Per | Key |
|---|---|---|
| Registration: 5 / hour | Client | Client IP (IPv6: its /64) |
| Login: 30 / 15 min | Client | Client IP (IPv6: its /64) |
| Login: 10 / 15 min | Account | The email address, whichever client sends it |

- **Per client, not global.** One client using up its budget does not affect any other client.
- **The client IP** is resolved through the trusted proxies only (`TRUST_PROXY_HOPS`,
  `TRUST_PROXY_ADDRESSES`). Behind the MeroStay web server, that is the address the web server saw.
- **`X-Forwarded-For` written by a client is ignored**, whether it reaches the API through the
  web server (only the entry the web server appended counts) or directly (an untrusted source).
  Sending a different header does not give a fresh budget.
- **When a limit is hit:** `429 RATE_LIMITED` with a `Retry-After` header (seconds) and
  `details.retryAfterSeconds`. The window is fixed: the count resets when it ends.
- **Audit rows** record the same resolved client IP.
- **Counters live in the API process** (one instance; gap 4). A restart resets them.

### 403 or 404?

| Situation | Answer |
|---|---|
| Wrong role for a whole area (customer on `/partner` or `/admin`, admin on `/partner`) | `403 FORBIDDEN`, checked **before any data is read**, same for every URL |
| Right role, but the resource belongs to someone else (another user's trip, another provider's listing, booking, invoice) | `404`, **identical to a resource that does not exist** |

### Pagination (partner and admin lists)

`?page=1&pageSize=20` (`pageSize` ≤ 100, any page). Responses: `{ "data": [ … ], "page": { "page": 1, "pageSize": 20, "total": 57, "totalPages": 3 } }` (`totalPages` since Phase 8). Every list has a stable order ending in a unique `id`, so pages never overlap or skip rows.

### Idempotency keys (ADR 0008)

Send `Idempotency-Key: <8–128 of A–Z a–z 0–9 _ ->` on a write to make retries safe: a retry with
the same key returns the first result (same status, header `Idempotent-Replayed: true`) without
applying again, also when requests race. **Required** on
`POST /partner/bookings/:itemId/settle-at-property`; optional on `POST /partner/onboarding`,
`POST /partner/verification-documents`, `POST /partner/listings`. The same key with a different
request → `422 IDEMPOTENCY_KEY_REUSED`. Only successful results are remembered.

### Money

| Rule | Example |
|---|---|
| Every money field ends in `Minor` and is a **string of digits** in minor units | `"totalMinor": "957110"` = Rs 9,571.10 |
| An optional amount that does not exist is `null` (never `0`, never a number) | `"priceOverrideMinor": null` = no date-specific price |
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
| 400 | `SETUP_LINK_INVALID` | Admin setup link unknown, used or expired (one answer for all) |
| 400 | `IDEMPOTENCY_KEY_REQUIRED`, `PROVIDER_ID_REQUIRED` | Settle without an Idempotency-Key / a partner with several providers did not send `X-Provider-Id` |
| 403 | `CSRF_TOKEN_INVALID`, `ACCOUNT_DISABLED`, `FORBIDDEN`, `PROVIDER_SUSPENDED` | Missing/invalid CSRF token on a write / suspended account (only after a correct password) / wrong role / suspended provider writing |
| 404 | `NOT_FOUND`, `LISTING_NOT_FOUND`, `TRIP_NOT_FOUND`, `ITEM_NOT_FOUND`, `PAYMENT_NOT_FOUND`, `PROVIDER_NOT_FOUND`, `BOOKING_NOT_FOUND`, `DOCUMENT_NOT_FOUND`, `DOCUMENT_FILE_NOT_FOUND`, `CANCELLATION_POLICY_NOT_FOUND`, `LOCATION_NOT_FOUND`, `RECONCILIATION_NOT_FOUND`, `PAYOUT_NOT_FOUND`, `ADMIN_NOT_FOUND`, `PAYOUT_ACCOUNT_NOT_FOUND` | The resource in the URL does not exist (or is not yours) |
| 409 | `INSUFFICIENT_AVAILABILITY`, `NOT_AVAILABLE`, `TRIP_NOT_EDITABLE`, `TRIP_EXPIRED`, `TRIP_EMPTY`, `ITEM_NO_LONGER_BOOKABLE`, `EMAIL_TAKEN`, `PHONE_TAKEN`, `CONFLICT`, `TRIP_NOT_CONFIRMED`, `NOTHING_DUE`, `PAYMENT_NOT_OPEN`, `PAYMENT_INTENT_STALE`, `ITEM_NOT_CONFIRMED`, `PARTNER_NOT_ONBOARDED`, `PROVIDER_IDENTITY_LOCKED`, `PROVIDER_NOT_SUBMITTABLE`, `NO_PENDING_DOCUMENTS`, `REQUIRED_DOCUMENTS_MISSING`, `PROVIDER_NOT_PENDING`, `LISTING_STATUS_NOT_ALLOWED`, `LISTING_SUSPENDED`, `SLOT_EXISTS`, `CAPACITY_BELOW_BOOKED`, `CANCELLATION_POLICY_IN_USE`, `DOCUMENT_ALREADY_UPLOADED`, `DOCUMENT_FILE_MISSING`, `DOCUMENT_NOT_CONFIRMABLE`, `DOCUMENT_APPROVED`, `PROVIDER_UNDER_REVIEW`, `DOCUMENT_STATE_CONFLICT`, `PAYMENT_IN_PROGRESS`, `RECONCILIATION_ALREADY_RESOLVED`, `RECONCILIATION_STATE_CONFLICT`, `PAYOUT_ACCOUNT_NOT_VERIFIED`, `PAYOUT_EMPTY`, `PAYOUT_NOT_SCHEDULABLE`, `PAYOUT_NOT_SCHEDULED`, `PAYOUT_ALREADY_PAID`, `PAYOUT_STATE_CONFLICT`, `LAST_ADMIN`, `ADMIN_SELF_LOCKOUT`, `ADMIN_ALREADY_SET_UP`, `LISTING_NOT_IN_REVIEW`, `ITEM_NOT_VOIDABLE_STATUS`, `ITEM_PAID_OUT`, `ITEM_IN_SCHEDULED_PAYOUT`, `ITEM_NOT_SETTLED`, `VOID_STATE_CONFLICT` | Conflicts with current state, availability or an existing account |
| 413 | `PAYLOAD_TOO_LARGE` | Body over the limit (100 KB JSON; 10 MB for a document file) |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Login/register sent as something other than `application/json`; a document file that is not PDF/JPEG/PNG |
| 422 | `CURRENCY_MISMATCH`, `LISTING_NOT_BOOKABLE`, `UNKNOWN_LISTING`, `UNKNOWN_LOCATION`, `UNKNOWN_LISTING_TYPE`, `INVALID_DATE_RANGE`, `DATE_IN_PAST`, `PRICING_INVARIANT_VIOLATED`, `INVALID_CAPTURED_AMOUNT`, `ITEM_NOT_PAY_AT_PROPERTY`, `PAYMENT_INVARIANT_VIOLATED`, `IDEMPOTENCY_KEY_REUSED`, `UNKNOWN_PROVIDER_TYPE`, `PROVIDER_TYPE_NOT_OFFERED`, `LISTING_TYPE_NOT_OFFERED`, `DETAILS_REQUIRED`, `DETAILS_NOT_SUPPORTED`, `UNKNOWN_PARENT_LISTING`, `UNKNOWN_CANCELLATION_POLICY`, `LISTING_NOT_BOOKABLE`, `LISTING_TYPE_NOT_ALLOWED`, `CANCELLATION_POLICY_INACTIVE`, `CANCELLATION_POLICY_NOT_USABLE`, `INVALID_CANCELLATION_RULES`, `DOCUMENT_TYPE_MISMATCH`, `DOCUMENT_SIZE_MISMATCH`, `DOCUMENT_CONTENT_INVALID`, `PAYMENT_GATEWAY_NOT_AVAILABLE`, `PAYMENT_CURRENCY_NOT_SUPPORTED`, `PAYMENT_GATEWAY_REJECTED`, `PAYMENT_CALLBACK_INVALID`, `REFUND_EXCEEDS_PAID` | Well-formed, but breaks a business rule |
| 429 | `RATE_LIMITED` | Too many login/registration attempts from this client (or for this email); see `Retry-After` and [rate limits](#rate-limits-and-the-client-ip-adr-0014) |
| 500 | `INTERNAL_ERROR` | Unexpected; details only in server logs |
| 502 | `PAYMENT_GATEWAY_UNAVAILABLE` | eSewa/Khalti did not answer (nothing was marked paid); try again |
| 503 | `PAYMENTS_UNAVAILABLE`, `STORAGE_UNAVAILABLE` | No payment gateway is configured (`PAYMENT_GATEWAYS` unset) / no document storage |

Database constraint violations are mapped (overbooking → 409, money checks → 422, payment/invoice
guards → 422 `PAYMENT_INVARIANT_VIOLATED`, refund guard → 422 `REFUND_EXCEEDS_PAID`, reconciliation
records → 409 `RECONCILIATION_STATE_CONFLICT`). Raw PostgreSQL text is never returned.

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
| GET | `/api/v1/trips` | The caller's own trips, newest first (Phase 7) |
| POST | `/api/v1/trips` | Create a draft trip |
| GET | `/api/v1/trips/:id` | Trip with items, money and statuses |
| POST | `/api/v1/trips/:id/items` | Add a booking item (holds inventory) |
| PATCH | `/api/v1/trips/:id/items/:itemId` | Change dates/quantity/payment method |
| DELETE | `/api/v1/trips/:id/items/:itemId` | Remove an item (releases inventory) |
| POST | `/api/v1/trips/:id/quote` | Dry-run pricing, optionally with candidate items |
| POST | `/api/v1/trips/:id/confirm` | Submit the trip (no payment taken; issues commission invoices) |
| POST | `/api/v1/trips/:id/payments/intent` | Create (or reuse) the payment intent and checkout for the chosen gateway (ADR 0017) |
| POST | `/api/v1/payment-callbacks/:gateway` | eSewa/Khalti return: verify with the gateway and apply (no session) |
| POST | `/api/v1/trips/:id/payments/:paymentId/refresh` | Ask the gateway now, server to server |
| POST | `/api/v1/trips/:id/payments/:paymentId/confirm` | Simulated gateway only: record a test result |
| GET | `/api/v1/trips/:id/payments` | The trip's payments and their allocations |
| POST | `/api/v1/admin/trips/:id/payments/at-property/settle` | ADMIN: record that pay-at-property items were paid on arrival |
| GET | `/api/v1/admin/trips/:id/invoices` | ADMIN: the trip's commission invoices |
| GET | `/api/v1/provider-types` | Provider types offered at onboarding, with required documents (ADR 0009) |
| GET | `/api/v1/locations` | The location tree, one level per request (Phase 7 Track B, ADR 0011) |
| POST | `/api/v1/partner/onboarding` | Create a provider; the customer becomes a partner |
| GET / PATCH | `/api/v1/partner/profile` | Own provider: profile, status, masked payout account |
| POST | `/api/v1/partner/verification/submit` | Ask for verification (DRAFT/REJECTED → PENDING_VERIFICATION) |
| GET / POST | `/api/v1/partner/verification-documents` | Own verification documents / request an upload (Phase 10, ADR 0016) |
| PUT / GET | `/api/v1/partner/verification-documents/:id/file` | Upload the file (raw body) / download own file |
| POST | `/api/v1/partner/verification-documents/:id/confirm` | Send an uploaded document for review |
| DELETE | `/api/v1/partner/verification-documents/:id` | Delete a document that is not approved (file removed) |
| GET / POST | `/api/v1/partner/cancellation-policies` | Own cancellation policies with usage / create one (Phase 10, ADR 0015) |
| GET / PATCH | `/api/v1/partner/cancellation-policies/:id` | One own policy / edit it (incl. `isActive`) |
| PUT | `/api/v1/partner/cancellation-policies/default` | The provider's default policy (`{ policyId \| null }`) |
| GET / POST | `/api/v1/partner/listings` | Own listings (all statuses) / create a listing |
| GET / PATCH | `/api/v1/partner/listings/:id` | One own listing / update it |
| GET / POST / PATCH | `/api/v1/partner/listings/:id/slots` | Own inventory: list a range / create a range / update a range |
| GET | `/api/v1/partner/bookings`, `/api/v1/partner/bookings/:itemId` | Own bookings (submitted trips) |
| POST | `/api/v1/partner/bookings/:itemId/settle-at-property` | Record payment on arrival (Idempotency-Key required) |
| GET | `/api/v1/partner/invoices` | Own commission invoices |
| GET | `/api/v1/partner/payouts` | Own payout summary (read-only, nothing executed) |
| GET | `/api/v1/admin/providers`, `/api/v1/admin/providers/:id` | ADMIN: providers, verification status, documents |
| POST | `/api/v1/admin/providers/:id/verification/:decision` | ADMIN: `approve` or `reject` (with a reason); audited |
| GET | `/api/v1/admin/invoices` | ADMIN: all commission invoices (filter provider/status/date) |
| GET | `/api/v1/admin/payouts` | ADMIN: payout summary across providers (read-only) |
| GET | `/api/v1/admin/audit-log` | ADMIN: the audit log (filter actor/action/entity/date); actors by name |
| GET | `/api/v1/admin/provider-types` | ADMIN: every provider type with its listing rules and flags (read-only, ADR 0013) |
| GET | `/api/v1/admin/payment-reconciliations` | ADMIN: late or unusable payments to handle (gap 8, ADR 0017) |
| POST | `/api/v1/admin/payment-reconciliations/:id/resolve` | ADMIN: mark one handled, with a note; audited |
| GET / POST | `/api/v1/admin/refund-requests` | ADMIN: refund requests / record one (stored, **never executed**); audited |
| POST | `/api/v1/admin/payout-batches/generate` | ADMIN: build or top up last month's (any month's) payout batches (Phase 12, ADR 0018) |
| GET | `/api/v1/admin/payout-batches`, `/api/v1/admin/payout-batches/:id` | ADMIN: payout batches / one with its items |
| POST | `/api/v1/admin/payout-batches/:id/schedule`, `…/mark-paid`, `…/mark-failed` | ADMIN: schedule a manual transfer, record it paid (bank reference) or failed; audited |
| POST | `/api/v1/admin/providers/:id/payout-account/verify` | ADMIN: mark the provider's default bank account verified; audited |
| GET | `/api/v1/partner/payout-batches`, `/api/v1/partner/payout-batches/:id` | Own payout batches (read-only) |
| GET / POST | `/api/v1/admin/admins` | ADMIN: admins / add one (returns a one-time setup link once); audited |
| POST | `/api/v1/admin/admins/:id/setup-link`, `…/suspend`, `…/reactivate` | ADMIN: new setup link / suspend / reactivate; audited |
| POST | `/api/v1/auth/admin-setup` | Invited admin sets a password with the setup link (no session) |
| GET | `/api/v1/admin/listings`, `/api/v1/admin/listings/:id` | ADMIN: listings to review (type-rule hint) |
| POST | `/api/v1/admin/listings/:id/approve`, `…/reject` | ADMIN: approve (re-checks the listing-type rule) / reject with a reason; audited |
| POST | `/api/v1/admin/booking-items/:id/void`, `/api/v1/admin/trips/:id/void` | ADMIN: void a booking item / every voidable item of a trip; audited |
| POST | `/api/v1/admin/booking-items/:id/settlement/reverse` | ADMIN: undo a pay-at-property settlement recorded by mistake; audited |

### POST /api/v1/auth/register → 201 (+ session cookie)

```json
{ "email": "ram@example.com", "password": "at least 12 characters", "fullName": "Ram Bahadur", "phone": "+9779812345678" }
```

Email is trimmed and lower-cased. Password: 12–128 characters, not a common password. `phone` is
optional (international format). New accounts are `CUSTOMER`s. Duplicate email → `409 EMAIL_TAKEN`,
duplicate phone → `409 PHONE_TAKEN`. Limit: 5 per hour per client IP.

### POST /api/v1/auth/login → 200 (+ session cookie)

```json
{ "email": "ram@example.com", "password": "…" }
```

Any failure → `401 INVALID_CREDENTIALS` "Email or password is incorrect." (same for unknown email,
wrong password, or an account without a password). A new session replaces any session the browser
already held. Limits: 10 per 15 min per email, 30 per 15 min per client IP.

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
  "cancellationPolicy": { "id": "…", "name": "Flexible", "description": "…", "nonRefundable": false,
                          "rules": [ … ], "source": "listing" },
  "children": [],
  "calendar": { "from": "…", "to": "…", "currency": "NPR", "currencyExponent": 2,
                "slots": [{ "date": "2027-01-10", "status": "OPEN", "available": 33, "unitPriceMinor": "180000" }] }
} }
```

### GET /api/v1/trips → 200 (Phase 7)

The caller's **own** trips only (owner-scoped in the query: another user's trips are never listed),
newest first. Query: `status` (e.g. `DRAFT` to find the current draft), `page`, `pageSize` (≤ 50).
Customer view: no commission or payout data.

```json
{ "data": [ { "id": "…", "reference": "MS-7K3F9QXR", "status": "PENDING", "currency": "NPR",
  "currencyExponent": 2,
  "totals": { "subtotalMinor": "2030000", "serviceChargeMinor": "77000", "taxMinor": "110110",
              "totalMinor": "2217110" },
  "items": [ { "id": "…", "status": "CONFIRMED", "title": "Double room", "listingType": "hotel_room",
               "startDate": "2027-01-10", "endDate": "2027-01-12" } ],
  "expiresAt": "…", "confirmedAt": null, "createdAt": "…" } ],
  "pagination": { "page": 1, "pageSize": 20, "total": 3, "totalPages": 1 } }
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
    "cancellationPolicy": { "policyId": "…", "name": "Moderate", "description": "…", "nonRefundable": false,
                            "rules": [ … ], "source": "provider", "capturedAt": "…" },
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

## Payments (ADR 0007, ADR 0017)

Online payment: the customer chooses a gateway, the API creates an intent for exactly what is due
and returns a **checkout** for the browser; the gateway sends the customer back to the web app,
which hands the gateway's answer to the **callback** endpoint; the API verifies it **server to
server** before anything is marked paid. Gateways (`PAYMENT_GATEWAYS`): `esewa` (ePay v2), `khalti`
(ePayment v2), and `simulated` (development and tests only, refused in production; paid through
`/confirm`). Without a gateway the endpoints return `503 PAYMENTS_UNAVAILABLE`. Amounts are always
computed on the server; the client never sends a price or a status. Trip endpoints are owner-only
(another user's trip → `404 TRIP_NOT_FOUND`) and writes need `X-CSRF-Token`.

**Never paid from the redirect alone.** eSewa: the callback's `data` must carry a valid HMAC-SHA256
signature for this payment and merchant, **and** eSewa's status API must say `COMPLETE` for the same
amount. Khalti: the return's `pidx` only names the payment; Khalti's lookup must say `Completed`
for exactly the amount asked. Anything else is `pending`, `failed` or `expired`.

**Per-item payment status**

| Status | Method | Meaning |
|---|---|---|
| `UNPAID` | online | Nothing received yet |
| `PARTIALLY_PAID` | online | Part of the total received; the item stays `PENDING` and is **never expired** by the hold-release job |
| `PAID` | online | Allocations equal the item total; the item is `CONFIRMED` |
| `PAY_AT_PROPERTY` | at property | Due to the provider on arrival |
| `PAID_AT_PROPERTY` | at property | Settled at the property (recorded by an admin) |
| `PARTIALLY_REFUNDED`, `REFUNDED` | online | Refunds (Cancellations & refunds phase) |

**Payment (transaction) status:** `INITIATED` (open intent) → `SUCCEEDED` / `FAILED` / `CANCELLED`
(cancelled when replaced by a new intent, when the hold-release job sweeps the trip, or when money
arrives that can no longer be applied). A finished payment never changes.

**Late or unusable money (gap 8).** Money the gateway confirms is never dropped. If it cannot be
applied (the payment was already cancelled, e.g. the hold expired; the trip no longer waits; the
amount due changed; the gateway took a different amount; or a second transaction on a paid
intent), it is recorded once in `payment_reconciliations` (unique per gateway transaction) for an
admin, and nothing is allocated. The callback answers `outcome: "reconciliation"`.

### POST /api/v1/trips/:id/payments/intent → 201 (new) / 200 (existing)

Body: `{ "gateway": "esewa" | "khalti" | "simulated" }` (one of the enabled gateways, else
`422 PAYMENT_GATEWAY_NOT_AVAILABLE`). The trip must be `PENDING` (confirmed, awaiting payment) and
inside its hold window. Due lines = every pending online item's `total − paid`, in item order.
eSewa and Khalti accept NPR only (`422 PAYMENT_CURRENCY_NOT_SUPPORTED`); Khalti needs at least
Rs 10 (`422 PAYMENT_GATEWAY_REJECTED`).

```json
{ "data": {
  "created": true,
  "currency": "NPR", "currencyExponent": 2,
  "payment": {
    "id": "…", "tripId": "…", "kind": "CHARGE", "gateway": "esewa", "status": "INITIATED",
    "currency": "NPR", "currencyExponent": 2,
    "amountMinor": "1260000", "capturedMinor": "0", "gatewayTransactionId": null,
    "allocations": [], "createdAt": "…", "completedAt": null
  },
  "due": {
    "lines": [ { "itemId": "…", "dueMinor": "360000" }, { "itemId": "…", "dueMinor": "900000" } ],
    "totalDueMinor": "1260000"
  },
  "checkout": { "type": "form", "method": "POST",
    "url": "https://rc-epay.esewa.com.np/api/epay/main/v2/form",
    "fields": { "amount": "12600", "tax_amount": "0", "total_amount": "12600",
      "transaction_uuid": "<payment id>", "product_code": "EPAYTEST",
      "product_service_charge": "0", "product_delivery_charge": "0",
      "success_url": "https://<web>/payments/esewa/return/<payment id>",
      "failure_url": "https://<web>/payments/esewa/failure/<payment id>",
      "signed_field_names": "total_amount,transaction_uuid,product_code", "signature": "…" } }
} }
```

`checkout` is what the browser does next and never contains a secret: eSewa = POST this signed
form (rupees, as eSewa expects); Khalti = `{ "type": "redirect", "url": "<payment_url>" }` (the API
called Khalti's initiate with paisa); simulated = `{ "type": "simulated" }`. **Idempotent:** while
the due lines and the gateway are unchanged and the checkout is still valid, every call returns the
same open intent and checkout with `200` and `created: false`. Choosing another gateway, or a
change in what is due, cancels the open intent and starts a new one. A trip has at most one open
intent (enforced by the database). Errors: `409 TRIP_NOT_CONFIRMED` (draft), `409 NOTHING_DUE`,
`409 TRIP_EXPIRED`, `409 PAYMENT_IN_PROGRESS` (concurrent calls wait up to 12 s for the first
one's checkout and get the same intent; this only when it never appeared or failed: retry),
`502 PAYMENT_GATEWAY_UNAVAILABLE` (the gateway did not answer; the intent is closed as `FAILED`).

### POST /api/v1/payment-callbacks/:gateway → 200 (no session)

`:gateway` = `esewa` or `khalti`. Called by the web app's return pages
(`/payments/<gateway>/return/<paymentId>`, `/payments/<gateway>/failure/<paymentId>`) with what the
gateway put in the address. No session or CSRF token: nothing in it is trusted; the API verifies it
with the gateway. Rate limited per client (30 per minute).

| Gateway | Body | Verification |
|---|---|---|
| eSewa | `{ "paymentId": "…", "data": "<base64 from eSewa>" }` | Signature (constant-time), same `transaction_uuid` and product code, then the status API. Without `data` (failure page): the status API only |
| Khalti | `{ "paymentId": "…", "pidx": "…" }` | `pidx` must be this payment's; then Khalti's lookup. Other return parameters are ignored |

```json
{ "data": { "tripId": "…", "outcome": "paid",
  "payment": { "id": "…", "status": "SUCCEEDED", "capturedMinor": "1260000", "…": "…" },
  "reconciliation": null } }
```

`outcome`: `paid`, `replayed` (already applied: the same transaction again changes nothing),
`pending` (not confirmed yet), `failed`, `expired`, or `reconciliation` (money received that could
not be applied; `reconciliation: { id, reason }`). Repeats, reloads and concurrent calls are safe:
one allocation per payment, one reconciliation per gateway transaction. Errors:
`404 PAYMENT_NOT_FOUND` (unknown payment, or not this gateway's), `422 PAYMENT_CALLBACK_INVALID`
(forged, tampered or for another payment), `502 PAYMENT_GATEWAY_UNAVAILABLE` (try again).
Responses carry `Cache-Control: no-store`.

### POST /api/v1/trips/:id/payments/:paymentId/refresh → 200

Owner only. Asks the gateway (server to server) what happened to this eSewa or Khalti payment and
applies the result exactly like a callback (same response). Simulated payments → `409`.

### POST /api/v1/trips/:id/payments/:paymentId/confirm → 200

**Simulated gateway only** (development and tests): stands in for a verified callback. Body (all
optional):

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

## Partner endpoints (ADR 0008)

Role `PARTNER`. Each request acts for **one provider the user owns**: the only one, or the one in
`X-Provider-Id` when the user owns several (`400 PROVIDER_ID_REQUIRED` without it; a provider
that is not yours → `404 PROVIDER_NOT_FOUND`). Everything returned belongs to that provider; any
other provider's id in a URL is a `404`.

### POST /api/v1/partner/onboarding → 201

Any logged-in customer (or partner adding a business). Body: `{ providerTypeCode, legalName,
displayName, description?, contactEmail?, contactPhone? (+977…), addressLine?, panNumber? (9 digits),
vatNumber?, businessRegistrationNo? }`. Creates the provider as `DRAFT`; the user's role becomes
`PARTNER`. Audited. Optional Idempotency-Key. Response: the profile (below).

### GET /api/v1/partner/profile → 200, PATCH → 200

```json
{ "data": { "id": "…", "providerType": { "code": "hotel", "name": "Hotel / accommodation" },
  "legalName": "…", "displayName": "…", "status": "PENDING_VERIFICATION", "verifiedAt": null,
  "rejectionReason": null, "contact": { "email": null, "phone": "+9779800000001", "addressLine": null },
  "tax": { "panNumber": "123456789", "vatNumber": null, "businessRegistrationNo": null },
  "payoutAccount": { "id": "…", "bankName": "Nabil Bank", "branch": null, "accountName": "…",
    "accountNumberMasked": "••••9012", "verified": false, "verifiedAt": null },
  "documents": { "PENDING": 1, "APPROVED": 0, "REJECTED": 0 },
  "commissionRateBps": null, "createdAt": "…", "updatedAt": "…" } }
```

**Bank account numbers are never returned in full** (partner or admin). PATCH accepts contact
fields at any time, legal/tax fields only while `DRAFT`/`REJECTED` (`409
PROVIDER_IDENTITY_LOCKED`), and `payoutAccount: { bankName, branch?, accountName, accountNumber }`:
a new account becomes the default **unverified** (re-verification) and is audited; the same account
again changes nothing.

### GET /api/v1/provider-types → 200 (public, ADR 0009)

Only types with `is_active = true` (a type not offered yet, e.g. airline while flights are not
built, is absent). Each lists its **required document groups**: one document of any listed type
satisfies a group.

```json
{ "data": [ { "code": "hotel", "name": "Hotel / accommodation", "description": "…",
  "requiredDocuments": [
    { "requirement": "identity", "acceptedDocumentTypes": ["OWNER_ID"] },
    { "requirement": "registration",
      "acceptedDocumentTypes": ["BUSINESS_REGISTRATION", "LOCAL_GOVERNMENT_REGISTRATION"] } ],
  "allowedListingTypes": [
    { "code": "hotel", "name": "Hotel / property", "unitLabel": "property", "isBookable": false },
    { "code": "hotel_room", "name": "Hotel room", "unitLabel": "night", "isBookable": true } ] } ] }
```

Onboarding with a type that is not offered → `422 PROVIDER_TYPE_NOT_OFFERED`.
`allowedListingTypes` (Phase 8, ADR 0013): the listing types this kind of business may create, i.e.
mapped in `provider_type_listing_types` **and** active. The partner profile carries the same list
as `providerType.allowedListingTypes`.

### GET /api/v1/locations → 200 (public, Phase 7 Track B)

Province → District → City/Area, **one level per request** (small responses on mobile data).
Without `parentId`: the top level (locations without a parent, e.g. `Nepal`). With
`?parentId=<uuid>`: that location's direct children, by name. An unknown parent →
`404 LOCATION_NOT_FOUND`; any other parameter → `400`. Used by the partner listing forms (bus
origin/destination, a listing's place); customer search still takes a slug (gap 20).

```json
{ "data": [ { "id": "…", "parentId": "…", "kind": "DISTRICT", "name": "Kaski", "slug": "kaski",
  "hasChildren": true } ] }
```

### Verification documents (Phase 10, ADR 0016)

Files are private and pass through the API only: no storage key, URL or presigned link is ever
returned. Statuses: `AWAITING_UPLOAD → UPLOADED → PENDING` (for review) `→ APPROVED | REJECTED`.

| Step | Request | Response |
|---|---|---|
| 1. Request | `POST /partner/verification-documents` `{ documentType, fileName, mimeType (application/pdf \| image/jpeg \| image/png), sizeBytes (1 B – 10 MB), documentNumber?, expiresOn? }`, `Idempotency-Key` optional | `201 { data: document, upload: { method: "PUT", path, contentType, sizeBytes } }`; status `AWAITING_UPLOAD` |
| 2. Upload | `PUT /partner/verification-documents/:id/file`, the raw file as the body, `Content-Type` = the declared type, `X-CSRF-Token` | `200 { data: document }`, `UPLOADED` |
| 3. Confirm | `POST /partner/verification-documents/:id/confirm` `{}` | `200 { data: { changed, document } }`, `PENDING` (repeating changes nothing) |

**Upload checks.**

- **Type:** `Content-Type` other than the declared type → `422 DOCUMENT_TYPE_MISMATCH`; not
  PDF/JPEG/PNG at all → `415 UNSUPPORTED_MEDIA_TYPE`.
- **Size:** a length other than `sizeBytes` → `422 DOCUMENT_SIZE_MISMATCH`; over 10 MB →
  `413 PAYLOAD_TOO_LARGE`.
- **Content:** bytes that are not really that type → `422 DOCUMENT_CONTENT_INVALID`.
- **Repeat:** a second upload → `409 DOCUMENT_ALREADY_UPLOADED`; confirming before the upload →
  `409 DOCUMENT_FILE_MISSING`.
- **Stored bytes:** JPEG/PNG metadata (EXIF/GPS, comments, text chunks) is removed before
  storage. The stored size and SHA-256 are recorded; `sizeBytes` then shows the stored size.

**Document fields:** `id, documentType, status, fileName, mimeType, sizeBytes, hasFile,
uploadedAt, documentNumber, expiresOn, reviewedAt, rejectionReason, createdAt`. `storageKey` is no
longer accepted or returned.

**Download.** `GET /partner/verification-documents/:id/file` returns the owner's own file:
`Content-Disposition: attachment`, `Cache-Control: private, no-store`, and a sandboxing
`Content-Security-Policy`. A document of another provider, a deleted one, or one without a file is
`404` (`DOCUMENT_NOT_FOUND` / `DOCUMENT_FILE_NOT_FOUND`).

**Delete.** `DELETE /partner/verification-documents/:id` → `204`. The record becomes a tombstone
and the file is removed. An approved document cannot be deleted (`409 DOCUMENT_APPROVED`), nor a
submitted one while the provider is under review (`409 PROVIDER_UNDER_REVIEW`).

**Audit and storage.** Every step is audited with metadata only. Without configured storage the
file endpoints answer `503 STORAGE_UNAVAILABLE`.

`GET /partner/verification-documents` lists live documents.
`POST /partner/verification/submit` (body `{}`) → `{ data: { changed, provider } }`. Every required
group of the provider type must have a PENDING (uploaded and confirmed) or APPROVED document; at
least one must be PENDING (`409 NO_PENDING_DOCUMENTS`), otherwise `409
REQUIRED_DOCUMENTS_MISSING` with `details.missing: [ { requirement, acceptedDocumentTypes } ]`. The
same check runs again when an admin approves.

### Listings

`POST /partner/listings` → 201: `{ listingTypeCode, title, description?, parentId? (own listing),
locationId?, currency, basePriceMinor ("350000"), serviceChargeRateBps?, taxRateBps?,
defaultCancellationPolicyId?, addressLine?, attributes?, details? }`. `details` holds the type's
fields (e.g. `hotel_room`: `maxAdults`, `bedType`, …; `bus_ticket`: route, departure, seats);
types without a detail table (e.g. `activity`) use `attributes` only. `providerId` and
`commissionRateBps` are rejected (400). New listings are `DRAFT`; PATCH may set `status` to
`PENDING_REVIEW`, `ARCHIVED` or (from archived) `DRAFT`. Approval is an admin action. List:
`?status=&listingType=&page=&pageSize=`.

**Listing-type rule (Phase 8, ADR 0013, gap 22).** A provider may create, or change, only listings
whose type its provider type is mapped to while **both** types are active:

| Case | Answer |
|---|---|
| Unknown or inactive listing type | `422 LISTING_TYPE_NOT_OFFERED` (unchanged) |
| Not mapped, or the provider type is not offered | `422 LISTING_TYPE_NOT_ALLOWED`, `details: { listingTypeCode, providerTypeCode, reason: "not_mapped" \| "provider_type_not_offered", allowedListingTypes: [...] }` |
| PATCH of a listing whose type is no longer usable | The same errors; a PATCH of only `{ "status": "ARCHIVED" }` is always accepted |
| PATCH with `listingTypeCode` | `400 VALIDATION_ERROR` (the type of a listing cannot change) |

Nothing is written when refused. A database trigger (`listings_listing_type_allowed_chk`) refuses
an unmapped pair on any write path (→ `422 LISTING_TYPE_NOT_ALLOWED`).

### Inventory: /partner/listings/:id/slots

- `GET ?startDate=&endDate=` → `{ data: { listingId, currency, currencyExponent, basePriceMinor,
  slots: [ { id, date, status, capacityTotal, capacityBooked, available, priceOverrideMinor
  (string or null), effectivePriceMinor } ] } }`.
- `POST { startDate, endDate, capacityTotal, priceOverrideMinor?, status? }` → 201 (`created`,
  `unchanged` counts). Identical existing slots are left alone; different ones → `409 SLOT_EXISTS`.
- `PATCH { startDate, endDate, capacityTotal?, priceOverrideMinor?, status? }` → `updated`,
  `missingDates`. Capacity below booked → `409 CAPACITY_BELOW_BOOKED`.
- Ranges are `[startDate, endDate)`, ≤ 366 days. Container listings (a hotel property) → 422.

### Bookings

`GET /partner/bookings?status=&from=&to=&page=` and `GET /partner/bookings/:itemId`: booking items
of **submitted** trips for the partner's provider. Customer shown by **name only**; email and phone
masked. Includes the money snapshot with commission and payout (this is MeroStay ↔ provider data):

```json
{ "data": { "id": "…", "tripReference": "MS-…", "status": "CONFIRMED", "listing": { … },
  "startDate": "…", "endDate": "…", "quantity": 1,
  "customer": { "name": "Sita Sharma", "emailMasked": "s•••@e•••.com", "phoneMasked": "+977••••••5678" },
  "paymentMethod": "pay_at_property", "paymentStatus": "PAY_AT_PROPERTY", "commissionStatus": "INVOICED",
  "payoutStatus": "NOT_APPLICABLE", "currency": "NPR", "currencyExponent": 2,
  "money": { "subtotalMinor": "700000", "serviceChargeMinor": "70000", "taxMinor": "100100",
    "totalMinor": "870100", "commissionRateBps": 1500, "commissionMinor": "105000",
    "providerPayoutMinor": "765100", "paidOnlineMinor": "0", "refundedMinor": "0" },
  "commissionInvoice": { "id": "…", "number": "INV-…", "status": "ISSUED" },
  "settledAt": null, "settledBy": null } }
```

The detail adds `lines`, `cancellationPolicy` (the frozen snapshot) and `attributes`.

### POST /partner/bookings/:itemId/settle-at-property → 200

Header `Idempotency-Key` **required**; body `{}`. `PAY_AT_PROPERTY → PAID_AT_PROPERTY`, records who
and when, commission stays `INVOICED`, no money moves. Bookings show them as `settledAt` and
`settledBy: { role, name }` (Phase 7 Track B): the partner's own name, or `{ "role": "ADMIN",
"name": "MeroStay" }` when MeroStay staff recorded it (staff names are not shared). Retries (also concurrent) apply
once; an already settled item is returned unchanged. Audited once. `{ data: { replayed, booking } }`.
Errors: `404 BOOKING_NOT_FOUND`, `422 ITEM_NOT_PAY_AT_PROPERTY`, `409 ITEM_NOT_CONFIRMED`.

### Invoices and payouts

- `GET /partner/invoices?status=&from=&to=&page=`: own commission invoices (same shape as the admin
  invoice view, ADR 0007).
- `GET /partner/payouts?from=&to=&page=`: read-only summary of online-paid items whose payout is
  pending, per **service month** and currency:

```json
{ "data": [ { "provider": { "id": "…", "name": "…" }, "period": "2026-12", "currency": "NPR",
  "currencyExponent": 2, "items": 1, "subtotalMinor": "350000", "serviceChargeMinor": "35000",
  "taxMinor": "50050", "totalMinor": "435050", "commissionMinor": "52500",
  "providerPayoutMinor": "382550", "payoutStatus": "PENDING", "executed": false } ],
  "page": { "page": 1, "pageSize": 20, "total": 1 } }
```

`providerPayoutMinor` = Σ (total − commission) per item (Phase 2 formula; commission = 15% of the
subtotal). Nothing is paid out in this phase.

### Cancellation policies (Phase 10, ADR 0015)

A policy is a name, an optional description, and a structured rule:

- **Refund tiers:** `rules: [{ minHoursBeforeStart, refundBps }]`, 1–10 of them. Hours are whole
  numbers from 0 to 8760 and strictly decreasing; `refundBps` is 1–10000 and never increases.
  Cancelling later than the last tier gets nothing.
- **Or non-refundable:** `nonRefundable: true` with `rules: []`.

No refund is ever computed here (that comes with refunds, Phase 14).

| Request | Result |
|---|---|
| `GET /partner/cancellation-policies` | `{ data: { defaultPolicyId, policies: [ { id, name, description, nonRefundable, rules, isActive, isPlatformTemplate, createdAt, updatedAt, usage: { listings, providerDefault } } ] } }`, oldest first |
| `POST /partner/cancellation-policies` `{ name, description?, nonRefundable?, rules? }` | `201`, the policy. Bad rules → `400 VALIDATION_ERROR` (details per tier). `Idempotency-Key` optional |
| `GET /partner/cancellation-policies/:id` | The policy; another provider's → `404 CANCELLATION_POLICY_NOT_FOUND` |
| `PATCH /partner/cancellation-policies/:id` `{ name?, description?, nonRefundable?, rules?, isActive? }` | The merged rule is checked again (`nonRefundable: true` alone clears the tiers). Switching off a policy that a listing or the default uses → `409 CANCELLATION_POLICY_IN_USE`, `details: { listings, providerDefault }`. Existing bookings never change |
| `PUT /partner/cancellation-policies/default` `{ policyId \| null }` | `{ data: { changed, defaultPolicyId } }` |

**Attaching.**

- A listing uses `defaultCancellationPolicyId` on `POST`/`PATCH /partner/listings`.
- Only an own, active policy can be attached: another provider's →
  `422 UNKNOWN_CANCELLATION_POLICY`; a switched-off one → `422 CANCELLATION_POLICY_INACTIVE`.
- The database refuses the same (`422 CANCELLATION_POLICY_NOT_USABLE`,
  `422 INVALID_CANCELLATION_RULES`).

**Resolution.** The listing's policy, else the provider's default, else none.

- `GET /listings/:id` returns it as `cancellationPolicy` with `source: "listing" | "provider"`, or
  `null` (shown as "no cancellation policy").
- Adding an item to a trip freezes it in the item's `cancellationPolicy` snapshot
  `{ policyId, name, description, nonRefundable, rules, source, capturedAt }`.
- Every write is audited.

## Admin endpoints for providers, finance and audit (ADR 0008)

- `GET /admin/providers?q=&status=&providerType=&sort=&page=&pageSize=` and `GET /admin/providers/:id`:
  providers with owner contact, verification status, document counts (detail: document list),
  payout account **masked**. `q` (Phase 8, gap 25; trimmed, 1–100 characters) matches the display
  or legal name, the owner's email or the provider type's name (case-insensitive, contains) or the
  type code; `sort` = `newest` (default), `oldest` or `name`, always with an `id` tie-breaker.
- `GET /admin/provider-types` (Phase 8, read-only): every provider type, offered or not, with
  `isActive`, `requiredDocuments`, `listingTypes` (the full mapping, each with its own `isActive`)
  and `usableListingTypes` (mapped and both active).
- `POST /admin/providers/:id/verification/approve|reject` body `{ reason? }` (required to reject) →
  the provider. Only from `PENDING_VERIFICATION` (else `409 PROVIDER_NOT_PENDING`); approve also
  approves pending documents and verifies the payout account. One audit row per decision.
- `GET /admin/providers/:id/documents/:documentId/file` (Phase 10): the document's file, for
  admins only (attachment, no-store); every view writes a `provider.document.view` audit row
  (metadata only). Another provider's document under this id → `404 DOCUMENT_NOT_FOUND`.
- `GET /admin/providers/:id/cancellation-policies` (Phase 10, read-only): the provider's policies
  with usage and its default, in the partner list's shape.
- `GET /admin/invoices?q=&providerId=&status=&from=&to=&page=` (newest first since Phase 8; `q`
  matches the invoice number or provider name) and `GET /admin/payouts?q=&providerId=&from=&to=&page=`
  (`q` matches the provider name; LIKE wildcards in `q` are literal). Partner invoices are newest
  first as well.
- `GET /admin/audit-log?actorUserId=&action=&entityType=&entityId=&from=&to=&page=`, newest first:

```json
{ "data": [ { "id": "…", "actor": { "userId": "…", "role": "ADMIN", "name": "Anita Sharma" },
  "action": "provider.verification.approve", "entity": { "type": "provider", "id": "…" },
  "before": { "status": "PENDING_VERIFICATION", "pendingDocumentIds": ["…"] },
  "after": { "status": "VERIFIED", "documentStatus": "APPROVED", "reason": null },
  "ip": "…", "requestId": "…", "createdAt": "…" } ], "page": { … } }
```

`actor.name` (Phase 8) is the user's full name only (no email or phone), loaded once per page;
`actor` is `null` for a system action. Audit payloads never contain passwords, hashes, tokens, secrets or full bank numbers (redacted in
code; refused by a database CHECK). Actions recorded: `provider.create`,
`provider.payout_account.change`, `provider.document.submit`, `provider.verification.submit`,
`provider.verification.approve|reject`, `booking_item.settle_at_property`, `trip.settle_at_property`,
`payment_reconciliation.resolve`, `refund_request.create` (Phase 11).

## Admin: late payments and refund requests (Phase 11, ADR 0017)

- `GET /admin/payment-reconciliations?status=OPEN|RESOLVED&page=&pageSize=`, newest first: money a
  gateway confirmed that could not be applied (gap 8). `reason`: `PAYMENT_NOT_OPEN` (the payment was
  already cancelled, typically the hold expired), `TRIP_NOT_AWAITING_PAYMENT`, `INTENT_STALE` (the
  amount due changed), `AMOUNT_MISMATCH` (the gateway took a different amount), `DUPLICATE_PAYMENT`
  (a second transaction on a paid intent).

```json
{ "data": [ { "id": "…", "paymentId": "…", "trip": { "id": "…", "reference": "MS-7KQ2…" },
  "gateway": "esewa", "gatewayTransactionId": "000AWEO", "currency": "NPR", "currencyExponent": 2,
  "amountMinor": "360000", "reason": "PAYMENT_NOT_OPEN", "status": "OPEN",
  "gatewayResponse": { "status": "COMPLETE", "…": "…" }, "note": null, "createdAt": "…",
  "resolvedAt": null, "resolvedById": null } ], "page": { … } }
```

- `POST /admin/payment-reconciliations/:id/resolve` `{ "note": "…" }` (1–1000 characters): marks it
  handled, once (`409 RECONCILIATION_ALREADY_RESOLVED`); audited. What the gateway reported can never
  change; the database refuses edits and deletes (`payment_reconciliations_immutable_chk`).
- `POST /admin/refund-requests` `{ "paymentId", "bookingItemId" | "paymentReconciliationId",
  "amountMinor": "<digits>", "reason" }` → `201`: records what should go back to the customer.
  **Nothing is executed**: no gateway call, no money moves; the database keeps every request
  `REQUESTED` or `REJECTED` (`refund_requests_not_executed_chk`) and never above what the payment
  paid for that item, or what the late payment recorded, across open requests
  (`422 REFUND_EXCEEDS_PAID`, with `availableMinor`). The response includes the gateway's refund
  capability (`gatewayRefundCapability: { api: "documented" | "none", partial, note }`) and
  `executed: false`. Audited. `GET /admin/refund-requests?paymentId=&page=` lists them.

## Payouts, admin accounts and moderation (Phase 12, ADR 0018)

All `/admin…` endpoints need role ADMIN (403 otherwise, before any data is read); writes need
`X-CSRF-Token`, are audited, and repeating one changes nothing (`changed: false`).

**Payout batches** (gap 16). MeroStay pays providers by MANUAL bank transfer and records it; no
bank is called. An item is eligible once its service is over in Nepal time, paid online in full,
not cancelled, not already in a batch and without an open refund request. One batch per provider,
currency and calendar month of the service date. Net = gross − commission.

- `POST /admin/payout-batches/generate {"period":"2026-10"}` → `{ data: [{ changed, payout }] }`
  (new or topped-up batches; empty when nothing new).
- `GET /admin/payout-batches?status=&providerId=&period=&page=` and `GET /admin/payout-batches/:id`
  (with `items`).
- `POST …/:id/schedule` → PENDING → SCHEDULED; `409 PAYOUT_ACCOUNT_NOT_VERIFIED` without a verified
  default bank account, `409 PAYOUT_EMPTY` if no item is left. Amounts and items are then fixed.
- `POST …/:id/mark-paid {"bankReference":"NABIL-TRF-0007788"}` → PAID (items paid out, commission
  collected). Same reference again: `changed: false`; another: `409 PAYOUT_ALREADY_PAID`.
- `POST …/:id/mark-failed {"reason":"…"}` → FAILED; its items are released for the next batch.
- `POST /admin/providers/:id/payout-account/verify` → `{ changed, payoutAccountLabel, verifiedAt }`.
- Partners: `GET /partner/payout-batches[/:id]`, own provider only (another's is `404 PAYOUT_NOT_FOUND`).

```json
{ "data": { "id": "…", "provider": { "id": "…", "name": "…" }, "period": "2026-10",
  "periodStart": "2026-10-01", "periodEnd": "2026-10-31", "status": "PAID",
  "currency": "NPR", "currencyExponent": 2,
  "grossMinor": "360000", "commissionMinor": "54000", "netMinor": "306000", "itemCount": 1,
  "payoutAccountLabel": "Nabil Bank · ••••4321", "bankReferenceMasked": "••••7788",
  "scheduledAt": "…", "paidAt": "…", "failedAt": null, "failureReason": null, "createdAt": "…",
  "items": [ { "id": "…", "trip": { "id": "…", "reference": "MS-…" },
    "listing": { "id": "…", "title": "…", "listingType": "bus_ticket" },
    "startDate": "2026-10-10", "endDate": null, "quantity": 2, "currency": "NPR",
    "currencyExponent": 2, "totalMinor": "360000", "commissionMinor": "54000", "netMinor": "306000" } ] } }
```

The bank reference is stored but only ever returned (and audited) masked; the account only as its
masked label. The database keeps batches, their transitions and their sums (`payouts_*_chk`,
`booking_items_payout_*_chk` → `409 PAYOUT_STATE_CONFLICT`).

**Admin accounts** (gap 9).

- `GET /admin/admins` → `[{ id, email, fullName, status, setupPending, lastLoginAt, createdAt }]`
  (never a password hash).
- `POST /admin/admins {"email","fullName"}` → `201 { admin, setupLink: { setupPath, expiresAt } }`,
  `Cache-Control: no-store`. `setupPath` is `/admin-setup#token=…` (on the web origin); it works once
  for 24 hours and is shown only in this response. Email in use: `409 EMAIL_TAKEN`.
- `POST /admin/admins/:id/setup-link` (only while no password is set; else `409 ADMIN_ALREADY_SET_UP`).
- `POST /admin/admins/:id/suspend` (ends its sessions) and `…/reactivate`. Yourself:
  `409 ADMIN_SELF_LOCKOUT`; the last usable admin: `409 LAST_ADMIN` (also refused by the database).
- `POST /auth/admin-setup {"token","password"}` → `204` (no session; 10 per 15 minutes per client;
  password rules as for registration). Bad, used or expired link: `400 SETUP_LINK_INVALID`.

**Listing review** (gap 15).

- `GET /admin/listings?status=PENDING_REVIEW|APPROVED|REJECTED&q=&page=` → each with
  `typeRule: { allowed, reason, allowedListingTypes }` (a preview of the rule).
- `POST /admin/listings/:id/approve` → re-checks that the provider's type may list this type and
  both are active: otherwise `422 LISTING_TYPE_NOT_ALLOWED` / `LISTING_TYPE_NOT_OFFERED` with
  `details`, nothing changed. Not waiting for review: `409 LISTING_NOT_IN_REVIEW`.
- `POST /admin/listings/:id/reject {"reason"}` (1–1000 characters). Partners see the decision on
  their listing as `review: { reviewedAt, note }`.

**Voids and corrections** (gap 13).

- `POST /admin/booking-items/:id/void {"reason"}` and `POST /admin/trips/:id/void {"reason"}` →
  `{ data: { tripId, items: [{ itemId, changed, refundRequests, invoiceAdjusted }] } }`. The item
  becomes CANCELLED (held inventory released, commission WAIVED, out of an open payout batch);
  online money becomes refund REQUESTS (not executed); invoiced commission gets an invoice
  adjustment (the issued invoice never changes; fully adjusted → VOID). Refusals (409):
  `ITEM_NOT_VOIDABLE_STATUS` (in progress, completed, no-show), `ITEM_PAID_OUT`,
  `ITEM_IN_SCHEDULED_PAYOUT`.
- `POST /admin/booking-items/:id/settlement/reverse {"reason"}` → undoes a pay-at-property
  settlement (`PAID_AT_PROPERTY → PAY_AT_PROPERTY`); `409 ITEM_NOT_SETTLED` for other items.
  Amounts are never edited: a wrong amount is voided and rebooked.

Audit actions added: `payout.generate.create|add`, `payout.schedule`, `payout.mark_paid`,
`payout.mark_failed`, `provider.payout_account.verify`, `admin.create`, `admin.setup_link.reissue`,
`admin.setup.complete`, `admin.suspend`, `admin.reactivate`, `listing.approve`, `listing.reject`,
`booking_item.void`, `booking_item.settlement.reverse`.

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
