/**
 * Money at the API boundary (ADR 0005).
 *
 * Inside the API, money is `bigint` minor units (BIGINT in PostgreSQL). JSON cannot carry
 * `bigint` (JSON.stringify throws) and JSON numbers lose precision above 2^53, so EVERY money
 * field leaves the API as a string of digits in minor units, e.g. "115500" = Rs 1,155.00.
 *
 * Every money-bearing object also carries `currency` (ISO 4217) and `currencyExponent`
 * (number of minor-unit digits: 2 for NPR → divide by 10^2 to display).
 *
 * Serialization is EXPLICIT (serializers call `minorToString`). There is deliberately no
 * global BigInt.prototype.toJSON patch: a forgotten conversion makes JSON.stringify throw,
 * the request fails with a generic 500, and tests catch it, instead of silently emitting
 * a value in an undocumented format.
 */

/** A non-negative whole number of minor units, as digits only. */
export const MINOR_AMOUNT_PATTERN = /^\d+$/;

export function minorToString(value: bigint): string {
  if (typeof value !== "bigint") {
    throw new TypeError(`money must be a bigint, got ${typeof value}`);
  }
  return value.toString();
}

export function nullableMinorToString(value: bigint | null): string | null {
  return value === null ? null : minorToString(value);
}

/** Minor-unit digits for an ISO 4217 code (NPR → 2, JPY → 0), from the runtime's ICU data. */
export function currencyExponent(currency: string): number {
  return (
    new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
      .maximumFractionDigits ?? 2
  );
}

export interface CurrencyInfo {
  currency: string;
  currencyExponent: number;
}

export function currencyInfo(currency: string): CurrencyInfo {
  return { currency, currencyExponent: currencyExponent(currency) };
}

/**
 * Converts values that JSON cannot represent faithfully, for NON-money data such as detail
 * tables: Date → ISO string, Prisma Decimal → string, bigint → string.
 */
export function toJsonSafe(value: unknown): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (typeof value === "object") {
    // Prisma.Decimal and similar numeric wrappers expose toFixed + toString.
    if ("toFixed" in value && typeof value.toFixed === "function") {
      return (value as { toString: () => string }).toString();
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, inner]) => [
        key,
        toJsonSafe(inner),
      ]),
    );
  }
  return value;
}
