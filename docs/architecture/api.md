# MeroStay API (v1)

Base path: `/api/v1`. JSON in, JSON out. Design decisions: [ADR 0005](decisions/0005-search-and-booking-api-conventions.md).
Data model: [data-model.md](data-model.md).

> **Temporary: no authentication.** Trip endpoints take a `userId` in the body and do not check
> ownership. They are **off by default in every environment** and only served when
> `ALLOW_UNAUTHENTICATED_TRIPS_API=true` (set it only on your own machine).
> See [How authentication will slot in](#how-authentication-will-slot-in).

## Conventions

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
| 403 | `TRIPS_API_DISABLED` | Trip API switched off (the default until authentication exists) |
| 404 | `NOT_FOUND`, `LISTING_NOT_FOUND`, `TRIP_NOT_FOUND`, `ITEM_NOT_FOUND` | The resource in the URL does not exist |
| 409 | `INSUFFICIENT_AVAILABILITY`, `NOT_AVAILABLE`, `TRIP_NOT_EDITABLE`, `TRIP_EXPIRED`, `TRIP_EMPTY`, `ITEM_NO_LONGER_BOOKABLE`, `CONFLICT` | Conflicts with current state or availability |
| 422 | `CURRENCY_MISMATCH`, `LISTING_NOT_BOOKABLE`, `UNKNOWN_LISTING`, `UNKNOWN_USER`, `UNKNOWN_LOCATION`, `UNKNOWN_LISTING_TYPE`, `INVALID_DATE_RANGE`, `DATE_IN_PAST`, `PRICING_INVARIANT_VIOLATED` | Well-formed, but breaks a business rule |
| 500 | `INTERNAL_ERROR` | Unexpected; details only in server logs |

Database constraint violations are mapped (overbooking → 409, money checks → 422). Raw
PostgreSQL text is never returned.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health`, `/api/health/ready` | Liveness / readiness (unchanged) |
| GET | `/api/v1/listing-types` | All verticals and whether they are active/bookable |
| GET | `/api/v1/listings` | Search bookable listings |
| GET | `/api/v1/listings/:id` | Listing details + availability calendar |
| POST | `/api/v1/trips` | Create a draft trip |
| GET | `/api/v1/trips/:id` | Trip with items, money and statuses |
| POST | `/api/v1/trips/:id/items` | Add a booking item (holds inventory) |
| PATCH | `/api/v1/trips/:id/items/:itemId` | Change dates/quantity/payment method |
| DELETE | `/api/v1/trips/:id/items/:itemId` | Remove an item (releases inventory) |
| POST | `/api/v1/trips/:id/quote` | Dry-run pricing, optionally with candidate items |
| POST | `/api/v1/trips/:id/confirm` | Submit the trip (no payment taken) |

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
{ "userId": "uuid (TEMPORARY)", "currency": "NPR", "contact": { "name": "…", "phone": "…", "email": "…" } }
```

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

### GET /api/v1/trips/:id → 200

```json
{ "data": {
  "id": "…", "reference": "MS-7K3F9QXR", "status": "DRAFT", "userId": "…",
  "currency": "NPR", "currencyExponent": 2,
  "totals": {
    "subtotalMinor": "2030000", "serviceChargeMinor": "77000", "taxMinor": "110110",
    "totalMinor": "2217110", "commissionTotalMinor": "304500",
    "payOnlineMinor": "1260000", "payAtPropertyMinor": "957110",
    "commissionFromPayoutsMinor": "189000", "commissionInvoicedMinor": "115500",
    "providerPayoutsMinor": "1071000"
  },
  "items": [{
    "id": "…", "status": "PENDING",
    "listing": { "id": "…", "title": "…", "listingType": "hotel_room", "provider": { "id": "…", "name": "…" } },
    "startDate": "2027-01-10", "endDate": "2027-01-12", "travellerCount": 1, "quantity": 2,
    "paymentMethod": "pay_at_property", "paymentStatus": "PAY_AT_PROPERTY",
    "commissionStatus": "PENDING", "payoutStatus": "NOT_APPLICABLE",
    "currency": "NPR", "currencyExponent": 2,
    "lines": [
      { "date": "2027-01-10", "units": 1, "unitPriceMinor": "350000", "amountMinor": "350000" },
      { "date": "2027-01-11", "units": 1, "unitPriceMinor": "420000", "amountMinor": "420000" }
    ],
    "money": { "subtotalMinor": "770000", "serviceChargeRateBps": 1000, "serviceChargeMinor": "77000",
               "taxRateBps": 1300, "taxMinor": "110110", "totalMinor": "957110",
               "commissionRateBps": 1500, "commissionMinor": "115500",
               "providerPayoutMinor": "841610", "refundedMinor": "0" },
    "cancellationPolicy": { "policyId": "…", "name": "Moderate", "rules": [ … ], "capturedAt": "…" },
    "attributes": {}
  }],
  "expiresAt": "…", "confirmedAt": null
} }
```

Totals: the first five are the stored trip aggregates (sum of active items). The split by
payment method is derived from the items: `payOnlineMinor + payAtPropertyMinor = totalMinor`.

### POST /api/v1/trips/:id/quote → 200 (dry run, nothing is written)

Body (optional): `{ "items": [ <same shape as add-item>, … ] }` = candidate items to price
alongside the trip's own items. Response: one line per item (`itemId` for existing items,
`candidateIndex` for candidates) with `money` (current prices), `heldMoney` (the price held on the
item), `priceChanged`, `available` and `unavailableDates`, plus `totals` in the same shape as the
trip. Mixed currencies → 422 `CURRENCY_MISMATCH`.

### POST /api/v1/trips/:id/confirm → 200

No payment is taken (the gateway is a later phase).

| Item paid… | Item status | Commission status | Notes |
|---|---|---|---|
| at the property | `CONFIRMED` | `INVOICED` | Provider owes the commission |
| online | stays `PENDING` | `PENDING` | Awaits payment; commission later deducted from the payout |

Trip → `CONFIRMED` when every item is confirmed; otherwise `PENDING` (awaiting payment) with a new
`expiresAt`. Money is not re-priced. A confirmed/pending trip can't be edited (409).

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
| Payment gateway | New endpoints under `/trips/:id/payments`; online items move `UNPAID → PAID`, items `PENDING → CONFIRMED`; existing endpoints unchanged |
| Refunds / cancellation | New `/trips/:id/items/:itemId/cancel`, using the frozen `cancellationPolicy` snapshot |
| Payouts / invoices | Finance endpoints reading `commissionStatus` / `payoutStatus` |
| Multi-currency trips | `currency` is already on every money-bearing object |

## How authentication will slot in

1. Auth middleware puts the user on the request; the trip router's temporary guard is replaced by
   it.
2. `POST /trips` takes the owner from the session; a `userId` in the body is ignored for one release,
   then rejected.
3. Every trip endpoint checks `trip.customerId === session user` (admins excepted) → 404 otherwise.
4. Commission and payout fields are visible only to admins and the owning partner.
5. Paths, request bodies (minus `userId`) and response shapes stay the same, so clients keep working.
