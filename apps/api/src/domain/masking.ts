/**
 * Masking for personal and financial data shown to someone other than its owner (ADR 0008).
 *
 * - Bank account numbers are NEVER returned in full by any endpoint: only the last 4 characters.
 * - A partner sees a customer's name, but their email and phone only masked: enough to recognise
 *   a guest at check-in, not enough to contact or profile them outside MeroStay.
 */

const MASK = "••••";

/** "0123456789012" → "••••9012". Four characters or fewer are fully masked. */
export function maskAccountNumber(accountNumber: string): string {
  const compact = accountNumber.replace(/\s+/g, "");
  return compact.length <= 4 ? MASK : `${MASK}${compact.slice(-4)}`;
}

/** "sita.sharma@example.com" → "s•••@e•••.com". */
export function maskEmail(email: string | null): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at <= 0) return MASK;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : "";
  return `${local[0] ?? ""}•••@${host[0] ?? ""}•••${tld}`;
}

/** "+9779812345678" → "+977••••••5678" (country code and last 4 digits kept). */
export function maskPhone(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/[^\d+]/g, "");
  if (digits.length <= 4) return MASK;
  const country = digits.startsWith("+977") ? "+977" : digits.startsWith("+") ? "+" : "";
  const rest = digits.slice(country.length);
  return `${country}${"•".repeat(Math.max(rest.length - 4, 2))}${rest.slice(-4)}`;
}
