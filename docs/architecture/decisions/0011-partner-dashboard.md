# 0011. Partner dashboard (web)

- **Status:** Accepted
- **Date:** 2026-11-22
- **Phase:** 07 (Track B)

## Context

Track B adds the partner dashboard to `apps/web` on top of the Phase 6 partner API (ADR 0008) and
the Track A frontend conventions (ADR 0010). The API already scopes every `/partner…` request to
one provider the user owns and answers 404 for anyone else's data. It masks bank numbers and
customer contact details, and needs an `Idempotency-Key` to settle a pay-at-property booking.

Three gaps showed up while building the dashboard:

- **Locations:** bus listings need origin and destination location ids, but the API had no
  locations endpoint (gap 20).
- **Who settled:** the API recorded who settled a booking but didn't return it, and the owner
  asked to show "who/when".
- **File upload:** verification documents can't be uploaded yet (gap 14).

## Decisions

### 1. The dashboard is client-rendered behind a login and role gate

`app/partner/(dashboard)/layout.tsx` wraps every partner page in `RequireAuth` →
`PartnerGate` → `PartnerProvider`.

- **The gate is navigation only.** It decides what to show from `partnerAccess(authState)`: log
  in, become a partner (customers), "not for admins", or the dashboard.
- **The API is the real check:** 403 for the wrong role, before any data is read.
- `/partner/onboarding` sits outside the group, because customers use it to become partners.
- Partner pages are private and per-user, so they are Client Components. There is nothing to
  render on the server for SEO.

### 2. Scoping: one provider per request, chosen in memory

`PartnerProvider` sends every call to `/api/v1/partner…`.

- **Several businesses:** when the user owns more than one, the API answers
  `400 PROVIDER_ID_REQUIRED` with their ids. The UI fetches each profile, asks which business to
  manage, then sends `X-Provider-Id` on every request.
- **Not remembered:** the choice lives in React state only, like the CSRF token, so it is asked
  again after a reload.
- **No filtering in the UI:** the UI never filters or hides other providers' data. A 404 from
  the API, for a listing or booking that is missing *or* belongs to someone else, is shown as the
  same "Not found" (`partnerErrorView`). It is never shown as "access denied", so the UI doesn't
  leak whether something exists.

### 3. Masking stays the API's, with a guard in the UI

- **Bank numbers:** the UI shows `accountNumberMasked` exactly as the API sends it.
  `safeMaskedAccountNumber` also refuses anything that isn't a mask plus at most four characters,
  so a server regression can't put a full number on screen.
- **New account numbers:** the input is cleared as soon as the number is sent, and the number is
  never shown again.
- **Customers:** shown by the name and masked contact details the API returns.

### 4. Settle at the property: one key per attempt

`lib/settle-state.ts` is a small reducer:

- the first click creates one `Idempotency-Key`;
- the key is kept until the API confirms success, so "Try again" after a lost response or network
  error re-sends the **same** key, and the API applies it once (`replayed: true`);
- clicks while a request is in flight do nothing;
- success is shown once. After it, the action disappears, and the page shows the recorded
  *who/when* from the API (`settledAt`, `settledBy`).

### 5. Listing forms: types from data, detail fields mirror the detail tables

- **Listing types:** the kinds of listing come from `GET /listing-types` (active types only), so
  flights are absent without code.
- **Detail fields:** the type-specific fields are descriptors in `lib/listing-forms.ts`, one entry
  per API detail table (`hotel`, `hotel_room`, `bus_ticket`, `guide_service`, `tour`). A type
  without a detail table (e.g. `activity`) gets the common fields only.
- **Adding a vertical** stays additive (ADR 0004): a listing-type row, and optionally a detail
  table plus one descriptor entry.
- **Validation:** the API still validates everything.
- **Money and rates:** prices typed in rupees become minor-unit strings, and percentages become
  basis points, with string operations only.

### 6. Two small, owner-approved API additions

| Addition | Why | Notes |
|---|---|---|
| `GET /api/v1/locations[?parentId=]` | Bus routes and listing places need location ids; the picker walks Province → District → City/Area one level at a time | Public, read-only, names only. First half of gap 20; the customer search picker stays in Phase 10 |
| `settledBy: { role, name }` on partner bookings | Show who recorded a settlement | No migration. A settlement by MeroStay staff shows as "MeroStay" (staff names are not shared with partners) |

### 7. Verification documents without upload

- **What is recorded:** the browser reads the chosen file's type and size, checks them against
  the API's allow-list (PDF, JPEG, PNG, WebP; ≤ 10 MB), and records the metadata.
- **The file never leaves the device.** The storage key is an honest placeholder,
  `not-uploaded/<uuid>`, so nobody mistakes it for a stored file.
- **The page says so.** Upload and private storage remain gap 14 (Phase 9).
- **Required documents:** the checklist shows the type's required groups (ADR 0009) and which are
  satisfied. A pending or approved document counts; a rejected one never does. The API enforces
  the same rule.

## Alternatives considered

- **Listing detail field metadata from the API:** this would remove the mirrored descriptors, but
  it means a new backend contract. The descriptors are small and additive. Revisit if verticals
  multiply.
- **Remember the chosen business in `localStorage`:** a provider id isn't a secret, but Track A
  keeps all auth-related state in memory. Asking again after a reload is acceptable for the few
  partners with several businesses.
- **A new idempotency key per click:** still safe on the server (an already settled booking is
  returned unchanged), but the UI couldn't tell "my retry went through" from a different settle.
  One key per attempt is simpler to explain, and it is tested.

## Consequences

- **E2E:** the partner journey uses the simulated gateway (`PAYMENT_GATEWAY=simulated`, booking
  mode only), so an online-paid booking reaches the payout summary.
- **New operational gaps:**
  - 22: listing types aren't restricted by provider type;
  - 23: no cancellation-policy management, so new listings have no policy;
  - 24: the business choice isn't remembered after a reload.
- **Gap 5** (per-IP rate limits behind the proxy) is recorded as a launch blocker.
