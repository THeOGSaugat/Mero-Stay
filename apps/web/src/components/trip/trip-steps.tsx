import { stepStates, TRIP_STEPS, type TripStepIndex } from "@/lib/trip-steps";
import { IconCheck } from "../ui/icons";

/** A compact progress bar for the trip pages (presentation only). */
export function TripSteps({
  current,
  finished = false,
}: {
  current: TripStepIndex;
  finished?: boolean;
}) {
  const states = stepStates(current, finished);
  return (
    <nav aria-label="Booking steps" className="mb-6">
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-2 text-sm">
        {TRIP_STEPS.map((label, i) => {
          const state = states[i];
          return (
            <li
              key={label}
              className="flex items-center gap-2"
              aria-current={state === "current" ? "step" : undefined}
            >
              <span
                className={`flex size-7 items-center justify-center rounded-full text-xs font-bold ${
                  state === "done"
                    ? "bg-primary text-white"
                    : state === "current"
                      ? "bg-accent-strong text-white"
                      : "bg-surface text-muted ring-1 ring-line"
                }`}
              >
                {state === "done" ? <IconCheck className="size-4" /> : i + 1}
              </span>
              <span className={state === "upcoming" ? "text-muted" : "font-semibold text-primary"}>
                {label}
                {state === "done" ? <span className="sr-only"> (done)</span> : null}
              </span>
              {i < TRIP_STEPS.length - 1 ? (
                <span aria-hidden="true" className="mx-1 h-px w-6 bg-line" />
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
