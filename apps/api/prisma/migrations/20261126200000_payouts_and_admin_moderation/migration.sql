-- Phase 12 (ADR 0018): payout batches (gap 16), admin accounts (gap 9), listing review (gap 15),
-- booking voids, settlement corrections and invoice adjustments (gap 13), gateway re-checks of
-- closed payments (gap 33). New migration only; no applied migration is changed.

-- ============================================================================
-- 1. Payout batches: one transfer per provider, month (of the service date) and currency.
--    Manual bank transfer, recorded: PENDING → SCHEDULED → PAID | FAILED.
-- ============================================================================

-- The Phase 2 shape had PROCESSING; nothing ever used it. "Scheduled" is what the admin does.
ALTER TYPE "payout_batch_status" RENAME VALUE 'PROCESSING' TO 'SCHEDULED';

ALTER TABLE "payouts"
  ADD COLUMN "gross_minor" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "commission_minor" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "item_count" INTEGER NOT NULL DEFAULT 0,
  -- Masked snapshot of the bank account at scheduling ("Nabil Bank · ••••4321"); never the number.
  ADD COLUMN "payout_account_label" TEXT,
  ADD COLUMN "created_by_id" UUID,
  ADD COLUMN "scheduled_at" TIMESTAMPTZ(3),
  ADD COLUMN "scheduled_by_id" UUID,
  ADD COLUMN "paid_by_id" UUID,
  ADD COLUMN "failed_at" TIMESTAMPTZ(3),
  ADD COLUMN "failure_reason" TEXT,
  ADD COLUMN "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "payouts"
  ADD CONSTRAINT "payouts_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "payouts_scheduled_by_id_fkey" FOREIGN KEY ("scheduled_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "payouts_paid_by_id_fkey" FOREIGN KEY ("paid_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "payouts"
  -- net payout = gross (item totals) − commission (ADR 0008: provider payout = total − commission)
  ADD CONSTRAINT "payouts_net_chk" CHECK (
    "gross_minor" >= 0 AND "commission_minor" >= 0 AND "item_count" >= 0
    AND "amount_minor" = "gross_minor" - "commission_minor"),
  -- A period is one calendar month: first to last day.
  ADD CONSTRAINT "payouts_period_month_chk" CHECK (
    "period_start" = date_trunc('month', "period_start")::date
    AND "period_end" = (date_trunc('month', "period_start") + INTERVAL '1 month - 1 day')::date),
  ADD CONSTRAINT "payouts_scheduled_fields_chk" CHECK (
    ("status" = 'PENDING') = ("scheduled_at" IS NULL)
    AND ("scheduled_at" IS NULL) = ("scheduled_by_id" IS NULL)),
  ADD CONSTRAINT "payouts_paid_fields_chk" CHECK (
    ("status" = 'PAID') = ("paid_at" IS NOT NULL)
    AND ("paid_at" IS NULL) = ("paid_by_id" IS NULL)
    AND ("status" <> 'PAID' OR "reference" IS NOT NULL)),
  ADD CONSTRAINT "payouts_failed_fields_chk" CHECK (
    ("status" = 'FAILED') = ("failed_at" IS NOT NULL)
    AND ("failed_at" IS NULL) = ("failure_reason" IS NULL)
    AND ("failure_reason" IS NULL OR length(btrim("failure_reason")) BETWEEN 1 AND 500)),
  ADD CONSTRAINT "payouts_reference_chk" CHECK (
    "reference" IS NULL OR length(btrim("reference")) BETWEEN 3 AND 100);

-- One open (PENDING) batch per provider, month and currency: generating again adds to it.
CREATE UNIQUE INDEX "payouts_one_pending_per_provider_period"
  ON "payouts"("provider_id", "period_start", "currency") WHERE "status" = 'PENDING';
CREATE INDEX "payouts_status_idx" ON "payouts"("status");

-- Batches are kept; status moves forward only; a scheduled batch's money and items are fixed and
-- must equal its items when it is scheduled.
CREATE FUNCTION "payouts_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  sums RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'violates check constraint "payouts_kept_chk": payout records are kept'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'payouts_kept_chk';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'PENDING' THEN
      RAISE EXCEPTION 'violates check constraint "payouts_status_transition_chk": a payout is created PENDING'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'payouts_status_transition_chk';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
       (OLD."status" = 'PENDING' AND NEW."status" = 'SCHEDULED')
    OR (OLD."status" = 'SCHEDULED' AND NEW."status" IN ('PAID', 'FAILED'))) THEN
    RAISE EXCEPTION 'violates check constraint "payouts_status_transition_chk": invalid payout status change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'payouts_status_transition_chk';
  END IF;

  IF OLD."status" <> 'PENDING' AND (
       NEW."amount_minor" IS DISTINCT FROM OLD."amount_minor"
    OR NEW."gross_minor" IS DISTINCT FROM OLD."gross_minor"
    OR NEW."commission_minor" IS DISTINCT FROM OLD."commission_minor"
    OR NEW."item_count" IS DISTINCT FROM OLD."item_count"
    OR NEW."provider_id" IS DISTINCT FROM OLD."provider_id"
    OR NEW."currency" IS DISTINCT FROM OLD."currency"
    OR NEW."period_start" IS DISTINCT FROM OLD."period_start"
    OR NEW."payout_account_label" IS DISTINCT FROM OLD."payout_account_label"
    OR NEW."scheduled_at" IS DISTINCT FROM OLD."scheduled_at"
    OR (OLD."status" IN ('PAID', 'FAILED') AND (
         NEW."reference" IS DISTINCT FROM OLD."reference"
      OR NEW."paid_at" IS DISTINCT FROM OLD."paid_at"
      OR NEW."failure_reason" IS DISTINCT FROM OLD."failure_reason"))) THEN
    RAISE EXCEPTION 'violates check constraint "payouts_scheduled_immutable_chk": a scheduled payout cannot change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'payouts_scheduled_immutable_chk';
  END IF;

  IF OLD."status" = 'PENDING' AND NEW."status" = 'SCHEDULED' THEN
    SELECT COALESCE(SUM("total_minor"), 0) AS gross, COALESCE(SUM("commission_minor"), 0) AS commission,
           COUNT(*) AS items
      INTO sums FROM "booking_items" WHERE "payout_id" = NEW."id";
    IF sums.items = 0 OR sums.items <> NEW."item_count"
       OR sums.gross <> NEW."gross_minor" OR sums.commission <> NEW."commission_minor" THEN
      RAISE EXCEPTION 'violates check constraint "payouts_amount_matches_items_chk": payout amounts must equal its items'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'payouts_amount_matches_items_chk';
    END IF;
  END IF;
  NEW."updated_at" := CURRENT_TIMESTAMP;
  RETURN NEW;
