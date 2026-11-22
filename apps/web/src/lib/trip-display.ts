import type { CurrencyInfo, PaymentMethod, Quote, Trip, TripTotals } from "./api-types";
import { formatMoney } from "./money";

/**
 * Turns trip and quote responses into display rows. Every amount is formatted from the API's
 * string; the UI computes no money of its own (the API's totals are the source of truth).
 */

const kathmanduDate = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC", // service dates are calendar dates (YYYY-MM-DD); format them as such
  day: "numeric",
  month: "short",
  year: "numeric",
});

export function formatServiceDate(iso: string): string {
  return kathmanduDate.format(new Date(`${iso}T00:00:00Z`));
}

/** "10 Jan 2027 → 12 Jan 2027" for ranges ([start, end)), or one date. */
export function formatDateRange(start: string, end: string | null): string {
  return end ? `${formatServiceDate(start)} → ${formatServiceDate(end)}` : formatServiceDate(start);
}

export function paymentMethodLabel(method: PaymentMethod): string {
  return method === "pay_at_property" ? "Pay at the property" : "Pay online";
}

const STATUS_LABELS: Record<string, string> = {
  DRAFT: "Draft",
  PENDING: "Awaiting payment",
  CONFIRMED: "Confirmed",
  IN_PROGRESS: "In progress",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
  EXPIRED: "Expired",
  NO_SHOW: "No-show",
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

const PAYMENT_STATUS_LABELS: Record<string, string> = {
  UNPAID: "Unpaid",
  PARTIALLY_PAID: "Partly paid",
  PAID: "Paid",
  PAY_AT_PROPERTY: "Pay at the property",
  PAID_AT_PROPERTY: "Paid at the property",
  PARTIALLY_REFUNDED: "Partly refunded",
  REFUNDED: "Refunded",
};

export function paymentStatusLabel(status: string): string {
  return PAYMENT_STATUS_LABELS[status] ?? status;
}

export interface TotalsRow {
  label: string;
  value: string;
  emphasis?: boolean;
}

/** Trip/quote totals as labelled, formatted rows (zero-value split rows are left out). */
export function totalsRows(totals: TripTotals, money: CurrencyInfo): TotalsRow[] {
  const f = (minor: string) => formatMoney(minor, money.currency, money.currencyExponent);
  const rows: TotalsRow[] = [
    { label: "Subtotal", value: f(totals.subtotalMinor) },
    { label: "Service charge", value: f(totals.serviceChargeMinor) },
    { label: "VAT", value: f(totals.taxMinor) },
    { label: "Total", value: f(totals.totalMinor), emphasis: true },
  ];
  if (totals.payOnlineMinor !== "0")
    rows.push({ label: "Pay online", value: f(totals.payOnlineMinor) });
  if (totals.payAtPropertyMinor !== "0") {
    rows.push({ label: "Pay at the property", value: f(totals.payAtPropertyMinor) });
  }
  return rows;
}

export interface QuoteRow {
  key: string;
  title: string;
  dates: string;
  quantity: number;
  payment: string;
  subtotal: string;
  serviceCharge: string;
  tax: string;
  total: string;
  available: boolean;
  unavailableDates: string[];
  priceChanged: boolean;
  /** The price held when the item was added, when it differs from today's price. */
  heldTotal: string | null;
}

export function quoteRows(quote: Quote): QuoteRow[] {
  const f = (minor: string) => formatMoney(minor, quote.currency, quote.currencyExponent);
  return quote.lines.map((line, i) => ({
    key: line.itemId ?? `candidate-${line.candidateIndex ?? i}`,
    title: line.listing.title,
    dates: formatDateRange(line.startDate, line.endDate),
    quantity: line.quantity,
    payment: paymentMethodLabel(line.paymentMethod),
    subtotal: f(line.money.subtotalMinor),
    serviceCharge: f(line.money.serviceChargeMinor),
    tax: f(line.money.taxMinor),
    total: f(line.money.totalMinor),
    available: line.available,
    unavailableDates: line.unavailableDates,
    priceChanged: line.priceChanged,
    heldTotal: line.priceChanged && line.heldMoney ? f(line.heldMoney.totalMinor) : null,
  }));
}

/** What happened after "Confirm", from the trip the API returned. */
export function confirmOutcome(trip: Pick<Trip, "status" | "items">): string {
  if (trip.status === "CONFIRMED") return "Your trip is confirmed.";
  if (trip.status === "PENDING") {
    const atProperty = trip.items.filter(
      (i) => i.paymentMethod === "pay_at_property" && i.status === "CONFIRMED",
    ).length;
    const online = trip.items.filter(
      (i) => i.paymentMethod === "online" && i.status === "PENDING",
    ).length;
    const parts: string[] = [];
    if (atProperty > 0)
      parts.push(
        `${atProperty} pay-at-property item${atProperty === 1 ? " is" : "s are"} confirmed`,
      );
    if (online > 0) {
      parts.push(
        `${online} online item${online === 1 ? " is" : "s are"} reserved and waiting for online payment`,
      );
    }
    return parts.length > 0 ? `Submitted: ${parts.join("; ")}.` : "Submitted; waiting for payment.";
  }
  return `Trip status: ${statusLabel(trip.status)}.`;
}

/** A cancellation rule in plain words, e.g. "Cancel 72+ hours before the start: 100% refund". */
export function describeCancellationRule(rule: unknown): string {
  if (typeof rule !== "object" || rule === null) return String(rule);
  const r = rule as { minHoursBeforeStart?: unknown; refundBps?: unknown };
  if (typeof r.minHoursBeforeStart === "number" && typeof r.refundBps === "number") {
    const percent = r.refundBps / 100; // basis points → percent; a rate, not money
    const when =
      r.minHoursBeforeStart === 0
        ? "Cancel any time before the start"
        : `Cancel ${r.minHoursBeforeStart}+ hours before the start`;
    return `${when}: ${percent}% refund`;
  }
  return JSON.stringify(rule);
}

/** "durationMinutes" → "Duration minutes", for generic detail fields. */
export function humanizeKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A detail/attribute value as text (location objects show their name). */
export function detailValueText(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (Array.isArray(value)) return value.map(detailValueText).join(", ");
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "object") {
    const named = value as { name?: unknown };
    return typeof named.name === "string" ? named.name : JSON.stringify(value);
  }
  return String(value);
}
