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
