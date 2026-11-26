-- =====================================================================================
-- Gap 23 (ADR 0015): cancellation policies that partners author themselves.
--
-- A policy is a name, a description and a structured rule: ordered refund tiers
-- [{ "minHoursBeforeStart": 72, "refundBps": 10000 }, ...], or `non_refundable` with no tiers.
-- Resolution for a booking item: the listing's policy, else the provider's default, else none.
-- The resolved policy is frozen onto the booking item (Phase 5 snapshot); refunds are a later
-- phase, so nothing here computes money.
-- =====================================================================================

ALTER TABLE "cancellation_policies"
  ADD COLUMN "is_active" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "non_refundable" BOOLEAN NOT NULL DEFAULT false;

-- The rule's shape, re-checked in SQL (the API validates the same shape first):
-- non-refundable ⇔ no tiers; otherwise 1–10 tiers, each exactly { minHoursBeforeStart 0–8760,
-- refundBps 1–10000 } as whole numbers, hours strictly decreasing, refund never increasing.
CREATE FUNCTION cancellation_rules_valid(rules jsonb, non_refundable boolean)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  tier jsonb;
  hours integer;
  refund integer;
  prev_hours integer := NULL;
  prev_refund integer := NULL;
BEGIN
  IF rules IS NULL OR jsonb_typeof(rules) <> 'array' THEN
    RETURN false;
  END IF;
  IF non_refundable THEN
    RETURN jsonb_array_length(rules) = 0;
  END IF;
  IF jsonb_array_length(rules) < 1 OR jsonb_array_length(rules) > 10 THEN
    RETURN false;
  END IF;
  FOR tier IN SELECT value FROM jsonb_array_elements(rules) LOOP
    IF jsonb_typeof(tier) <> 'object'
       OR (SELECT count(*) FROM jsonb_object_keys(tier)) <> 2
       OR jsonb_typeof(tier -> 'minHoursBeforeStart') IS DISTINCT FROM 'number'
       OR jsonb_typeof(tier -> 'refundBps') IS DISTINCT FROM 'number'
       OR (tier ->> 'minHoursBeforeStart') !~ '^[0-9]{1,5}$'
       OR (tier ->> 'refundBps') !~ '^[0-9]{1,5}$' THEN
      RETURN false;
    END IF;
    hours := (tier ->> 'minHoursBeforeStart')::integer;
    refund := (tier ->> 'refundBps')::integer;
    IF hours > 8760 OR refund < 1 OR refund > 10000 THEN
      RETURN false;
    END IF;
    IF prev_hours IS NOT NULL AND (hours >= prev_hours OR refund > prev_refund) THEN
      RETURN false;
    END IF;
    prev_hours := hours;
    prev_refund := refund;
  END LOOP;
  RETURN true;
END;
$$;

ALTER TABLE "cancellation_policies"
  ADD CONSTRAINT "cancellation_policies_rules_valid_chk"
    CHECK (cancellation_rules_valid("rules", "non_refundable")),
  ADD CONSTRAINT "cancellation_policies_name_chk"
    CHECK (length(btrim("name")) BETWEEN 1 AND 120);

-- The provider's default policy (used when a listing has none of its own).
ALTER TABLE "providers" ADD COLUMN "default_cancellation_policy_id" UUID;
CREATE INDEX "providers_default_cancellation_policy_id_idx"
  ON "providers"("default_cancellation_policy_id");
ALTER TABLE "providers"
  ADD CONSTRAINT "providers_default_cancellation_policy_id_fkey"
  FOREIGN KEY ("default_cancellation_policy_id") REFERENCES "cancellation_policies"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Attaching (provider default or listing policy): the policy must be ACTIVE and belong to that
