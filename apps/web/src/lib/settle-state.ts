/**
 * "Paid at the property" (POST /partner/bookings/:itemId/settle-at-property) as UI state.
 *
 * The API needs an `Idempotency-Key` and applies a key only once: a retry with the same key
 * returns the first result (`replayed: true`) without settling again (ADR 0008). So the UI:
 *
 * - creates ONE key per settle attempt and keeps it until the API answers with success, so
 *   "Try again" after a lost response or a network error re-sends the SAME key and is safe;
 * - ignores clicks while a request is in flight (no double send);
 * - shows success once. A replay of our own key is the same success, not a second one.
 */

export type SettleState =
  | { phase: "idle"; key: string | null }
  | { phase: "sending"; key: string }
  | { phase: "failed"; key: string; message: string }
  | { phase: "done"; key: null; replayed: boolean };

export type SettleAction =
  | { type: "start"; newKey: () => string }
  | { type: "succeeded"; replayed: boolean }
  | { type: "failed"; message: string };

export const INITIAL_SETTLE_STATE: SettleState = { phase: "idle", key: null };

export function settleReducer(state: SettleState, action: SettleAction): SettleState {
  switch (action.type) {
    case "start":
      // In flight, or already settled: nothing to send.
      if (state.phase === "sending" || state.phase === "done") return state;
      return { phase: "sending", key: state.key ?? action.newKey() };
    case "succeeded":
      if (state.phase !== "sending") return state;
      return { phase: "done", key: null, replayed: action.replayed };
    case "failed":
      if (state.phase !== "sending") return state;
      // Keep the key: the request may have reached the API, and a retry must not apply twice.
      return { phase: "failed", key: state.key, message: action.message };
  }
}

/** A fresh Idempotency-Key (8–128 of A–Z a–z 0–9 _ -). */
export function newSettleKey(
  itemId: string,
  random: () => string = () => crypto.randomUUID(),
): string {
  return `settle-${itemId.slice(0, 8)}-${random()}`.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 128);
}

/** The line shown after the action finished. */
export function settleOutcomeText(state: SettleState): string | null {
  if (state.phase !== "done") return null;
  return state.replayed
    ? "Payment received at the property is recorded. (Your earlier attempt had already gone through; it was recorded once.)"
    : "Payment received at the property is recorded.";
}

/** Statuses in which a pay-at-property booking can be settled (mirrors the API's rule). */
const SETTLEABLE_STATUSES = ["CONFIRMED", "IN_PROGRESS", "COMPLETED"];

/** Whether to offer the action. The API decides anyway (422 / 409 otherwise). */
export function canSettleAtProperty(booking: { status: string; paymentStatus: string }): boolean {
  return (
    booking.paymentStatus === "PAY_AT_PROPERTY" && SETTLEABLE_STATUSES.includes(booking.status)
  );
}
