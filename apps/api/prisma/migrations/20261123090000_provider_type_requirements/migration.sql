-- Phase 7 (ADR 0009): closes operational gaps 18 and 19 with data, not code. Additive only.
--
-- Gap 19: provider types can be hidden from onboarding until their vertical is offered.
-- Gap 18: each provider type has a data-driven list of required verification documents, enforced
--         when a partner submits for verification and again before an admin approves.

-- ============================================================================
-- provider_types.is_active
-- ============================================================================

ALTER TABLE "provider_types" ADD COLUMN "is_active" BOOLEAN NOT NULL DEFAULT true;

-- Flights are modelled but not offered (listing_types.flight_ticket is inactive since Phase 2),
-- so the airline provider type is not offered at onboarding either. The row stays.
UPDATE "provider_types" SET "is_active" = false WHERE "code" = 'airline';

-- ============================================================================
-- provider_type_required_documents
-- ============================================================================

CREATE TABLE "provider_type_required_documents" (
    "provider_type_code" TEXT NOT NULL,
    "requirement" TEXT NOT NULL,
    "document_type" "provider_document_type" NOT NULL,

    CONSTRAINT "provider_type_required_documents_pkey"
      PRIMARY KEY ("provider_type_code", "requirement", "document_type")
);

ALTER TABLE "provider_type_required_documents"
  ADD CONSTRAINT "provider_type_required_documents_provider_type_code_fkey"
  FOREIGN KEY ("provider_type_code") REFERENCES "provider_types"("code")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "provider_type_required_documents"
  ADD CONSTRAINT "provider_type_required_documents_requirement_format_chk"
  CHECK ("requirement" ~ '^[a-z_]+$');

-- Seeded from requirements §6.2 ("Required" cells only; conditional items such as "if they have
-- one", "where applicable" and "on request" are left to the admin). Rows with the same
-- requirement form a group: any ONE listed document type satisfies it.
-- Hotels and homestays share the `hotel` provider type, so its registration requirement accepts
-- either a business registration or a local-government homestay registration.
-- Legal requirements are still to be confirmed with a Nepali legal/tax advisor (§6.2 note).
INSERT INTO "provider_type_required_documents" ("provider_type_code", "requirement", "document_type") VALUES
  ('hotel',             'identity',     'OWNER_ID'),
  ('hotel',             'registration', 'BUSINESS_REGISTRATION'),
  ('hotel',             'registration', 'LOCAL_GOVERNMENT_REGISTRATION'),
  ('bus_operator',      'identity',     'OWNER_ID'),
  ('bus_operator',      'registration', 'BUSINESS_REGISTRATION'),
  ('bus_operator',      'tax',          'PAN_CERTIFICATE'),
  ('bus_operator',      'licence',      'VEHICLE_ROUTE_PERMIT'),
  ('guide',             'identity',     'OWNER_ID'),
  ('guide',             'licence',      'GUIDE_LICENSE'),
  ('tour_operator',     'identity',     'OWNER_ID'),
  ('tour_operator',     'registration', 'BUSINESS_REGISTRATION'),
  ('tour_operator',     'tax',          'PAN_CERTIFICATE'),
  ('activity_operator', 'identity',     'OWNER_ID'),
  ('activity_operator', 'registration', 'BUSINESS_REGISTRATION'),
  ('activity_operator', 'tax',          'PAN_CERTIFICATE'),
  ('airline',           'identity',     'OWNER_ID');
