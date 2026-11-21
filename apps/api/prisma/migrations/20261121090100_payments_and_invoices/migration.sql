-- Phase 5 (ADR 0007): payment intents and allocations, commission invoices for pay-at-property
-- items. The database re-checks every cross-row money rule, so an application bug or a concurrent
-- request can never over-allocate a payment, over-pay an item or issue a wrong invoice.
--
-- Guard triggers raise check_violation (23514) naming their constraint both in CONSTRAINT and in the
-- message ('violates check constraint "<name>"', the wording of PostgreSQL's own CHECK errors; the
-- pg driver adapter forwards only the message), so the API maps them centrally
-- (lib/database-errors.ts) exactly like CHECK constraints and never leaks PostgreSQL text.

-- ============================================================================
-- payments: intent fingerprint, captured amount, one open charge per trip
-- ============================================================================

ALTER TABLE "payments"
  ADD COLUMN "captured_minor" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "intent_fingerprint" CHAR(64);

ALTER TABLE "payments"
  -- Money is captured exactly when the payment succeeds, and never more than was requested.
  ADD CONSTRAINT "payments_captured_chk" CHECK (
    "captured_minor" >= 0
    AND "captured_minor" <= "amount_minor"
    AND (("status" = 'SUCCEEDED') = ("captured_minor" > 0))),
  ADD CONSTRAINT "payments_completed_at_chk" CHECK (
    "status" NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED') OR "completed_at" IS NOT NULL),
  ADD CONSTRAINT "payments_fingerprint_hex_chk" CHECK (
    "intent_fingerprint" IS NULL OR "intent_fingerprint" ~ '^[0-9a-f]{64}$');

-- At most one open (not yet finished) charge per trip: two intents for the same trip cannot exist.
CREATE UNIQUE INDEX "payments_one_open_charge_per_trip" ON "payments"("trip_id")
  WHERE (kind = 'CHARGE' AND (status = 'INITIATED' OR status = 'PENDING'));

-- Finished payments are immutable: a succeeded charge cannot be captured twice or changed later.
CREATE FUNCTION "payments_status_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" IN ('SUCCEEDED', 'FAILED', 'CANCELLED') AND (
       NEW."status" IS DISTINCT FROM OLD."status"
    OR NEW."amount_minor" IS DISTINCT FROM OLD."amount_minor"
    OR NEW."captured_minor" IS DISTINCT FROM OLD."captured_minor"
    OR NEW."currency" IS DISTINCT FROM OLD."currency"
    OR NEW."trip_id" IS DISTINCT FROM OLD."trip_id"
    OR NEW."kind" IS DISTINCT FROM OLD."kind") THEN
    RAISE EXCEPTION 'violates check constraint "payments_finished_immutable_chk": a finished payment cannot change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'payments_finished_immutable_chk';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "payments_status_guard_trg"
  BEFORE UPDATE ON "payments"
  FOR EACH ROW EXECUTE FUNCTION "payments_status_guard"();

-- ============================================================================
-- payment_allocations: never more than the payment captured, never more than the item costs
-- ============================================================================

CREATE FUNCTION "payment_allocations_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  pay RECORD;
  item RECORD;
  payment_allocated NUMERIC;
  item_allocated NUMERIC;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'violates check constraint "payment_allocations_immutable_chk": payment allocations are immutable'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'payment_allocations_immutable_chk';
  END IF;

  -- Lock the payment and the item, so concurrent allocations touching either are checked one at
  -- a time; each sum below then sees every committed allocation.
  SELECT "trip_id", "kind", "status", "currency", "captured_minor" INTO pay
    FROM "payments" WHERE "id" = NEW."payment_id" FOR UPDATE;
  SELECT "trip_id", "currency", "total_minor", "payment_status" INTO item
    FROM "booking_items" WHERE "id" = NEW."booking_item_id" FOR UPDATE;

  IF pay."kind" <> 'CHARGE' OR pay."status" <> 'SUCCEEDED' THEN
    RAISE EXCEPTION 'violates check constraint "payment_allocations_succeeded_charge_chk": only a succeeded charge can be allocated'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'payment_allocations_succeeded_charge_chk';
  END IF;
  IF pay."trip_id" <> item."trip_id" OR pay."currency" <> item."currency" THEN
    RAISE EXCEPTION 'violates check constraint "payment_allocations_same_trip_chk": allocation must stay within one trip and currency'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'payment_allocations_same_trip_chk';
  END IF;
  IF item."payment_status" IN ('PAY_AT_PROPERTY', 'PAID_AT_PROPERTY') THEN
    RAISE EXCEPTION 'violates check constraint "payment_allocations_online_item_chk": pay-at-property items are not paid online'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'payment_allocations_online_item_chk';
  END IF;

  SELECT COALESCE(SUM("amount_minor"), 0) + NEW."amount_minor" INTO payment_allocated
    FROM "payment_allocations" WHERE "payment_id" = NEW."payment_id";
  IF payment_allocated > pay."captured_minor" THEN
    RAISE EXCEPTION 'violates check constraint "payment_allocations_within_payment_chk": allocations exceed the captured amount'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'payment_allocations_within_payment_chk';
  END IF;

  SELECT COALESCE(SUM(a."amount_minor"), 0) + NEW."amount_minor" INTO item_allocated
    FROM "payment_allocations" a
    JOIN "payments" p ON p."id" = a."payment_id"
    WHERE a."booking_item_id" = NEW."booking_item_id"
      AND p."kind" = 'CHARGE' AND p."status" = 'SUCCEEDED';
  IF item_allocated > item."total_minor" THEN
    RAISE EXCEPTION 'violates check constraint "payment_allocations_within_item_chk": allocations exceed the item total'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'payment_allocations_within_item_chk';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "payment_allocations_guard_trg"
  BEFORE INSERT OR UPDATE OR DELETE ON "payment_allocations"
  FOR EACH ROW EXECUTE FUNCTION "payment_allocations_guard"();

-- ============================================================================
-- booking_items: payment status must match the allocations; money is never expired
-- ============================================================================

ALTER TABLE "booking_items"
  -- INVOICED commission always has a real invoice behind it (closes the Phase 3 gap).
  ADD CONSTRAINT "booking_items_invoiced_has_invoice_chk" CHECK (
    "commission_status" <> 'INVOICED' OR "commission_invoice_id" IS NOT NULL),
  -- Settling at the property happens only for a confirmed booking.
  ADD CONSTRAINT "booking_items_paid_at_property_confirmed_chk" CHECK (
    "payment_status" <> 'PAID_AT_PROPERTY' OR "status" IN ('CONFIRMED', 'IN_PROGRESS', 'COMPLETED')),
  -- A fully paid item is confirmed, never left waiting.
  ADD CONSTRAINT "booking_items_paid_not_pending_chk" CHECK (
    "payment_status" <> 'PAID' OR "status" <> 'PENDING'),
  -- The hold-release job must never expire an item that holds the customer's money.
  ADD CONSTRAINT "booking_items_paid_never_expires_chk" CHECK (
    "payment_status" NOT IN ('PARTIALLY_PAID', 'PAID') OR "status" <> 'EXPIRED');

CREATE FUNCTION "booking_items_payment_status_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  allocated NUMERIC;
BEGIN
  IF NEW."payment_status" IN ('UNPAID', 'PARTIALLY_PAID', 'PAID') THEN
    SELECT COALESCE(SUM(a."amount_minor"), 0) INTO allocated
      FROM "payment_allocations" a
      JOIN "payments" p ON p."id" = a."payment_id"
      WHERE a."booking_item_id" = NEW."id"
        AND p."kind" = 'CHARGE' AND p."status" = 'SUCCEEDED';
    IF (NEW."payment_status" = 'UNPAID' AND allocated <> 0)
       OR (NEW."payment_status" = 'PARTIALLY_PAID'
           AND NOT (allocated > 0 AND allocated < NEW."total_minor"))
       OR (NEW."payment_status" = 'PAID' AND allocated <> NEW."total_minor") THEN
      RAISE EXCEPTION 'violates check constraint "booking_items_payment_matches_allocations_chk": payment status does not match the allocated amount'
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'booking_items_payment_matches_allocations_chk';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "booking_items_payment_status_guard_trg"
  BEFORE INSERT OR UPDATE OF "payment_status", "total_minor" ON "booking_items"
  FOR EACH ROW EXECUTE FUNCTION "booking_items_payment_status_guard"();

-- ============================================================================
-- provider_invoices: one live invoice per trip and provider; amount = linked commission
-- ============================================================================

ALTER TABLE "provider_invoices" ADD COLUMN "trip_id" UUID;

CREATE INDEX "provider_invoices_trip_id_idx" ON "provider_invoices"("trip_id");

-- Retries and concurrent confirms can never create a second invoice for the same commission.
CREATE UNIQUE INDEX "provider_invoices_one_live_per_trip_provider"
  ON "provider_invoices"("trip_id", "provider_id")
  WHERE (trip_id IS NOT NULL AND status <> 'VOID');

ALTER TABLE "provider_invoices" ADD CONSTRAINT "provider_invoices_trip_id_fkey"
  FOREIGN KEY ("trip_id") REFERENCES "trips"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "provider_invoices"
  ADD CONSTRAINT "provider_invoices_issued_at_chk" CHECK (
    "status" NOT IN ('ISSUED', 'PAID') OR "issued_at" IS NOT NULL),
  ADD CONSTRAINT "provider_invoices_paid_at_chk" CHECK ("status" <> 'PAID' OR "paid_at" IS NOT NULL);

CREATE FUNCTION "provider_invoices_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  linked_commission NUMERIC;
  linked_items INT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Items are linked to a DRAFT; issuing it checks the amount.
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'violates check constraint "provider_invoices_created_as_draft_chk": an invoice is created as DRAFT'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'provider_invoices_created_as_draft_chk';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status" <> 'DRAFT' AND (
       NEW."amount_minor" IS DISTINCT FROM OLD."amount_minor"
    OR NEW."currency" IS DISTINCT FROM OLD."currency"
    OR NEW."provider_id" IS DISTINCT FROM OLD."provider_id"
    OR NEW."trip_id" IS DISTINCT FROM OLD."trip_id"
    OR NEW."number" IS DISTINCT FROM OLD."number") THEN
    RAISE EXCEPTION 'violates check constraint "provider_invoices_issued_immutable_chk": an issued invoice cannot change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'provider_invoices_issued_immutable_chk';
  END IF;

  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
       (OLD."status" = 'DRAFT' AND NEW."status" IN ('ISSUED', 'VOID'))
    OR (OLD."status" = 'ISSUED' AND NEW."status" IN ('PAID', 'VOID'))) THEN
    RAISE EXCEPTION 'violates check constraint "provider_invoices_status_transition_chk": invalid invoice status change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'provider_invoices_status_transition_chk';
  END IF;

  IF OLD."status" = 'DRAFT' AND NEW."status" = 'ISSUED' THEN
    SELECT COALESCE(SUM("commission_minor"), 0), COUNT(*) INTO linked_commission, linked_items
      FROM "booking_items" WHERE "commission_invoice_id" = NEW."id";
    IF linked_items = 0 OR linked_commission <> NEW."amount_minor" THEN
      RAISE EXCEPTION 'violates check constraint "provider_invoices_amount_matches_items_chk": invoice amount must equal the commission of its items'
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'provider_invoices_amount_matches_items_chk';
    END IF;
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "provider_invoices_guard_trg"
  BEFORE INSERT OR UPDATE ON "provider_invoices"
  FOR EACH ROW EXECUTE FUNCTION "provider_invoices_guard"();

