-- Phase 14 (ADR 0020): customer cancellations on the frozen policy with the owner's refund clock,
-- refund EXECUTION (gap 31), clawbacks of paid-out bookings deducted from later payouts (gap 39),
-- and reconciliation of pay-at-property settlements (gap 36).
--
-- Guard triggers raise check_violation (23514) naming their constraint in the message, like the
-- earlier phases, so lib/database-errors.ts maps them centrally. Applied migrations are never edited:
-- the Phase 11 refund guard and the Phase 12 payout guards are REPLACED here (CREATE OR REPLACE).

-- ============================================================================
-- 1. The refund clock: the exact start of each booked service (owner decision 2026-11-27)
-- ============================================================================

-- Start times for the types that had none. Existing rows stay NULL (they use the fallback);
-- the API requires the field for new and edited details.
ALTER TABLE "guide_service_details"
  ADD COLUMN "start_time" TEXT,
  ADD CONSTRAINT "guide_service_details_start_time_chk"
    CHECK ("start_time" IS NULL OR "start_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');

ALTER TABLE "tour_details"
  ADD COLUMN "start_time" TEXT,
  ADD CONSTRAINT "tour_details_start_time_chk"
    CHECK ("start_time" IS NULL OR "start_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');

-- Activities had no detail table (generic attributes): a 1:1 table for their start time
-- (ADR 0004: a vertical gains a detail table when a rule must read its fields).
CREATE TABLE "activity_details" (
  "listing_id" UUID NOT NULL,
  "start_time" TEXT NOT NULL,
  CONSTRAINT "activity_details_pkey" PRIMARY KEY ("listing_id"),
  CONSTRAINT "activity_details_start_time_chk"
    CHECK ("start_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
);
ALTER TABLE "activity_details"
  ADD CONSTRAINT "activity_details_listing_id_fkey" FOREIGN KEY ("listing_id")
    REFERENCES "listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Each booking item freezes when its service starts: the start date at the listing's start time
-- (check-in, departure, start) in Nepal time, stored in UTC. LISTING_TIME = from the listing;
-- DEFAULT_MIDNIGHT = the listing had no start time, so 00:00 Nepal time of the start date.
ALTER TABLE "booking_items"
  ADD COLUMN "service_starts_at" TIMESTAMPTZ(3),
  ADD COLUMN "service_start_source" TEXT;

-- Existing items: the hotel's check-in (a room uses its parent hotel's), the bus departure, else
-- midnight. Matched by detail rows, not by listing-type code.
UPDATE "booking_items" bi
SET "service_starts_at" =
      ((bi."start_date" + COALESCE(hd."check_in_time", phd."check_in_time", brd."departure_time", '00:00')::time)
        AT TIME ZONE 'Asia/Kathmandu'),
    "service_start_source" =
      CASE WHEN COALESCE(hd."check_in_time", phd."check_in_time", brd."departure_time") IS NULL
           THEN 'DEFAULT_MIDNIGHT' ELSE 'LISTING_TIME' END
FROM "listings" l
LEFT JOIN "hotel_details" hd ON hd."listing_id" = l."id"
LEFT JOIN "hotel_details" phd ON phd."listing_id" = l."parent_id"
LEFT JOIN "bus_route_details" brd ON brd."listing_id" = l."id"
WHERE l."id" = bi."listing_id";

ALTER TABLE "booking_items"
  ALTER COLUMN "service_starts_at" SET NOT NULL,
  ALTER COLUMN "service_start_source" SET NOT NULL,
  ADD CONSTRAINT "booking_items_service_start_source_chk"
    CHECK ("service_start_source" IN ('LISTING_TIME', 'DEFAULT_MIDNIGHT')),
  -- The start falls on the first service date, in Nepal time; the fallback is exactly midnight.
  ADD CONSTRAINT "booking_items_service_start_date_chk"
    CHECK (("service_starts_at" AT TIME ZONE 'Asia/Kathmandu')::date = "start_date"),
  ADD CONSTRAINT "booking_items_service_start_midnight_chk"
    CHECK ("service_start_source" <> 'DEFAULT_MIDNIGHT'
           OR ("service_starts_at" AT TIME ZONE 'Asia/Kathmandu')::time = '00:00');

-- ============================================================================
-- 2. Customer cancellations: refund and commission frozen at the moment of cancelling
-- ============================================================================

-- cancellation_refund_bps: the policy tier that applied (0 = nothing back).
-- cancellation_refund_minor: what goes back = round_half_up(total × bps / 10000) for online items
--   (confirmed online items are fully paid), 0 for pay-at-property.
-- kept_commission_minor: commission on the part kept (owner decision 2026-11-27):
--   min(round_half_up(subtotal × (10000 − bps) / 10000 × rate / 10000), total − refund); 0 when waived.
ALTER TABLE "booking_items"
  ADD COLUMN "cancelled_by_id" UUID,
  ADD COLUMN "cancellation_refund_bps" INTEGER,
  ADD COLUMN "cancellation_refund_minor" BIGINT,
  ADD COLUMN "kept_commission_minor" BIGINT;

ALTER TABLE "booking_items"
  ADD CONSTRAINT "booking_items_cancelled_by_id_fkey" FOREIGN KEY ("cancelled_by_id")
    REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "booking_items_customer_cancel_chk" CHECK (
    ("cancellation_refund_bps" IS NULL) = ("cancellation_refund_minor" IS NULL)
    AND ("cancellation_refund_bps" IS NULL) = ("kept_commission_minor" IS NULL)
    AND ("cancellation_refund_bps" IS NULL) = ("cancelled_by_id" IS NULL)
    AND ("cancellation_refund_bps" IS NULL OR (
          "status" = 'CANCELLED'
      AND "voided_at" IS NULL
      AND "cancelled_at" IS NOT NULL
      AND "cancelled_at" < "service_starts_at"
      AND "cancellation_refund_bps" BETWEEN 0 AND 10000))),
  ADD CONSTRAINT "booking_items_cancel_refund_chk" CHECK (
    "cancellation_refund_bps" IS NULL
    OR "cancellation_refund_minor" = CASE
         WHEN "payment_status" IN ('PAY_AT_PROPERTY', 'PAID_AT_PROPERTY') THEN 0
         ELSE ROUND("total_minor"::numeric * "cancellation_refund_bps" / 10000) END),
  ADD CONSTRAINT "booking_items_kept_commission_chk" CHECK (
    "cancellation_refund_bps" IS NULL
    OR "kept_commission_minor" = CASE
         WHEN "commission_status" = 'WAIVED' THEN 0
         ELSE LEAST(
           ROUND("subtotal_minor"::numeric * (10000 - "cancellation_refund_bps") * "commission_rate_bps" / 100000000),
           "total_minor" - "cancellation_refund_minor") END),
  -- Nothing kept (pay-at-property, or everything refunded) means no commission.
  ADD CONSTRAINT "booking_items_cancel_waived_chk" CHECK (
    "cancellation_refund_bps" IS NULL
    OR "commission_status" = 'WAIVED'
    OR ("payment_status" NOT IN ('PAY_AT_PROPERTY', 'PAID_AT_PROPERTY')
        AND "cancellation_refund_minor" < "total_minor"));

-- ============================================================================
-- 3. Refund execution (gap 31): approve → execute (Khalti API, eSewa by hand) → completed
-- ============================================================================

ALTER TABLE "refund_requests" DROP CONSTRAINT "refund_requests_not_executed_chk";

ALTER TABLE "refund_requests"
  ADD COLUMN "approved_at" TIMESTAMPTZ(3),
  ADD COLUMN "approved_by_id" UUID,
  ADD COLUMN "processing_at" TIMESTAMPTZ(3),
  ADD COLUMN "executed_by_id" UUID,
  -- API = the gateway's refund API was called; MANUAL = an admin refunds in the merchant portal.
  ADD COLUMN "execution_mode" TEXT,
  ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "completed_at" TIMESTAMPTZ(3),
  ADD COLUMN "completed_by_id" UUID,
  ADD COLUMN "failed_at" TIMESTAMPTZ(3),
  ADD COLUMN "failure_reason" TEXT,
  ADD COLUMN "rejected_at" TIMESTAMPTZ(3),
  ADD COLUMN "rejected_by_id" UUID,
  -- Admin notes: why rejected, or how a manual refund was made. Never a secret.
  ADD COLUMN "note" TEXT,
  -- The gateway's answer to the refund call or check (no secrets), for reconciliation.
  ADD COLUMN "gateway_response" JSONB;

ALTER TABLE "refund_requests"
  ADD CONSTRAINT "refund_requests_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "refund_requests_executed_by_id_fkey" FOREIGN KEY ("executed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "refund_requests_completed_by_id_fkey" FOREIGN KEY ("completed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "refund_requests_rejected_by_id_fkey" FOREIGN KEY ("rejected_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "refund_requests_execution_mode_chk"
    CHECK ("execution_mode" IS NULL OR "execution_mode" IN ('API', 'MANUAL')),
  ADD CONSTRAINT "refund_requests_attempts_chk" CHECK ("attempts" >= 0),
  ADD CONSTRAINT "refund_requests_reference_chk"
    CHECK ("gateway_refund_reference" IS NULL OR length(btrim("gateway_refund_reference")) BETWEEN 1 AND 200),
  ADD CONSTRAINT "refund_requests_note_chk"
    CHECK ("note" IS NULL OR length(btrim("note")) BETWEEN 1 AND 1000),
  ADD CONSTRAINT "refund_requests_failure_reason_chk"
    CHECK ("failure_reason" IS NULL OR length(btrim("failure_reason")) BETWEEN 1 AND 500),
  -- Each status carries the fields that prove how it was reached.
  ADD CONSTRAINT "refund_requests_status_fields_chk" CHECK (
    -- REQUESTED: nothing decided yet.
    ("status" <> 'REQUESTED' OR ("approved_at" IS NULL AND "processing_at" IS NULL))
    -- Approved (and everything after it): who approved, and when.
    AND ("status" NOT IN ('APPROVED', 'PROCESSING', 'COMPLETED', 'FAILED')
         OR ("approved_at" IS NOT NULL AND "approved_by_id" IS NOT NULL))
    AND ("status" <> 'APPROVED' OR "processing_at" IS NULL)
    -- Executed: when, how (API or by hand), and at least one attempt.
    AND ("status" NOT IN ('PROCESSING', 'COMPLETED', 'FAILED')
         OR ("processing_at" IS NOT NULL AND "execution_mode" IS NOT NULL AND "attempts" > 0))
    -- Completed: when, the gateway's reference, and who confirmed a manual refund.
    AND (("status" = 'COMPLETED') = ("completed_at" IS NOT NULL))
    AND ("status" <> 'COMPLETED' OR "gateway_refund_reference" IS NOT NULL)
    AND ("status" <> 'COMPLETED' OR "execution_mode" = 'API' OR "completed_by_id" IS NOT NULL)
    AND ("status" <> 'FAILED' OR ("failed_at" IS NOT NULL AND "failure_reason" IS NOT NULL))
    -- Rejected: who, when and why.
    AND (("status" = 'REJECTED') = ("rejected_at" IS NOT NULL))
    AND ("status" <> 'REJECTED' OR ("rejected_by_id" IS NOT NULL AND "note" IS NOT NULL)));

-- One refund in flight per payment, so a gateway is never asked twice at once about one charge.
CREATE UNIQUE INDEX "refund_requests_one_processing_per_payment"
  ON "refund_requests"("payment_id") WHERE "status" = 'PROCESSING';
CREATE INDEX "refund_requests_status_idx" ON "refund_requests"("status");

-- Replaces the Phase 11 guard: same limits (a charge of its gateway and currency, never more than
-- was paid), plus the execution state machine and immutable money fields.
--   REQUESTED → APPROVED | REJECTED
--   APPROVED  → PROCESSING | REJECTED
--   PROCESSING → COMPLETED | FAILED
--   FAILED    → PROCESSING (retry) | REJECTED (given up; handled outside MeroStay, with a note)
--   COMPLETED, REJECTED: final.
CREATE OR REPLACE FUNCTION "refund_requests_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  pay RECORD;
  available NUMERIC;
  requested NUMERIC;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'violates check constraint "refund_requests_kept_chk": refund records are kept'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'refund_requests_kept_chk';
  END IF;

  IF TG_OP = 'INSERT' AND NEW."status" <> 'REQUESTED' THEN
    RAISE EXCEPTION 'violates check constraint "refund_requests_transition_chk": a refund starts REQUESTED'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'refund_requests_transition_chk';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW."payment_id" IS DISTINCT FROM OLD."payment_id"
       OR NEW."booking_item_id" IS DISTINCT FROM OLD."booking_item_id"
       OR NEW."payment_reconciliation_id" IS DISTINCT FROM OLD."payment_reconciliation_id"
       OR NEW."gateway" IS DISTINCT FROM OLD."gateway"
       OR NEW."amount_minor" IS DISTINCT FROM OLD."amount_minor"
       OR NEW."currency" IS DISTINCT FROM OLD."currency"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
      RAISE EXCEPTION 'violates check constraint "refund_requests_immutable_chk": a refund''s money fields never change'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'refund_requests_immutable_chk';
    END IF;
    IF OLD."status" IN ('COMPLETED', 'REJECTED') AND (
         NEW."status" IS DISTINCT FROM OLD."status"
      OR NEW."gateway_refund_reference" IS DISTINCT FROM OLD."gateway_refund_reference"
      OR NEW."completed_at" IS DISTINCT FROM OLD."completed_at"
      OR NEW."note" IS DISTINCT FROM OLD."note") THEN
      RAISE EXCEPTION 'violates check constraint "refund_requests_final_chk": a finished refund cannot change'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'refund_requests_final_chk';
    END IF;
    IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
         (OLD."status" = 'REQUESTED' AND NEW."status" IN ('APPROVED', 'REJECTED'))
      OR (OLD."status" = 'APPROVED' AND NEW."status" IN ('PROCESSING', 'REJECTED'))
      OR (OLD."status" = 'PROCESSING' AND NEW."status" IN ('COMPLETED', 'FAILED'))
      OR (OLD."status" = 'FAILED' AND NEW."status" IN ('PROCESSING', 'REJECTED'))) THEN
      RAISE EXCEPTION 'violates check constraint "refund_requests_transition_chk": invalid refund status change'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'refund_requests_transition_chk';
    END IF;
  END IF;

  SELECT "kind", "status", "gateway", "currency" INTO pay FROM "payments" WHERE "id" = NEW."payment_id";
  IF pay."kind" <> 'CHARGE' OR NEW."gateway" <> pay."gateway" OR NEW."currency" <> pay."currency" THEN
    RAISE EXCEPTION 'violates check constraint "refund_requests_within_payment_chk": a refund refers to a charge, in its gateway and currency'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'refund_requests_within_payment_chk';
  END IF;

  IF NEW."booking_item_id" IS NOT NULL THEN
    PERFORM 1 FROM "booking_items" WHERE "id" = NEW."booking_item_id" FOR UPDATE;
    SELECT COALESCE(SUM("amount_minor"), 0) INTO available
      FROM "payment_allocations"
      WHERE "payment_id" = NEW."payment_id" AND "booking_item_id" = NEW."booking_item_id";
    SELECT COALESCE(SUM("amount_minor"), 0) + NEW."amount_minor" INTO requested
      FROM "refund_requests"
      WHERE "payment_id" = NEW."payment_id" AND "booking_item_id" = NEW."booking_item_id"
        AND "status" <> 'REJECTED' AND "id" <> NEW."id";
  ELSE
    SELECT "amount_minor" INTO available
      FROM "payment_reconciliations"
      WHERE "id" = NEW."payment_reconciliation_id" AND "payment_id" = NEW."payment_id"
      FOR UPDATE;
    SELECT COALESCE(SUM("amount_minor"), 0) + NEW."amount_minor" INTO requested
      FROM "refund_requests"
      WHERE "payment_reconciliation_id" = NEW."payment_reconciliation_id"
        AND "status" <> 'REJECTED' AND "id" <> NEW."id";
  END IF;

  IF available IS NULL OR NEW."status" <> 'REJECTED' AND requested > available THEN
    RAISE EXCEPTION 'violates check constraint "refund_requests_within_payment_chk": refunds exceed what was paid'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'refund_requests_within_payment_chk';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER "refund_requests_guard_trg" ON "refund_requests";
CREATE TRIGGER "refund_requests_guard_trg"
  BEFORE INSERT OR UPDATE OR DELETE ON "refund_requests"
  FOR EACH ROW EXECUTE FUNCTION "refund_requests_guard"();

-- An item's refunded amount is exactly its COMPLETED refunds, and its payment status follows:
-- PAID = nothing refunded; PARTIALLY_REFUNDED = some; REFUNDED = everything that was paid online.
-- Checked at commit (deferred), so the refund row and the item can be written in either order.
CREATE FUNCTION "booking_item_refunds_check"(item_id UUID) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  item RECORD;
  completed NUMERIC;
  allocated NUMERIC;
BEGIN
  SELECT "refunded_minor", "payment_status" INTO item FROM "booking_items" WHERE "id" = item_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT COALESCE(SUM("amount_minor"), 0) INTO completed
    FROM "refund_requests" WHERE "booking_item_id" = item_id AND "status" = 'COMPLETED';
  SELECT COALESCE(SUM(a."amount_minor"), 0) INTO allocated
    FROM "payment_allocations" a JOIN "payments" p ON p."id" = a."payment_id"
    WHERE a."booking_item_id" = item_id AND p."kind" = 'CHARGE' AND p."status" = 'SUCCEEDED';
  IF item."refunded_minor" <> completed
     OR (item."payment_status" IN ('UNPAID', 'PARTIALLY_PAID', 'PAID', 'PAY_AT_PROPERTY', 'PAID_AT_PROPERTY')
         AND completed <> 0)
     OR (item."payment_status" = 'PARTIALLY_REFUNDED' AND NOT (completed > 0 AND completed < allocated))
     OR (item."payment_status" = 'REFUNDED' AND NOT (completed > 0 AND completed = allocated)) THEN
    RAISE EXCEPTION 'violates check constraint "booking_items_refunds_match_chk": refunded amount and payment status must match the completed refunds'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'booking_items_refunds_match_chk';
  END IF;
END $$;

CREATE FUNCTION "booking_items_refunds_trg_fn"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "booking_item_refunds_check"(NEW."id");
  RETURN NULL;
END $$;

CREATE FUNCTION "refund_requests_item_trg_fn"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."booking_item_id" IS NOT NULL THEN
    PERFORM "booking_item_refunds_check"(NEW."booking_item_id");
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER "booking_items_refunds_match_trg"
  AFTER UPDATE OF "refunded_minor", "payment_status" ON "booking_items"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "booking_items_refunds_trg_fn"();

CREATE CONSTRAINT TRIGGER "refund_requests_item_match_trg"
  AFTER UPDATE OF "status" ON "refund_requests"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "refund_requests_item_trg_fn"();

-- ============================================================================
-- 4. Payouts: cancelled-with-kept-money items, and clawback deductions (gap 39)
-- ============================================================================

-- A batch line: gross = what MeroStay kept for the item (total − refunded); commission = the
-- commission on it (kept commission for a customer-cancelled item, else the snapshot).
-- Net = gross − commission − deductions (clawbacks recovered from this batch), never below zero.
ALTER TABLE "payouts"
  ADD COLUMN "deductions_minor" BIGINT NOT NULL DEFAULT 0,
  ADD CONSTRAINT "payouts_deductions_chk" CHECK ("deductions_minor" >= 0);
ALTER TABLE "payouts" DROP CONSTRAINT "payouts_net_chk";
ALTER TABLE "payouts"
  ADD CONSTRAINT "payouts_net_chk"
    CHECK ("amount_minor" = "gross_minor" - "commission_minor" - "deductions_minor");

-- What a provider owes back after a paid-out booking was voided: the item's line in its PAID
-- batch. Append-only; recovered by deductions from later batches.
CREATE TABLE "provider_clawbacks" (
  "id" UUID NOT NULL,
  "provider_id" UUID NOT NULL,
  "booking_item_id" UUID NOT NULL,
  "payout_id" UUID NOT NULL,
  "currency" CHAR(3) NOT NULL,
  "amount_minor" BIGINT NOT NULL,
  "reason" TEXT NOT NULL,
  "created_by_id" UUID,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "provider_clawbacks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "provider_clawbacks_amount_chk" CHECK ("amount_minor" > 0),
  CONSTRAINT "provider_clawbacks_reason_chk" CHECK (length(btrim("reason")) BETWEEN 1 AND 500)
);
CREATE UNIQUE INDEX "provider_clawbacks_booking_item_id_key" ON "provider_clawbacks"("booking_item_id");
CREATE INDEX "provider_clawbacks_provider_id_currency_idx" ON "provider_clawbacks"("provider_id", "currency");
ALTER TABLE "provider_clawbacks"
  ADD CONSTRAINT "provider_clawbacks_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "provider_clawbacks_booking_item_id_fkey" FOREIGN KEY ("booking_item_id") REFERENCES "booking_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "provider_clawbacks_payout_id_fkey" FOREIGN KEY ("payout_id") REFERENCES "payouts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "provider_clawbacks_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A deduction from one batch towards one clawback. Created only while the batch is being
-- scheduled (PENDING); counts while the batch is SCHEDULED or PAID, not when it FAILED.
CREATE TABLE "provider_clawback_recoveries" (
  "id" UUID NOT NULL,
  "clawback_id" UUID NOT NULL,
  "payout_id" UUID NOT NULL,
  "amount_minor" BIGINT NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "provider_clawback_recoveries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "provider_clawback_recoveries_amount_chk" CHECK ("amount_minor" > 0)
);
CREATE UNIQUE INDEX "provider_clawback_recoveries_clawback_payout_key"
  ON "provider_clawback_recoveries"("clawback_id", "payout_id");
CREATE INDEX "provider_clawback_recoveries_payout_id_idx" ON "provider_clawback_recoveries"("payout_id");
ALTER TABLE "provider_clawback_recoveries"
  ADD CONSTRAINT "provider_clawback_recoveries_clawback_id_fkey" FOREIGN KEY ("clawback_id") REFERENCES "provider_clawbacks"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "provider_clawback_recoveries_payout_id_fkey" FOREIGN KEY ("payout_id") REFERENCES "payouts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "provider_clawbacks_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  item RECORD;
  batch RECORD;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'violates check constraint "provider_clawbacks_append_only_chk": clawbacks are append-only'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'provider_clawbacks_append_only_chk';
  END IF;
  SELECT "provider_id", "currency", "payout_id", "payout_status", "voided_at",
         "total_minor", "refunded_minor", "commission_minor", "kept_commission_minor"
    INTO item FROM "booking_items" WHERE "id" = NEW."booking_item_id";
  SELECT "status" INTO batch FROM "payouts" WHERE "id" = NEW."payout_id";
  IF item."voided_at" IS NULL OR item."payout_status" <> 'PAID'
     OR item."payout_id" IS DISTINCT FROM NEW."payout_id" OR batch."status" <> 'PAID'
     OR item."provider_id" <> NEW."provider_id" OR item."currency" <> NEW."currency"
     OR NEW."amount_minor" <> item."total_minor" - item."refunded_minor"
                              - COALESCE(item."kept_commission_minor", item."commission_minor") THEN
    RAISE EXCEPTION 'violates check constraint "provider_clawbacks_item_chk": a clawback is the paid-out line of a voided item'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'provider_clawbacks_item_chk';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "provider_clawbacks_guard_trg"
  BEFORE INSERT OR UPDATE OR DELETE ON "provider_clawbacks"
  FOR EACH ROW EXECUTE FUNCTION "provider_clawbacks_guard"();

CREATE FUNCTION "provider_clawback_recoveries_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  claw RECORD;
  batch RECORD;
  recovered NUMERIC;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'violates check constraint "provider_clawback_recoveries_append_only_chk": recoveries are append-only'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'provider_clawback_recoveries_append_only_chk';
  END IF;
  SELECT "provider_id", "currency", "amount_minor" INTO claw
    FROM "provider_clawbacks" WHERE "id" = NEW."clawback_id" FOR UPDATE;
  SELECT "provider_id", "currency", "status" INTO batch FROM "payouts" WHERE "id" = NEW."payout_id";
  IF batch."status" <> 'PENDING' OR batch."provider_id" <> claw."provider_id"
     OR batch."currency" <> claw."currency" THEN
    RAISE EXCEPTION 'violates check constraint "provider_clawback_recoveries_payout_chk": a deduction is taken from an open batch of the same provider and currency'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'provider_clawback_recoveries_payout_chk';
  END IF;
  SELECT COALESCE(SUM(r."amount_minor"), 0) + NEW."amount_minor" INTO recovered
    FROM "provider_clawback_recoveries" r JOIN "payouts" p ON p."id" = r."payout_id"
    WHERE r."clawback_id" = NEW."clawback_id" AND p."status" <> 'FAILED';
  IF recovered > claw."amount_minor" THEN
    RAISE EXCEPTION 'violates check constraint "provider_clawback_recoveries_within_chk": deductions exceed the clawback'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'provider_clawback_recoveries_within_chk';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "provider_clawback_recoveries_guard_trg"
  BEFORE INSERT OR UPDATE OR DELETE ON "provider_clawback_recoveries"
  FOR EACH ROW EXECUTE FUNCTION "provider_clawback_recoveries_guard"();

-- Replaces the Phase 12 batch guard: sums use the payable lines and the deductions.
CREATE OR REPLACE FUNCTION "payouts_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  sums RECORD;
  deducted NUMERIC;
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
    OR NEW."deductions_minor" IS DISTINCT FROM OLD."deductions_minor"
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
    SELECT COALESCE(SUM("total_minor" - "refunded_minor"), 0) AS gross,
           COALESCE(SUM(COALESCE("kept_commission_minor", "commission_minor")), 0) AS commission,
           COUNT(*) AS items
      INTO sums FROM "booking_items" WHERE "payout_id" = NEW."id";
    SELECT COALESCE(SUM("amount_minor"), 0) INTO deducted
      FROM "provider_clawback_recoveries" WHERE "payout_id" = NEW."id";
    IF sums.items = 0 OR sums.items <> NEW."item_count"
       OR sums.gross <> NEW."gross_minor" OR sums.commission <> NEW."commission_minor"
       OR deducted <> NEW."deductions_minor" THEN
      RAISE EXCEPTION 'violates check constraint "payouts_amount_matches_items_chk": payout amounts must equal its items'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'payouts_amount_matches_items_chk';
    END IF;
  END IF;
  NEW."updated_at" := CURRENT_TIMESTAMP;
  RETURN NEW;
END $$;

-- Replaces the Phase 12 item guard: a customer-cancelled item whose kept money is still with
-- MeroStay (PAID with nothing refunded, or PARTIALLY_REFUNDED) may join a batch; voided items and
-- other partial refunds never do. Kept commission and refunds of a batched item are fixed too.
CREATE OR REPLACE FUNCTION "booking_items_payout_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  batch RECORD;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."payout_id" IS NOT NULL AND (
       NEW."payout_id" IS DISTINCT FROM OLD."payout_id"
    OR NEW."total_minor" IS DISTINCT FROM OLD."total_minor"
    OR NEW."commission_minor" IS DISTINCT FROM OLD."commission_minor"
    OR NEW."provider_payout_minor" IS DISTINCT FROM OLD."provider_payout_minor"
    OR NEW."kept_commission_minor" IS DISTINCT FROM OLD."kept_commission_minor"
    OR (OLD."payout_status" <> 'PAID' AND NEW."refunded_minor" IS DISTINCT FROM OLD."refunded_minor")) THEN
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
       OR NEW."payout_status" <> 'PENDING'
       OR NOT (
            (NEW."payment_status" = 'PAID'
             AND NEW."status" IN ('CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'NO_SHOW'))
         OR (NEW."status" = 'CANCELLED' AND NEW."cancellation_refund_bps" IS NOT NULL
             AND NEW."voided_at" IS NULL
             AND NEW."payment_status" IN ('PAID', 'PARTIALLY_REFUNDED')
             AND NEW."refunded_minor" = NEW."cancellation_refund_minor"
             AND NEW."refunded_minor" < NEW."total_minor")) THEN
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

DROP TRIGGER "booking_items_payout_guard_trg" ON "booking_items";
CREATE TRIGGER "booking_items_payout_guard_trg"
  BEFORE INSERT OR UPDATE OF "payout_id", "payout_status", "total_minor", "commission_minor",
    "provider_payout_minor", "kept_commission_minor", "refunded_minor"
  ON "booking_items"
  FOR EACH ROW EXECUTE FUNCTION "booking_items_payout_guard"();

-- ============================================================================
-- 5. Pay-at-property settlement reconciliation (gap 36): resolutions only, no money moves
-- ============================================================================

-- Mismatches are computed from the data (lib: domain/settlement-reconciliation.ts); an admin
-- records how each one was handled. One resolution per item and kind; append-only.
CREATE TABLE "settlement_reconciliation_resolutions" (
  "id" UUID NOT NULL,
  "booking_item_id" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "note" TEXT NOT NULL,
  "resolved_by_id" UUID,
  "resolved_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "settlement_reconciliation_resolutions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "settlement_reconciliation_resolutions_kind_chk"
    CHECK ("kind" IN ('UNSETTLED_AFTER_SERVICE', 'SETTLED_NOT_INVOICED', 'SETTLED_BEFORE_SERVICE')),
  CONSTRAINT "settlement_reconciliation_resolutions_note_chk"
    CHECK (length(btrim("note")) BETWEEN 1 AND 1000)
);
CREATE UNIQUE INDEX "settlement_reconciliation_resolutions_item_kind_key"
  ON "settlement_reconciliation_resolutions"("booking_item_id", "kind");
ALTER TABLE "settlement_reconciliation_resolutions"
  ADD CONSTRAINT "settlement_reconciliation_resolutions_booking_item_id_fkey" FOREIGN KEY ("booking_item_id") REFERENCES "booking_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "settlement_reconciliation_resolutions_resolved_by_id_fkey" FOREIGN KEY ("resolved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE FUNCTION "settlement_reconciliation_resolutions_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'violates check constraint "settlement_reconciliation_append_only_chk": resolutions are append-only'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'settlement_reconciliation_append_only_chk';
END $$;

CREATE TRIGGER "settlement_reconciliation_resolutions_guard_trg"
  BEFORE UPDATE OR DELETE ON "settlement_reconciliation_resolutions"
  FOR EACH ROW EXECUTE FUNCTION "settlement_reconciliation_resolutions_guard"();