END $$;

CREATE TRIGGER "payouts_guard_trg"
  BEFORE INSERT OR UPDATE OR DELETE ON "payouts"
  FOR EACH ROW EXECUTE FUNCTION "payouts_guard"();

-- An item joins only an open batch of its own provider, currency and service month, and only when
-- it was paid online in full and not cancelled. Items of a scheduled or paid batch are fixed. An
-- item is PAID out only with a PAID batch, and stays that way.
CREATE FUNCTION "booking_items_payout_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  batch RECORD;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."payout_id" IS NOT NULL AND (
       NEW."payout_id" IS DISTINCT FROM OLD."payout_id"
    OR NEW."total_minor" IS DISTINCT FROM OLD."total_minor"
    OR NEW."commission_minor" IS DISTINCT FROM OLD."commission_minor"
    OR NEW."provider_payout_minor" IS DISTINCT FROM OLD."provider_payout_minor") THEN
    SELECT "status" INTO batch FROM "payouts" WHERE "id" = OLD."payout_id" FOR UPDATE;
    IF batch."status" NOT IN ('PENDING', 'FAILED') THEN
      RAISE EXCEPTION 'violates check constraint "booking_items_payout_link_chk": items of a scheduled or paid payout cannot change'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'booking_items_payout_link_chk';
    END IF;
  END IF;

  IF NEW."payout_id" IS NOT NULL AND (
       TG_OP = 'INSERT' OR NEW."payout_id" IS DISTINCT FROM OLD."payout_id") THEN
    SELECT "status", "provider_id", "currency", "period_start" INTO batch FROM "payouts"
      WHERE "id" = NEW."payout_id" FOR UPDATE;
    IF batch."status" <> 'PENDING'
       OR batch."provider_id" <> NEW."provider_id"
       OR batch."currency" <> NEW."currency"
       OR date_trunc('month', NEW."start_date")::date <> batch."period_start"
       OR NEW."payment_status" <> 'PAID'
       OR NEW."status" NOT IN ('CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'NO_SHOW')
       OR NEW."payout_status" <> 'PENDING' THEN
      RAISE EXCEPTION 'violates check constraint "booking_items_payout_link_chk": item does not belong in this payout'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'booking_items_payout_link_chk';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD."payout_status" = 'PAID' AND (
       NEW."payout_status" IS DISTINCT FROM OLD."payout_status"
    OR NEW."payout_id" IS DISTINCT FROM OLD."payout_id") THEN
    RAISE EXCEPTION 'violates check constraint "booking_items_payout_paid_chk": a paid-out item cannot change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'booking_items_payout_paid_chk';
  END IF;
  IF NEW."payout_status" = 'PAID' AND (TG_OP = 'INSERT' OR OLD."payout_status" <> 'PAID') THEN
    SELECT "status" INTO batch FROM "payouts" WHERE "id" = NEW."payout_id";
    IF NEW."payout_id" IS NULL OR batch."status" IS DISTINCT FROM 'PAID' THEN
      RAISE EXCEPTION 'violates check constraint "booking_items_payout_paid_chk": an item is paid out only by a paid payout'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'booking_items_payout_paid_chk';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "booking_items_payout_guard_trg"
  BEFORE INSERT OR UPDATE OF "payout_id", "payout_status", "total_minor", "commission_minor", "provider_payout_minor"
  ON "booking_items"
  FOR EACH ROW EXECUTE FUNCTION "booking_items_payout_guard"();

-- ============================================================================
-- 2. Voids and invoice adjustments (gap 13)
-- ============================================================================

ALTER TABLE "booking_items"
  ADD COLUMN "voided_at" TIMESTAMPTZ(3),
  ADD COLUMN "voided_by_id" UUID,
  ADD COLUMN "void_reason" TEXT;

ALTER TABLE "booking_items"
  ADD CONSTRAINT "booking_items_voided_by_id_fkey" FOREIGN KEY ("voided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "booking_items_void_chk" CHECK (
    ("voided_at" IS NULL) = ("voided_by_id" IS NULL)
    AND ("voided_at" IS NULL) = ("void_reason" IS NULL)
    AND ("voided_at" IS NULL OR "status" = 'CANCELLED')
    AND ("void_reason" IS NULL OR length(btrim("void_reason")) BETWEEN 1 AND 500));

-- Commission waived on an item of an ISSUED invoice: the invoice itself never changes; an
-- adjustment records what is no longer owed. owed = invoice amount − adjustments.
CREATE TABLE "provider_invoice_adjustments" (
  "id" UUID NOT NULL,
  "invoice_id" UUID NOT NULL,
  "booking_item_id" UUID NOT NULL,
  "amount_minor" BIGINT NOT NULL,
  "currency" CHAR(3) NOT NULL,
  "reason" TEXT NOT NULL,
  "created_by_id" UUID,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "provider_invoice_adjustments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "provider_invoice_adjustments_amount_chk" CHECK ("amount_minor" > 0),
  CONSTRAINT "provider_invoice_adjustments_reason_chk" CHECK (length(btrim("reason")) BETWEEN 1 AND 500)
);
CREATE UNIQUE INDEX "provider_invoice_adjustments_booking_item_id_key"
  ON "provider_invoice_adjustments"("booking_item_id");
CREATE INDEX "provider_invoice_adjustments_invoice_id_idx" ON "provider_invoice_adjustments"("invoice_id");
ALTER TABLE "provider_invoice_adjustments"
  ADD CONSTRAINT "provider_invoice_adjustments_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "provider_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "provider_invoice_adjustments_booking_item_id_fkey" FOREIGN KEY ("booking_item_id") REFERENCES "booking_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "provider_invoice_adjustments_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE FUNCTION "provider_invoice_adjustments_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  inv RECORD;
  item RECORD;
  adjusted NUMERIC;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'violates check constraint "provider_invoice_adjustments_append_only_chk": adjustments are append-only'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'provider_invoice_adjustments_append_only_chk';
  END IF;
  SELECT "status", "amount_minor", "currency" INTO inv FROM "provider_invoices"
    WHERE "id" = NEW."invoice_id" FOR UPDATE;
  SELECT "commission_invoice_id", "commission_minor", "commission_status", "currency" INTO item
    FROM "booking_items" WHERE "id" = NEW."booking_item_id";
  SELECT COALESCE(SUM("amount_minor"), 0) INTO adjusted
    FROM "provider_invoice_adjustments" WHERE "invoice_id" = NEW."invoice_id";
  IF inv."status" <> 'ISSUED'
     OR item."commission_invoice_id" IS DISTINCT FROM NEW."invoice_id"
     OR item."commission_status" <> 'WAIVED'
     OR NEW."amount_minor" <> item."commission_minor"
     OR NEW."currency" <> inv."currency"
     OR adjusted + NEW."amount_minor" > inv."amount_minor" THEN
    RAISE EXCEPTION 'violates check constraint "provider_invoice_adjustments_valid_chk": adjustment does not match a waived item of this issued invoice'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'provider_invoice_adjustments_valid_chk';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "provider_invoice_adjustments_guard_trg"
  BEFORE INSERT OR UPDATE OR DELETE ON "provider_invoice_adjustments"
  FOR EACH ROW EXECUTE FUNCTION "provider_invoice_adjustments_guard"();

-- ============================================================================
-- 3. Listing review (gap 15): who decided, when, and why (rejections need a reason). Approval
--    re-checks the provider-type → listing-type rule (ADR 0013) in the database too.
-- ============================================================================

ALTER TABLE "listings"
  ADD COLUMN "reviewed_at" TIMESTAMPTZ(3),
  ADD COLUMN "reviewed_by_id" UUID,
  ADD COLUMN "review_note" TEXT;
ALTER TABLE "listings"
  ADD CONSTRAINT "listings_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "listings_review_chk" CHECK (
    ("reviewed_at" IS NULL) = ("reviewed_by_id" IS NULL)
    AND ("status" <> 'REJECTED' OR ("review_note" IS NOT NULL AND "reviewed_at" IS NOT NULL))
    AND ("review_note" IS NULL OR length(btrim("review_note")) BETWEEN 1 AND 1000));

