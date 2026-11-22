-- Phase 6 (ADR 0008): partner/admin backend. Adds the audit log, idempotency keys, who/when of a
-- pay-at-property settlement, and one default payout account per provider. Additive only.

-- ============================================================================
-- booking_items: who recorded a pay-at-property settlement, and when
-- ============================================================================

ALTER TABLE "booking_items"
  ADD COLUMN "payment_settled_at" TIMESTAMPTZ(3),
  ADD COLUMN "payment_settled_by_id" UUID;

ALTER TABLE "booking_items" ADD CONSTRAINT "booking_items_payment_settled_by_id_fkey"
  FOREIGN KEY ("payment_settled_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A settled item always says who settled it and when; nothing else carries those fields.
ALTER TABLE "booking_items" ADD CONSTRAINT "booking_items_payment_settled_chk" CHECK (
  ("payment_status" = 'PAID_AT_PROPERTY')
  = ("payment_settled_at" IS NOT NULL AND "payment_settled_by_id" IS NOT NULL)
  AND ("payment_settled_at" IS NULL) = ("payment_settled_by_id" IS NULL));

-- ============================================================================
-- provider_payout_accounts: at most one default account per provider
-- ============================================================================

CREATE UNIQUE INDEX "provider_payout_accounts_one_default_per_provider"
  ON "provider_payout_accounts"("provider_id") WHERE (is_default);

-- ============================================================================
-- audit_log: append-only, no secrets
-- ============================================================================

CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "actor_user_id" UUID,
    "actor_role" "user_role",
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "ip" TEXT,
    "request_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "audit_log_created_at_idx" ON "audit_log"("created_at");
CREATE INDEX "audit_log_actor_user_id_created_at_idx" ON "audit_log"("actor_user_id", "created_at");
CREATE INDEX "audit_log_entity_type_entity_id_idx" ON "audit_log"("entity_type", "entity_id");
CREATE INDEX "audit_log_action_created_at_idx" ON "audit_log"("action", "created_at");

ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_fkey"
  FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "audit_log"
  ADD CONSTRAINT "audit_log_action_format_chk" CHECK ("action" ~ '^[a-z_]+(\.[a-z_]+)+$'),
  ADD CONSTRAINT "audit_log_entity_type_format_chk" CHECK ("entity_type" ~ '^[a-z_]+$'),
  ADD CONSTRAINT "audit_log_actor_chk" CHECK (("actor_user_id" IS NULL) = ("actor_role" IS NULL)),
  ADD CONSTRAINT "audit_log_payload_objects_chk" CHECK (
    ("before" IS NULL OR jsonb_typeof("before") = 'object')
    AND ("after" IS NULL OR jsonb_typeof("after") = 'object')),
  -- Second line of defence behind the code's redaction: no secret-looking key anywhere in the
  -- payloads (passwords, hashes, session/CSRF tokens, secrets, full bank account numbers).
  ADD CONSTRAINT "audit_log_no_secrets_chk" CHECK (
    (COALESCE("before"::text, '') || COALESCE("after"::text, ''))
      !~* '"(password|password_?hash|token|token_?hash|session_?token|csrf_?token|session_?secret|secret|account_?number)"\s*:');

-- Append-only: an audit row can never be changed or removed through SQL.
CREATE FUNCTION "audit_log_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'violates check constraint "audit_log_append_only_chk": audit rows are append-only'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'audit_log_append_only_chk';
END $$;

CREATE TRIGGER "audit_log_append_only_trg"
  BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION "audit_log_append_only"();

-- ============================================================================
-- idempotency_keys: a retried write returns the first result
-- ============================================================================

CREATE TABLE "idempotency_keys" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "request_fingerprint" CHAR(64) NOT NULL,
    "resource_id" TEXT NOT NULL,
    "response_status" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "idempotency_keys_user_id_key_key" ON "idempotency_keys"("user_id", "key");
CREATE INDEX "idempotency_keys_created_at_idx" ON "idempotency_keys"("created_at");

ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "idempotency_keys"
  ADD CONSTRAINT "idempotency_keys_key_format_chk" CHECK ("key" ~ '^[A-Za-z0-9_-]{8,128}$'),
  ADD CONSTRAINT "idempotency_keys_scope_format_chk" CHECK ("scope" ~ '^[a-z_]+(\.[a-z_]+)+$'),
  ADD CONSTRAINT "idempotency_keys_fingerprint_hex_chk" CHECK ("request_fingerprint" ~ '^[0-9a-f]{64}$'),
  -- Only successful results are remembered; a failed request can simply be retried.
  ADD CONSTRAINT "idempotency_keys_success_only_chk" CHECK ("response_status" BETWEEN 200 AND 299);
