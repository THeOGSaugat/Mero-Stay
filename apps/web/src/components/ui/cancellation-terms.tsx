import {
  NO_POLICY_BOOKING,
  NO_POLICY_LISTING,
  policySummary,
  sourceLabel,
  termLines,
  type PolicyTerms,
} from "@/lib/cancellation-policy";

/**
 * The cancellation terms of a listing (the policy that applies now) or of a booking (its frozen
 * copy). A missing policy is said out loud, never left blank (gap 23).
 */
export function CancellationTerms({
  terms,
  context,
  headingLevel = 2,
}: {
  terms: PolicyTerms | null | undefined;
  /** "listing": the current policy; "booking": the copy fixed when it was booked. */
  context: "listing" | "booking";
  headingLevel?: 2 | 3;
}) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  if (!terms) {
    return (
      <section
        className="rounded-card border border-line p-4"
        data-testid="cancellation-terms"
        data-state="none"
      >
        <Heading className="text-base font-semibold text-primary">Cancellation</Heading>
        <p className="mt-1 text-sm text-slate-700" data-testid="no-cancellation-policy">
          {context === "listing" ? NO_POLICY_LISTING : NO_POLICY_BOOKING}
        </p>
      </section>
    );
  }
  const source = context === "listing" ? sourceLabel(terms.source) : null;
  return (
    <section
      className="rounded-card border border-line p-4"
      data-testid="cancellation-terms"
      data-state="set"
    >
      <Heading className="text-base font-semibold text-primary">
        Cancellation{terms.name ? `: ${terms.name}` : ""}
      </Heading>
      <p className="mt-1 text-sm font-medium text-ink" data-testid="cancellation-summary">
        {policySummary(terms)}
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink">
        {termLines(terms).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {terms.description ? <p className="mt-2 text-sm text-muted">{terms.description}</p> : null}
      <p className="mt-2 text-xs text-slate-500">
        {context === "booking"
          ? "These terms were fixed when this was booked; later changes to the policy do not apply."
          : (source ?? "")}
      </p>
    </section>
  );
}