CREATE FUNCTION "listings_approval_type_rule"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" = 'APPROVED' AND OLD."status" IS DISTINCT FROM 'APPROVED' THEN
    PERFORM 1
      FROM "providers" p
      JOIN "provider_types" pt ON pt."code" = p."provider_type_code" AND pt."is_active"
      JOIN "provider_type_listing_types" m ON m."provider_type_code" = pt."code"
        AND m."listing_type_code" = NEW."listing_type_code"
      JOIN "listing_types" lt ON lt."code" = NEW."listing_type_code" AND lt."is_active"
      WHERE p."id" = NEW."provider_id";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'violates check constraint "listings_approval_type_rule_chk": the listing type is not allowed for this provider'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'listings_approval_type_rule_chk';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "listings_approval_type_rule_trg"
  BEFORE UPDATE OF "status" ON "listings"
  FOR EACH ROW EXECUTE FUNCTION "listings_approval_type_rule"();

-- ============================================================================
-- 4. Admin accounts (gap 9): one-time setup links (stored hashed) and "never zero admins".
-- ============================================================================

CREATE TABLE "admin_setup_tokens" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "token_hash" TEXT NOT NULL,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "used_at" TIMESTAMPTZ(3),
  "created_by_id" UUID,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "admin_setup_tokens_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "admin_setup_tokens_hash_chk" CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "admin_setup_tokens_expiry_chk" CHECK ("expires_at" >= "created_at")
);
CREATE UNIQUE INDEX "admin_setup_tokens_token_hash_key" ON "admin_setup_tokens"("token_hash");
CREATE INDEX "admin_setup_tokens_user_id_idx" ON "admin_setup_tokens"("user_id");
ALTER TABLE "admin_setup_tokens"
  ADD CONSTRAINT "admin_setup_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "admin_setup_tokens_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- An active admin with a password is the only kind that can sign in and act. The last one can