-- provider (or be a platform template, provider_id NULL). FOR SHARE on the policy row serialises
-- this with a concurrent deactivation (which takes a row lock), so neither can slip past the other.
CREATE FUNCTION cancellation_policy_assert_attachable(policy_id uuid, owner_provider_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  ok boolean;
BEGIN
  SELECT cp.is_active AND (cp.provider_id IS NULL OR cp.provider_id = owner_provider_id)
    INTO ok
    FROM cancellation_policies cp
   WHERE cp.id = policy_id
     FOR SHARE;
  IF ok IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'violates check constraint "cancellation_policies_attach_chk": the policy must be active and belong to the provider'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'cancellation_policies_attach_chk';
  END IF;
END;
$$;

CREATE FUNCTION providers_cancellation_policy_attach()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.default_cancellation_policy_id IS NOT NULL THEN
    PERFORM cancellation_policy_assert_attachable(NEW.default_cancellation_policy_id, NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "providers_cancellation_policy_attach_trg"
  BEFORE INSERT OR UPDATE OF "default_cancellation_policy_id" ON "providers"
  FOR EACH ROW EXECUTE FUNCTION providers_cancellation_policy_attach();

CREATE FUNCTION listings_cancellation_policy_attach()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.default_cancellation_policy_id IS NOT NULL THEN
    PERFORM cancellation_policy_assert_attachable(NEW.default_cancellation_policy_id, NEW.provider_id);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "listings_cancellation_policy_attach_trg"
  BEFORE INSERT OR UPDATE OF "default_cancellation_policy_id", "provider_id" ON "listings"
  FOR EACH ROW EXECUTE FUNCTION listings_cancellation_policy_attach();

-- A policy never moves to another provider, and is not deactivated while attached anywhere
-- (the partner detaches it first, so resolution never meets an inactive policy).
CREATE FUNCTION cancellation_policies_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.provider_id IS DISTINCT FROM OLD.provider_id THEN
    RAISE EXCEPTION 'violates check constraint "cancellation_policies_owner_fixed_chk": a policy cannot move to another provider'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'cancellation_policies_owner_fixed_chk';
  END IF;
  IF OLD.is_active AND NOT NEW.is_active AND (
       EXISTS (SELECT 1 FROM providers WHERE default_cancellation_policy_id = NEW.id)
    OR EXISTS (SELECT 1 FROM listings WHERE default_cancellation_policy_id = NEW.id)
  ) THEN
    RAISE EXCEPTION 'violates check constraint "cancellation_policies_in_use_chk": detach the policy before deactivating it'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'cancellation_policies_in_use_chk';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "cancellation_policies_guard_trg"
  BEFORE UPDATE ON "cancellation_policies"
  FOR EACH ROW EXECUTE FUNCTION cancellation_policies_guard();

-- =====================================================================================
-- Gap 14 (ADR 0016): verification documents are real, private files.
--
-- The object lives in private storage under a server-generated `storage_key`; the row keeps only
-- metadata. A deleted document is a tombstone (`deleted_at`): its object is removed and it is
-- never shown, counted or served again. Audit rows hold metadata only.
-- =====================================================================================

ALTER TABLE "provider_documents"
  ADD COLUMN "file_name" TEXT,
  ADD COLUMN "sha256" TEXT,
  ADD COLUMN "uploaded_at" TIMESTAMPTZ(3),
  ADD COLUMN "deleted_at" TIMESTAMPTZ(3),
  ALTER COLUMN "status" SET DEFAULT 'AWAITING_UPLOAD';

ALTER TABLE "provider_documents"
  -- No file before the upload; a file (time + content hash) from UPLOADED on, for ever.
  ADD CONSTRAINT "provider_documents_file_chk" CHECK (
    ("status" = 'AWAITING_UPLOAD' AND "uploaded_at" IS NULL AND "sha256" IS NULL)
    OR ("status" <> 'AWAITING_UPLOAD' AND "uploaded_at" IS NOT NULL AND "sha256" ~ '^[0-9a-f]{64}$')
  ),
  -- An approved document is the evidence of a verification: it cannot be deleted.
  ADD CONSTRAINT "provider_documents_deleted_chk" CHECK ("deleted_at" IS NULL OR "status" <> 'APPROVED'),
  ADD CONSTRAINT "provider_documents_file_name_chk"
    CHECK ("file_name" IS NULL OR length("file_name") BETWEEN 1 AND 200),
  -- security-guidelines §6: PDF, JPEG and PNG only, at most 10 MB.
  ADD CONSTRAINT "provider_documents_mime_type_chk"
    CHECK ("mime_type" IN ('application/pdf', 'image/jpeg', 'image/png')),
  ADD CONSTRAINT "provider_documents_size_max_chk" CHECK ("size_bytes" <= 10485760);

-- Status moves and immutability, whatever the code path:
--   AWAITING_UPLOAD → UPLOADED → PENDING → APPROVED | REJECTED; a tombstone never changes; the
--   storage key, provider and (once uploaded) the file's hash, size and type never change.
CREATE FUNCTION provider_documents_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'violates check constraint "provider_documents_tombstone_chk": a deleted document cannot change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'provider_documents_tombstone_chk';
  END IF;
  IF NEW.storage_key IS DISTINCT FROM OLD.storage_key OR NEW.provider_id IS DISTINCT FROM OLD.provider_id THEN
    RAISE EXCEPTION 'violates check constraint "provider_documents_identity_chk": the storage key and provider are fixed'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'provider_documents_identity_chk';
  END IF;
  IF OLD.sha256 IS NOT NULL AND (
       NEW.sha256 IS DISTINCT FROM OLD.sha256
    OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes
    OR NEW.mime_type IS DISTINCT FROM OLD.mime_type
  ) THEN
    RAISE EXCEPTION 'violates check constraint "provider_documents_file_fixed_chk": an uploaded file cannot be replaced'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'provider_documents_file_fixed_chk';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'AWAITING_UPLOAD' AND NEW.status = 'UPLOADED')
    OR (OLD.status = 'UPLOADED' AND NEW.status = 'PENDING')
    OR (OLD.status = 'PENDING' AND NEW.status IN ('APPROVED', 'REJECTED'))
  ) THEN
    RAISE EXCEPTION 'violates check constraint "provider_documents_transition_chk": % → % is not allowed', OLD.status, NEW.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'provider_documents_transition_chk';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "provider_documents_guard_trg"
  BEFORE UPDATE ON "provider_documents"
  FOR EACH ROW EXECUTE FUNCTION provider_documents_guard();
