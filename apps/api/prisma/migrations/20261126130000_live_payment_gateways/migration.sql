-- =====================================================================================
-- Phase 11 (ADR 0017): live eSewa and Khalti (sandbox) behind one gateway interface,
-- late successes kept for reconciliation (gap 8), and the shape of refunds (not executed).
-- =====================================================================================

-- ------------------------------------------------------------------ payments
-- gateway_reference: the gateway's id for this checkout (eSewa: transaction_uuid, which is the
-- payment id; Khalti: pidx). checkout: what the browser needs to start paying (form fields or a
-- redirect URL; never a secret). checkout_expires_at: when the gateway stops accepting it.
ALTER TABLE "payments"
  ADD COLUMN "gateway_reference" TEXT,
  ADD COLUMN "checkout" JSONB,
  ADD COLUMN "checkout_expires_at" TIMESTAMPTZ(3);

CREATE UNIQUE INDEX "payments_gateway_gateway_reference_key"
  ON "payments"("gateway", "gateway_reference");

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_gateway_chk" CHECK ("gateway" IN ('simulated', 'esewa', 'khalti')),
  ADD CONSTRAINT "payments_gateway_reference_chk"
    CHECK ("gateway_reference" IS NULL OR length("gateway_reference") BETWEEN 1 AND 200);

-- ------------------------------------------------------------------ reconciliation (gap 8)
-- Money a gateway reports as received that could not be applied to the trip: the payment was no
-- longer open (cancelled when the hold expired), the trip no longer awaited payment, the amount
-- due had changed, the amount differed, or the trip was paid twice. It is recorded once per
-- gateway transaction (repeated callbacks change nothing) and stays OPEN until an admin resolves
-- it (refund or re-booking: later phases). Nothing is allocated to booking items from here.
CREATE TYPE "payment_reconciliation_reason" AS ENUM (
  'PAYMENT_NOT_OPEN',
  'TRIP_NOT_AWAITING_PAYMENT',
  'INTENT_STALE',
  'AMOUNT_MISMATCH',
  'DUPLICATE_PAYMENT'
);
CREATE TYPE "payment_reconciliation_status" AS ENUM ('OPEN', 'RESOLVED');

CREATE TABLE "payment_reconciliations" (
  "id" UUID NOT NULL,
  "payment_id" UUID NOT NULL,
  "trip_id" UUID NOT NULL,
  "gateway" TEXT NOT NULL,
  "gateway_transaction_id" TEXT NOT NULL,
  "amount_minor" BIGINT NOT NULL,
  "currency" CHAR(3) NOT NULL,
  "reason" "payment_reconciliation_reason" NOT NULL,
  "status" "payment_reconciliation_status" NOT NULL DEFAULT 'OPEN',
  "gateway_response" JSONB,
  "note" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolved_at" TIMESTAMPTZ(3),
  "resolved_by_id" UUID,

  CONSTRAINT "payment_reconciliations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "payment_reconciliations_amount_chk" CHECK ("amount_minor" > 0),
  CONSTRAINT "payment_reconciliations_resolved_chk" CHECK (("status" = 'RESOLVED') = ("resolved_at" IS NOT NULL))
);

CREATE UNIQUE INDEX "payment_reconciliations_gateway_gateway_transaction_id_key"
  ON "payment_reconciliations"("gateway", "gateway_transaction_id");
CREATE INDEX "payment_reconciliations_status_idx" ON "payment_reconciliations"("status");
CREATE INDEX "payment_reconciliations_trip_id_idx" ON "payment_reconciliations"("trip_id");

