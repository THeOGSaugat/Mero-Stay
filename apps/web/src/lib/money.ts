/**
 * Money in the web app (ADR 0010). The API sends every amount as a STRING of minor units plus
 * `currency` and `currencyExponent` (ADR 0005), e.g. "115500" + NPR + 2 = Rs 1,155.00.
 *
 * These helpers work on the digit string itself: they never convert money to a JS number, so
 * there is no float rounding and no precision loss above 2^53. The UI never does arithmetic on
 * money; every total it shows comes from the API.
 */

const DIGITS = /^\d+$/;

/** One or more digits; leading zeros allowed. Anything else is not a minor-unit string. */
export function isMinorString(value: unknown): value is string {
  return typeof value === "string" && DIGITS.test(value);
}

/** "1234567" → "12,34,567" (Nepali/Indian grouping: last three digits, then pairs). */
export function groupNepali(integerDigits: string): string {
  const digits = integerDigits.replace(/^0+(?=\d)/, "");
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  let rest = digits.slice(0, -3);
  const pairs: string[] = [];
  while (rest.length > 2) {
    pairs.unshift(rest.slice(-2));
    rest = rest.slice(0, -2);
  }
  if (rest) pairs.unshift(rest);
  return `${pairs.join(",")},${last3}`;
}

/** "1234567" → "1,234,567" (international grouping, for currencies other than NPR). */
export function groupThousands(integerDigits: string): string {
  const digits = integerDigits.replace(/^0+(?=\d)/, "");
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Splits minor units into integer and fraction digits: ("115500", 2) → ["1155", "00"]. */
export function splitMinor(minor: string, exponent: number): [string, string] {
  if (!isMinorString(minor)) throw new TypeError(`not a minor-unit string: ${String(minor)}`);
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 6) {
    throw new RangeError(`invalid currency exponent: ${exponent}`);
  }
  if (exponent === 0) return [minor.replace(/^0+(?=\d)/, ""), ""];
  const padded = minor.padStart(exponent + 1, "0");
  return [padded.slice(0, -exponent), padded.slice(-exponent)];
}

/**
 * Display text for an amount: NPR as "Rs 1,155.00" (Nepali grouping, e.g. "Rs 12,34,567.00");
 * any other currency as "USD 1,234.50".
 */
export function formatMoney(minor: string, currency: string, exponent: number): string {
  const [integer, fraction] = splitMinor(minor, exponent);
  const grouped = currency === "NPR" ? groupNepali(integer) : groupThousands(integer);
  const amount = fraction ? `${grouped}.${fraction}` : grouped;
  return currency === "NPR" ? `Rs ${amount}` : `${currency} ${amount}`;
}

/** Formats `{ <field>Minor, currency, currencyExponent }`-style API values. */
export function formatAmount(
  minor: string | null | undefined,
  money: { currency: string; currencyExponent: number },
): string {
  if (minor === null || minor === undefined) return "—";
  return formatMoney(minor, money.currency, money.currencyExponent);
}

/**
 * Turns what a person typed in a price field ("1,500" or "1500.5") into minor units
 * ("150000", "150050") for an API query, using string operations only. Returns null for
 * anything that is not a non-negative amount with at most `exponent` decimals.
 */
export function majorInputToMinor(input: string, exponent: number): string | null {
  const cleaned = input.trim().replace(/,/g, "");
  if (cleaned === "") return null;
  const match = /^(\d+)(?:\.(\d*))?$/.exec(cleaned);
  if (!match) return null;
  const integer = match[1] ?? "0";
  const fraction = match[2] ?? "";
  if (fraction.length > exponent) return null;
  const minor = `${integer}${fraction.padEnd(exponent, "0")}`.replace(/^0+(?=\d)/, "");
  return minor.length > 19 ? null : minor; // the API's BIGINT limit
}
