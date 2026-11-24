# 0013. Provider-type → listing-type rules

- **Status:** Accepted
- **Date:** 2026-11-24
- **Phase:** 08 (closes operational gap 22)

## Context

Until Phase 8, any partner could create any active listing type: a bus operator could list a
hotel room (gap 22, a launch blocker). Admin approval of listings (gap 15, not built yet) was the
only safeguard.

The rule must be **data, not code**: no provider-type or listing-type name in application logic.
That is the same approach as the required-document groups (ADR 0009) and the vertical model
(ADR 0004).

The owner confirmed the mapping on 2026-11-24 and resolved three points:

- **Homestays** onboard as the `hotel` provider type (ADR 0009), so `hotel` covers them.
- **Hotel providers** also create their property (the non-bookable `hotel` listing type) that
  rooms belong to.
- **`activity_operator`** lists activities.

## Decision

### 1. A mapping table, seeded by migration

Migration `20261124090000_provider_type_listing_types` (additive) creates
`provider_type_listing_types (provider_type_code, listing_type_code)`:

- the primary key is both columns;
- foreign keys point to `provider_types` and `listing_types`;
- the table is seeded with the mapping below.

| Provider type | May list |
|---|---|
| `hotel` (hotels, guesthouses, **homestays**, resorts, teahouses, lodges) | `hotel` (property), `hotel_room` |
| `bus_operator` | `bus_ticket` |
| `airline` | `flight_ticket` |
| `guide` | `guide_service` |
| `tour_operator` | `tour`, `activity` |
| `activity_operator` | `activity` |

### 2. Usable = mapped AND both types active

A pair is usable only when it is mapped, the provider type is active (`provider_types.is_active`,
gap 19), and the listing type is active (`listing_types.is_active`). The rule is the pure function
`decideListingType` in `src/domain/listing-rules.ts`.

Today `airline` and `flight_ticket` are both inactive, so airlines may list nothing even though the
pair is mapped. Turning both flags on is all it takes to offer flights; no code changes.

### 3. Enforcement points

| Where | What |
|---|---|
| `POST /partner/listings` | Unknown or inactive listing type → `422 LISTING_TYPE_NOT_OFFERED` (unchanged). Mapped but the provider type is inactive, or not mapped → **`422 LISTING_TYPE_NOT_ALLOWED`**, `details: { listingTypeCode, providerTypeCode, reason, allowedListingTypes }`. Checked before anything is written |
| `PATCH /partner/listings/:id` | The listing's own type must still be usable (same errors), checked under the row lock. **Archiving is always allowed**, so a listing that no longer fits can be taken down. The type itself cannot be changed: `listingTypeCode` is not an update field (400) |
| Database | Trigger `listings_listing_type_allowed_chk` (on `INSERT`, and on `UPDATE OF listing_type_code, provider_id`) refuses any pair that is not mapped, whatever the code path. It is mapped centrally to `422 LISTING_TYPE_NOT_ALLOWED` |

- **Why 422 and not 409:** the request is well-formed but breaks a business rule about who may
  list what. It doesn't conflict with the resource's current state. The neighbouring rules
  (`LISTING_TYPE_NOT_OFFERED`, `PROVIDER_TYPE_NOT_OFFERED`) are 422 as well.
- **Why the database checks the mapping but not the active flags:** the flags are policy switches.
  Switching a type off must not make existing rows invalid, or block admin or system updates. The
  mapping is a structural rule and belongs in the database.

### 4. Visibility

| Endpoint | Who | What |
|---|---|---|
| `GET /provider-types` | Public | `allowedListingTypes` per offered type (usable now) |
| `GET /partner/profile` | Partner | `providerType.allowedListingTypes` (usable now); the partner listing form offers exactly these |
| `GET /admin/provider-types` | Admin, read-only | Every type, offered or not, with `isActive`, required documents, the full mapping with each listing type's flag, and `usableListingTypes`. Shown at `/admin/listing-rules` |

Editing the mapping through the console is a later phase; today it changes by migration.

### 5. No type names in code, enforced by a test

`src/domain/listing-rules.test.ts` reads the provider and listing type codes from the migrations
and scans the API and web sources:

- **provider-type codes** appear nowhere;
- **listing-type codes** appear only in the two detail-descriptor files that ADR 0004 sanctions
  (`listing-details.ts` and `listing-forms.ts`: which fields a type's detail table has).

A mutation check confirmed the scan fails when a code is added to a service.

## Adding a provider or listing type later (data only)

1. **Migration:** insert the `listing_types` row (and a detail table if search needs typed fields,
   ADR 0004) and/or the `provider_types` row with its `provider_type_required_documents` groups
   (ADR 0009).
2. **Mapping:** insert the `provider_type_listing_types` rows.
3. **Offer it:** set `is_active` on both types when the vertical is offered.

No code changes are needed: onboarding, the partner form and the admin rules page read the data.

## Consequences

- **Existing listings:** the trigger only checks new writes, so existing rows are not re-validated.
  At this phase the dev database had no listings, and the seed and test fixtures comply.
- **`page.totalPages`:** list responses gained this field in the same phase (gap 25). This is an
  additive change.
- **Errors:** api.md lists `LISTING_TYPE_NOT_ALLOWED` under 422.
