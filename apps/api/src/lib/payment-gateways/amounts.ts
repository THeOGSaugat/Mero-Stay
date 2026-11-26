/**
 * Gateway units ⇄ paisa (ADR 0017). Only adapters use these; core logic is `bigint` paisa.
 * String arithmetic only: no float ever holds money (CLAUDE.md §3.5).
 */

/** 11000n → "110"; 10050n → "100.50" (eSewa's total_amount is rupees as text). */
export function paisaToRupees(paisa: bigint): string {
  if (paisa < 0n) throw new RangeError("amount must not be negative");
  const whole = paisa / 100n;
  const fraction = paisa % 100n;
  return fraction === 0n ? whole.toString() : `${whole}.${fraction.toString().padStart(2, "0")}`;
}

/**
 * Rupees as a gateway writes them → paisa, or null when it is not a valid amount.
 * Accepts "110", "110.0", "1,000.0" (eSewa's callback) and JSON numbers like 100.0 (eSewa's
 * status API). More than 2 decimals, negatives, exponents and garbage are refused.
 */
export function rupeesToPaisa(value: unknown): bigint | null {
  let text: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0 || value > 1e12) return null;
    // A JSON number with at most 2 decimals; toFixed(3) exposes a third one if present.
    const three = value.toFixed(3);
    if (!three.endsWith("0")) return null;
    text = value.toFixed(2);
  } else if (typeof value === "string") {
    text = value.trim().replace(/,(?=\d{2,3}(\D|$))/g, "");
  } else {
    return null;
  }
  const match = /^(\d{1,13})(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return null;
  const [, whole = "0", fraction = ""] = match;
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
}

/** Khalti's paisa (a JSON integer, or digits as text) → bigint, or null. */
export function khaltiPaisa(value: unknown): bigint | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  }
  if (typeof value === "string" && /^\d{1,15}$/.test(value.trim())) return BigInt(value.trim());
  return null;
}