-- never be suspended, demoted or deleted (the service also serialises admin changes).
CREATE FUNCTION "users_keep_an_admin"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."role" = 'ADMIN' AND OLD."status" = 'ACTIVE' AND OLD."password_hash" IS NOT NULL
     AND (TG_OP = 'DELETE' OR NEW."role" <> 'ADMIN' OR NEW."status" <> 'ACTIVE'
          OR NEW."password_hash" IS NULL) THEN
    PERFORM 1 FROM "users"
      WHERE "role" = 'ADMIN' AND "status" = 'ACTIVE' AND "password_hash" IS NOT NULL
        AND "id" <> OLD."id";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'violates check constraint "users_last_admin_chk": at least one active admin must remain'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'users_last_admin_chk';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "users_keep_an_admin_trg"
  BEFORE UPDATE OF "role", "status", "password_hash" OR DELETE ON "users"
  FOR EACH ROW EXECUTE FUNCTION "users_keep_an_admin"();

-- ============================================================================
-- 5. Gateway re-checks of closed payments (gap 33): when each eSewa/Khalti payment that closed
--    without money (cancelled at hold expiry, failed, replaced) is asked again.
-- ============================================================================

CREATE TABLE "payment_gateway_checks" (
  "payment_id" UUID NOT NULL,
  "checks" INTEGER NOT NULL DEFAULT 0,
  "last_checked_at" TIMESTAMPTZ(3),
  "last_result" TEXT,
  -- NULL = no more checks planned.
  "next_check_at" TIMESTAMPTZ(3),
  CONSTRAINT "payment_gateway_checks_pkey" PRIMARY KEY ("payment_id"),
  CONSTRAINT "payment_gateway_checks_count_chk" CHECK ("checks" >= 0)
);
CREATE INDEX "payment_gateway_checks_next_check_at_idx" ON "payment_gateway_checks"("next_check_at");
ALTER TABLE "payment_gateway_checks"
  ADD CONSTRAINT "payment_gateway_checks_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
