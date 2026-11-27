/**
 * The trip's progress as the customer sees it (Phase 13 design, "step-by-step"): presentation
 * only, worked out from state the pages already have. Nothing here changes what can be done.
 */
export const TRIP_STEPS = ["Build your trip", "Check the quote", "Confirm", "Pay"] as const;
export type TripStepIndex = 0 | 1 | 2 | 3;

export function tripStep(input: {
  /** The trip's status from the API. */
  status: string;
  /** A quote is on screen (trip builder). */
  hasQuote?: boolean;
  /** Something is still due online. */
  dueOnline?: boolean;
}): TripStepIndex {
  if (input.status === "DRAFT") return input.hasQuote ? 1 : 0;
  if (input.status === "PENDING") return input.dueOnline ? 3 : 2;
  return 3;
}

/** Each step's state for display: done, current or upcoming. */
export function stepStates(
  current: TripStepIndex,
  finished = false,
): ("done" | "current" | "upcoming")[] {
  return TRIP_STEPS.map((_, i) =>
    i < current || (finished && i === current) ? "done" : i === current ? "current" : "upcoming",
  );
}
