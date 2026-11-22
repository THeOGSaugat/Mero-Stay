# 0009. Provider-type requirements and visibility as data

- **Status:** Accepted
- **Date:** 2026-11-23
- **Phase:** 07

## Context

Two owner decisions after the Phase 6 review (operational gaps 18 and 19):

- **A.** Verification needs a required-documents checklist per provider type, so an incomplete
  partner can't be approved.
- **B.** The `airline` provider type should not be offered at onboarding while flights are not
  built. The type stays in the schema.

Both had to be data-driven: no hard-coded provider-type names in code (ADR 0004).

## Decision

### Visibility: `provider_types.is_active`

- A new boolean defaults to `true`. Migration `20261123090000_provider_type_requirements` sets it to
  `false` for `airline`, because flights' listing type has been inactive since Phase 2.
- Onboarding refuses an inactive type with `422 PROVIDER_TYPE_NOT_OFFERED`.
- The new public `GET /api/v1/provider-types` lists only active types.
- Existing providers of an inactive type are unaffected.
- Enabling flights later means flipping two flags (`listing_types.flight_ticket` and
  `provider_types.airline`), with no code change.

### Checklist: `provider_type_required_documents`

- Rows hold (provider type, requirement group, document type). Rows that share a group mean "any
  one of these". This is how one `hotel` type serves both hotels (business registration) and
  homestays (local-government registration).
- **Seeded from requirements §6.2**, "Required" cells only:

| Provider type | Groups |
|---|---|
| all types | `identity`: OWNER_ID |
| hotel | `registration`: BUSINESS_REGISTRATION or LOCAL_GOVERNMENT_REGISTRATION |
| bus_operator | `registration`, `tax` (PAN_CERTIFICATE), `licence` (VEHICLE_ROUTE_PERMIT) |
| guide | `licence`: GUIDE_LICENSE |
| tour_operator, activity_operator | `registration`, `tax` |

- Conditional items are **not** enforced and stay the admin's judgement. These are the cells marked
  "if they have one", "where applicable", "on request", and bank details (only needed for online
  payouts).
- The legal list still needs confirming with a Nepali advisor. Changing it is a data change made
  by migration.
- **Rule** (`src/domain/verification.ts`): a group is satisfied by a PENDING or APPROVED document of
  any of its types. REJECTED documents never count.
- **Enforced twice**, with the same function:
  - at `POST /partner/verification/submit`;
  - again before an admin `approve`, inside the decision transaction.

  Either failure is `409 REQUIRED_DOCUMENTS_MISSING` with `details.missing` listing each missing
  group and the document types that would satisfy it. Rejecting is always allowed.
- `GET /api/v1/provider-types` returns each type's groups, so the onboarding UI can show the
  checklist up front.

## Alternatives considered

- **A hard-coded `providerTypeCode !== "airline"` check:** rejected, because it breaks the
  vertical-agnostic design and needs a code change to undo.
- **Deriving visibility from listing types:** no mapping from provider type to listing type exists,
  and adding one only for this would be more schema than a flag.
- **One flat list of required types:** it can't express "business OR local-government
  registration".

## Consequences

- One additive migration (a new column, a new table, seed rows). No applied migration was edited.
- Gaps 18 and 19 are closed, with integration tests, unit tests and mutation checks.