ALTER TABLE "payment_reconciliations"
  ADD CONSTRAINT "payment_reconciliations_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "payment_reconciliations_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "trips"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "payment_reconciliations_resolved_by_id_fkey" FOREIGN KEY ("resolved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- What the gateway said is fixed; only the resolution (status, note, who/when) may change, once.
CREATE FUNCTION "payment_reconciliations_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'violates check constraint "payment_reconciliations_immutable_chk": reconciliation records are kept'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'payment_reconciliations_immutable_chk';
  END IF;
  IF OLD."status" = 'RESOLVED'
     OR NEW."payment_id" IS DISTINCT FROM OLD."payment_id"
     OR NEW."trip_id" IS DISTINCT FROM OLD."trip_id"
     OR NEW."gateway" IS DISTINCT FROM OLD."gateway"
     OR NEW."gateway_transaction_id" IS DISTINCT FROM OLD."gateway_transaction_id"
     OR NEW."amount_minor" IS DISTINCT FROM OLD."amount_minor"
     OR NEW."currency" IS DISTINCT FROM OLD."currency"
     OR NEW."reason" IS DISTINCT FROM OLD."reason"
     OR NEW."gateway_response" IS DISTINCT FROM OLD."gateway_response" THEN
    RAISE EXCEPTION 'violates check constraint "payment_reconciliations_immutable_chk": only an open record''s resolution may change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'payment_reconciliations_immutable_chk';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "payment_reconciliations_guard_trg"
  BEFORE UPDATE OR DELETE ON "payment_reconciliations"
  FOR EACH ROW EXECUTE FUNCTION "payment_reconciliations_guard"();

-- ------------------------------------------------------------------ refunds (shape only)
-- A refund request: what should go back to the customer, from which payment, for which booking
-- item (or for an unapplied late payment). Refunds are NOT executed this phase: the database keeps
-- every request REQUESTED or REJECTED; executing them (gateway refund call, REFUND payments) is the
-- Cancellations & refunds phase, which relaxes refund_requests_not_executed_chk in its migration.
CREATE TYPE "refund_request_status" AS ENUM (
  'REQUESTED', 'REJECTED', 'APPROVED', 'PROCESSING', 'COMPLETED', 'FAILED'
);

CREATE TABLE "refund_requests" (
  "id" UUID NOT NULL,
  "payment_id" UUID NOT NULL,
  "booking_item_id" UUID,
  "payment_reconciliation_id" UUID,
  "gateway" TEXT NOT NULL,
  "amount_minor" BIGINT NOT NULL,
  "currency" CHAR(3) NOT NULL,
  "reason" TEXT NOT NULL,
  "status" "refund_request_status" NOT NULL DEFAULT 'REQUESTED',
  "gateway_refund_reference" TEXT,
  "requested_by_id" UUID,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "refund_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "refund_requests_amount_chk" CHECK ("amount_minor" > 0),
  CONSTRAINT "refund_requests_reason_chk" CHECK (length(btrim("reason")) BETWEEN 1 AND 500),
  -- Exactly one source of the money: a booking item's allocation, or an unapplied late payment.
  CONSTRAINT "refund_requests_source_chk" CHECK (("booking_item_id" IS NULL) <> ("payment_reconciliation_id" IS NULL)),
  CONSTRAINT "refund_requests_not_executed_chk" CHECK ("status" IN ('REQUESTED', 'REJECTED') AND "gateway_refund_reference" IS NULL)
);

CREATE INDEX "refund_requests_payment_id_idx" ON "refund_requests"("payment_id");
CREATE INDEX "refund_requests_booking_item_id_idx" ON "refund_requests"("booking_item_id");

ALTER TABLE "refund_requests"
  ADD CONSTRAINT "refund_requests_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "refund_requests_booking_item_id_fkey" FOREIGN KEY ("booking_item_id") REFERENCES "booking_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "refund_requests_payment_reconciliation_id_fkey" FOREIGN KEY ("payment_reconciliation_id") REFERENCES "payment_reconciliations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "refund_requests_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Never more than was paid: an item's open requests ≤ what this payment allocated to it; a late
-- payment's ≤ its recorded amount. The source row is locked, so concurrent requests are checked
-- one at a time.
CREATE FUNCTION "refund_requests_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  pay RECORD;
  available NUMERIC;
  requested NUMERIC;
BEGIN
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

CREATE TRIGGER "refund_requests_guard_trg"
  BEFORE INSERT OR UPDATE ON "refund_requests"
  FOR EACH ROW EXECUTE FUNCTION "refund_requests_guard"();
