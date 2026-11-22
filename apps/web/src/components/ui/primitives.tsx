import type { ReactNode } from "react";

/** Small shared building blocks. Colours come from the design tokens in globals.css. */

export const buttonPrimary =
  "inline-flex min-h-11 items-center justify-center rounded-lg bg-navy px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-navy-dark focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal disabled:cursor-not-allowed disabled:opacity-60";

export const buttonSecondary =
  "inline-flex min-h-11 items-center justify-center rounded-lg border border-navy/30 bg-white px-5 py-2.5 text-sm font-semibold text-navy hover:bg-mist focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal disabled:cursor-not-allowed disabled:opacity-60";

export const inputClass =
  "mt-1 block min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-base text-ink shadow-sm focus:border-navy focus:outline-2 focus:outline-teal";

export const labelClass = "block text-sm font-medium text-ink";

export function Alert({
  tone = "error",
  children,
}: {
  tone?: "error" | "success" | "info";
  children: ReactNode;
}) {
  const styles = {
    error: "border-red-300 bg-red-50 text-red-900",
    success: "border-teal bg-mint/30 text-navy",
    info: "border-mint bg-mist text-navy",
  }[tone];
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={`rounded-lg border px-4 py-3 text-sm ${styles}`}
    >
      {children}
    </div>
  );
}

export function PageHeading({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-6">
      <h1 className="text-2xl font-bold tracking-tight text-navy sm:text-3xl">{title}</h1>
      {subtitle ? <p className="mt-2 text-slate-600">{subtitle}</p> : null}
    </div>
  );
}

export function StatusPill({
  label,
  tone = "neutral",
}: {
  label: string;
  tone?: "good" | "wait" | "neutral" | "bad";
}) {
  const styles = {
    good: "bg-mint/50 text-navy ring-teal/50",
    wait: "bg-amber-50 text-amber-900 ring-amber-300",
    neutral: "bg-mist text-ink ring-slate-300",
    bad: "bg-red-50 text-red-900 ring-red-300",
  }[tone];
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${styles}`}
    >
      {label}
    </span>
  );
}

export function statusTone(status: string): "good" | "wait" | "neutral" | "bad" {
  if (
    status === "CONFIRMED" ||
    status === "COMPLETED" ||
    status === "PAID" ||
    status === "PAID_AT_PROPERTY"
  ) {
    return "good";
  }
  if (
    status === "PENDING" ||
    status === "DRAFT" ||
    status === "UNPAID" ||
    status === "PAY_AT_PROPERTY"
  ) {
    return "wait";
  }
  if (status === "CANCELLED" || status === "EXPIRED" || status === "NO_SHOW") return "bad";
  return "neutral";
}
