import { AppError } from "./errors.js";

/**
 * Turns PostgreSQL constraint violations (raised through Prisma's driver adapter) into clean API
 * errors. The raw error contains the failing row ("Failing row contains (...)"), which must never
 * reach a client, so callers only ever see the mapped code and a generic message.
 */

export interface DatabaseErrorInfo {
  /** PostgreSQL SQLSTATE, e.g. "23514" (check_violation), "23505" (unique_violation). */
  sqlState: string | undefined;
  /** Name of the violated constraint, when PostgreSQL reports one. */
  constraint: string | undefined;
}

interface AdapterCause {
  originalCode?: unknown;
  code?: unknown;
  originalMessage?: unknown;
  message?: unknown;
  constraint?: unknown;
}

function causeOf(err: unknown): AdapterCause | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const meta = (err as { meta?: unknown }).meta;
  if (typeof meta !== "object" || meta === null) return undefined;
  const adapterError = (meta as { driverAdapterError?: unknown }).driverAdapterError;
  if (typeof adapterError !== "object" || adapterError === null) return undefined;
  const cause = (adapterError as { cause?: unknown }).cause;
  return typeof cause === "object" && cause !== null ? cause : undefined;
}

export function inspectDatabaseError(err: unknown): DatabaseErrorInfo | null {
  const cause = causeOf(err);
  if (!cause) return null;

  const sqlState =
    typeof cause.originalCode === "string"
      ? cause.originalCode
      : typeof cause.code === "string"
        ? cause.code
        : undefined;

  let constraint: string | undefined;
  const reported = cause.constraint;
  if (typeof reported === "object" && reported !== null) {
    const { index, name } = reported as { index?: unknown; name?: unknown };
    if (typeof index === "string") constraint = index;
    else if (typeof name === "string") constraint = name;
  }
  if (!constraint) {
    const message =
      typeof cause.originalMessage === "string"
        ? cause.originalMessage
        : typeof cause.message === "string"
          ? cause.message
          : "";
    constraint = /constraint "([^"]+)"/.exec(message)?.[1];
  }

  return { sqlState, constraint };
}

const OVERBOOKING_CONSTRAINT = "inventory_slots_no_overbooking_chk";
/** Gap 22 guard (ADR 0013): the listing's type is not mapped to its provider's type. */
const LISTING_TYPE_RULE_CONSTRAINT = "listings_listing_type_allowed_chk";
/** Payment, allocation and invoice guards (ADR 0007). Checked before the generic money prefixes. */
const PAYMENT_CONSTRAINT_PREFIXES = [
  "payments_",
  "payment_allocations_",
  "provider_invoices_",
  "booking_items_payment_",
  "booking_items_paid_",
  "booking_items_invoice",
];
const MONEY_CONSTRAINT_PREFIXES = ["booking_items_", "booking_item_slots_", "trips_"];