-- Items join (or leave) only a DRAFT invoice of the same provider, trip and currency, and only
-- pay-at-property items are invoiced. Once issued, an invoice's items and their commission are fixed.
CREATE FUNCTION "booking_items_invoice_link_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  inv RECORD;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."commission_invoice_id" IS NOT NULL AND (
       NEW."commission_invoice_id" IS DISTINCT FROM OLD."commission_invoice_id"
    OR NEW."commission_minor" IS DISTINCT FROM OLD."commission_minor") THEN
    SELECT "status" INTO inv FROM "provider_invoices"
      WHERE "id" = OLD."commission_invoice_id" FOR UPDATE;
    IF inv."status" NOT IN ('DRAFT', 'VOID') THEN
      RAISE EXCEPTION 'violates check constraint "booking_items_invoice_link_chk": items of an issued invoice cannot change'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'booking_items_invoice_link_chk';
    END IF;
  END IF;

  IF NEW."commission_invoice_id" IS NOT NULL AND (
       TG_OP = 'INSERT' OR NEW."commission_invoice_id" IS DISTINCT FROM OLD."commission_invoice_id") THEN
    SELECT "status", "provider_id", "trip_id", "currency" INTO inv FROM "provider_invoices"
      WHERE "id" = NEW."commission_invoice_id" FOR UPDATE;
    IF inv."status" <> 'DRAFT'
       OR inv."provider_id" <> NEW."provider_id"
       OR inv."currency" <> NEW."currency"
       OR (inv."trip_id" IS NOT NULL AND inv."trip_id" <> NEW."trip_id")
       OR NEW."payment_status" NOT IN ('PAY_AT_PROPERTY', 'PAID_AT_PROPERTY') THEN
      RAISE EXCEPTION 'violates check constraint "booking_items_invoice_link_chk": item does not belong on this invoice'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'booking_items_invoice_link_chk';
    END IF;
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "booking_items_invoice_link_guard_trg"
  BEFORE INSERT OR UPDATE OF "commission_invoice_id", "commission_minor" ON "booking_items"
  FOR EACH ROW EXECUTE FUNCTION "booking_items_invoice_link_guard"();
