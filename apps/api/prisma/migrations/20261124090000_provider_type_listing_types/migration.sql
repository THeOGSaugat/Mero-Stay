-- Phase 8 (ADR 0013): closes operational gap 22 with data, not code. Additive only.
--
-- Which listing types each provider type may create. Same pattern as the required-document
-- groups (ADR 0009): a lookup table seeded here, read by the API; no type name in code.
--
-- The API enforces the mapping AND the active flags (provider_types.is_active,
-- listing_types.is_active) at listing create and update. The database guard below enforces the
-- mapping alone: a listing can never be written for a provider type → listing type pair that is
-- not mapped, whatever the code path. Active flags are policy switches and stay in the API, so
-- switching a type off never breaks existing rows.

CREATE TABLE "provider_type_listing_types" (
    "provider_type_code" TEXT NOT NULL,
    "listing_type_code" TEXT NOT NULL,

    CONSTRAINT "provider_type_listing_types_pkey"
      PRIMARY KEY ("provider_type_code", "listing_type_code")
);

ALTER TABLE "provider_type_listing_types"
  ADD CONSTRAINT "provider_type_listing_types_provider_type_code_fkey"
  FOREIGN KEY ("provider_type_code") REFERENCES "provider_types"("code")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "provider_type_listing_types"
  ADD CONSTRAINT "provider_type_listing_types_listing_type_code_fkey"
  FOREIGN KEY ("listing_type_code") REFERENCES "listing_types"("code")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "provider_type_listing_types_listing_type_code_idx"
  ON "provider_type_listing_types"("listing_type_code");

-- The owner's confirmed mapping (Phase 8 brief, 2026-11-24):
-- - homestays onboard as `hotel` (ADR 0009), so `hotel` covers them;
-- - `hotel` also creates its property (the non-bookable `hotel` container) that rooms belong to;
-- - `activity_operator` lists activities, like `tour_operator`.
-- An inactive provider type or listing type is still refused by the API even when mapped
-- (airline/flight_ticket today).
INSERT INTO "provider_type_listing_types" ("provider_type_code", "listing_type_code") VALUES
  ('hotel',             'hotel'),
  ('hotel',             'hotel_room'),
  ('bus_operator',      'bus_ticket'),
  ('airline',           'flight_ticket'),
  ('guide',             'guide_service'),
  ('tour_operator',     'tour'),
  ('tour_operator',     'activity'),
  ('activity_operator', 'activity');

-- ============================================================================
-- Guard: listings.listing_type_code must be mapped for the provider's type
-- ============================================================================
-- Raises check_violation with the constraint name in the message (the pg adapter drops the
-- CONSTRAINT field; lib/database-errors.ts reads the name from the message, as for ADR 0007's
-- guards) → 422 LISTING_TYPE_NOT_ALLOWED. Checked on INSERT and when the listing type or the
-- provider changes; other updates of existing rows are not affected.

CREATE FUNCTION "listings_listing_type_allowed"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "providers" p
    JOIN "provider_type_listing_types" m
      ON m."provider_type_code" = p."provider_type_code"
     AND m."listing_type_code" = NEW."listing_type_code"
    WHERE p."id" = NEW."provider_id"
  ) THEN
    RAISE EXCEPTION 'violates check constraint "listings_listing_type_allowed_chk": listing type % is not allowed for this provider type', NEW."listing_type_code"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'listings_listing_type_allowed_chk';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "listings_listing_type_allowed_trg"
  BEFORE INSERT OR UPDATE OF "listing_type_code", "provider_id" ON "listings"
  FOR EACH ROW EXECUTE FUNCTION "listings_listing_type_allowed"();
