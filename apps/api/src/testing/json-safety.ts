/**
 * Walks a parsed JSON response and returns every money-boundary violation:
 * - a field ending in "Minor" that is not a digit string (e.g. a JSON number), or
 * - a money-bearing object (one with *Minor fields) without `currency`/`currencyExponent`
 *   on itself or an ancestor.
 */
export function moneyBoundaryViolations(value: unknown, path = "$", hasCurrency = false): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, i) =>
      moneyBoundaryViolations(entry, `${path}[${i}]`, hasCurrency),
    );
  }
  if (typeof value !== "object" || value === null) return [];

  const record = value as Record<string, unknown>;
  const currencyHere =
    hasCurrency ||
    (typeof record.currency === "string" && typeof record.currencyExponent === "number");

  const problems: string[] = [];
  for (const [key, inner] of Object.entries(record)) {
    if (key.endsWith("Minor")) {
      if (typeof inner !== "string" || !/^\d+$/.test(inner)) {
        problems.push(`${path}.${key} is ${JSON.stringify(inner)} (must be a digit string)`);
      }
      if (!currencyHere) problems.push(`${path}.${key} has no currency/currencyExponent in scope`);
    } else {
      problems.push(...moneyBoundaryViolations(inner, `${path}.${key}`, currencyHere));
    }
  }
  return problems;
}

/** Number of *Minor fields found (to prove a test really inspected money). */
export function countMoneyFields(value: unknown): number {
  if (Array.isArray(value))
    return value.reduce<number>((n, entry) => n + countMoneyFields(entry), 0);
  if (typeof value !== "object" || value === null) return 0;
  return Object.entries(value as Record<string, unknown>).reduce(
    (n, [key, inner]) => n + (key.endsWith("Minor") ? 1 : countMoneyFields(inner)),
    0,
  );
}