/** Maps a database error to an AppError, or returns null if it is not a known constraint violation. */
export function mapDatabaseError(err: unknown): AppError | null {
  const info = inspectDatabaseError(err);
  if (!info) return null;
  const { sqlState, constraint } = info;

  if (sqlState === "23514" && constraint === OVERBOOKING_CONSTRAINT) {
    return new AppError(
      409,
      "INSUFFICIENT_AVAILABILITY",
      "Not enough availability for the requested dates and quantity.",
    );
  }
  if (sqlState === "23514" && constraint === LISTING_TYPE_RULE_CONSTRAINT) {
    return new AppError(
      422,
      "LISTING_TYPE_NOT_ALLOWED",
      "This kind of business cannot list this type.",
    );
  }
  // Phase 12 (ADR 0018). Checked before the generic money prefixes ("booking_items_").
  if (sqlState === "23514" && constraint === "users_last_admin_chk") {
    return new AppError(409, "LAST_ADMIN", "At least one active admin must remain.");
  }
  if (sqlState === "23514" && constraint === "listings_approval_type_rule_chk") {
    return new AppError(
      422,
      "LISTING_TYPE_NOT_ALLOWED",
      "This listing's type is not allowed for this kind of business, so it cannot be approved.",
    );
  }
  if (
    sqlState === "23514" &&
    constraint &&
    (constraint.startsWith("payouts_") ||
      constraint === "booking_items_payout_link_chk" ||
      constraint === "booking_items_payout_paid_chk")
  ) {
    return new AppError(
      409,
      "PAYOUT_STATE_CONFLICT",
      "The payout cannot change that way in its current state.",
    );
  }
  // Phase 14 (ADR 0020): refund execution, clawbacks, settlement resolutions. Checked before the
  // generic money prefixes ("booking_items_").
  if (
    sqlState === "23514" &&
    constraint &&
    [
      "refund_requests_transition_chk",
      "refund_requests_final_chk",
      "refund_requests_immutable_chk",
      "refund_requests_kept_chk",
      "refund_requests_status_fields_chk",
    ].includes(constraint)
  ) {
    return new AppError(
      409,
      "REFUND_STATE_CONFLICT",
      "The refund cannot change that way in its current state.",
    );
  }
  if (sqlState === "23505" && constraint === "refund_requests_one_processing_per_payment") {
    return new AppError(
      409,
      "REFUND_IN_PROGRESS",
      "Another refund of this payment is being processed. Finish it first.",
    );
  }
  if (sqlState === "23514" && constraint === "booking_items_refunds_match_chk") {
    return new AppError(
      422,
      "PAYMENT_INVARIANT_VIOLATED",
      "The refund amounts failed a consistency check and were not saved.",
    );
  }
  if (
    sqlState === "23514" &&
    (constraint?.startsWith("provider_clawback") ||
      constraint?.startsWith("settlement_reconciliation"))
  ) {
    return new AppError(
      409,
      "CLAWBACK_STATE_CONFLICT",
      "The clawback or reconciliation record cannot change that way.",
    );
  }
  if (
    sqlState === "23514" &&
    (constraint?.startsWith("provider_invoice_adjustments_") ||
      constraint === "booking_items_void_chk")
  ) {
    return new AppError(
      409,
      "VOID_STATE_CONFLICT",
      "The booking or invoice cannot change that way in its current state.",
    );
  }
  if (
    sqlState === "23514" &&
    constraint &&
    PAYMENT_CONSTRAINT_PREFIXES.some((p) => constraint.startsWith(p))
  ) {
    // Payments are computed and locked on the server, so this means a bug or a race the database
    // stopped: nothing was charged, allocated or invoiced twice.
    return new AppError(
      422,
      "PAYMENT_INVARIANT_VIOLATED",
      "The payment amounts failed a consistency check and were not saved.",
    );
  }
  if (
    sqlState === "23514" &&
    constraint &&
    MONEY_CONSTRAINT_PREFIXES.some((p) => constraint.startsWith(p))
  ) {
    // The API computes every amount itself, so this means a server-side bug, never bad input.
    return new AppError(
      422,
      "PRICING_INVARIANT_VIOLATED",
      "The booking amounts failed a consistency check and were not saved.",
    );
  }
  // Cancellation policies (ADR 0015): the API checks these first; the database is the backstop.
  if (sqlState === "23514" && constraint === "cancellation_policies_in_use_chk") {
    return new AppError(
      409,
      "CANCELLATION_POLICY_IN_USE",
      "This policy is in use. Choose another policy for those listings (and the default) first.",
    );
  }
  if (sqlState === "23514" && constraint === "cancellation_policies_attach_chk") {
    return new AppError(
      422,
      "CANCELLATION_POLICY_NOT_USABLE",
      "That cancellation policy cannot be used here (switched off, or not this business's).",
    );
  }
  if (sqlState === "23514" && constraint === "cancellation_policies_rules_valid_chk") {
    return new AppError(422, "INVALID_CANCELLATION_RULES", "The cancellation rule is not valid.");
  }
  // Verification documents (ADR 0016): status moves, tombstones and stored files are fixed.
  if (sqlState === "23514" && constraint?.startsWith("provider_documents_")) {
    return new AppError(
      409,
      "DOCUMENT_STATE_CONFLICT",
      "The document cannot change that way in its current state.",
    );
  }
  // Refund requests and late payments (ADR 0017): the API checks first; the database is the backstop.
  if (sqlState === "23514" && constraint === "refund_requests_within_payment_chk") {
    return new AppError(422, "REFUND_EXCEEDS_PAID", "This refund is more than was paid.");
  }
  if (sqlState === "23514" && constraint === "payment_reconciliations_immutable_chk") {
    return new AppError(
      409,
      "RECONCILIATION_STATE_CONFLICT",
      "This late payment record cannot change that way.",
    );
  }
  if (sqlState === "23514") {
    return new AppError(422, "CONSTRAINT_VIOLATED", "The request violates a data rule.");
  }
  if (sqlState === "23505") {
    return new AppError(
      409,
      "CONFLICT",
      "The resource already exists or was changed concurrently.",
    );
  }
  if (sqlState === "40001" || sqlState === "40P01") {
    return new AppError(
      409,
      "CONCURRENT_UPDATE",
      "The request conflicted with another change. Retry.",
    );
  }
  return null;
}
