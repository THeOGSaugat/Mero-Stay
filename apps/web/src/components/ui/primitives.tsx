import type { ButtonHTMLAttributes, ReactNode } from "react";

/**
 * The MeroStay design system's building blocks (Phase 13, docs/architecture/frontend.md).
 * Colours, radii and shadows come from the tokens in app/globals.css; never hard-code them here
 * or in screens. Class-string exports exist so links (`<Link className={buttonPrimary}>`) and
 * buttons share one look; the components wrap them for the common cases.
 */

const focusRing =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-strong";
const buttonBase = `inline-flex min-h-11 items-center justify-center gap-2 rounded-control px-5 py-2.5 text-sm font-semibold transition-colors ${focusRing} disabled:cursor-not-allowed disabled:opacity-60`;

/** Filled forest green: the main action of a screen (Search, Confirm, Pay). */
export const buttonPrimary = `${buttonBase} bg-primary text-white shadow-sm hover:bg-primary-dark`;

/** Outlined: secondary actions (Back, Previous/Next, Filter). */
export const buttonSecondary = `${buttonBase} border border-primary/30 bg-white text-primary hover:bg-surface`;

/** Outlined orange: listing calls to action (Book now), as in the mockups. */
export const buttonAccent = `${buttonBase} border border-accent-strong bg-white text-accent-strong hover:bg-accent-soft`;

/** Text-only: low-emphasis actions inside cards and tables. */
export const buttonGhost = `${buttonBase} px-3 text-primary hover:bg-surface`;

export const inputClass = `mt-1 block min-h-11 w-full rounded-control border border-line bg-white px-3 py-2 text-base text-ink shadow-sm placeholder:text-slate-500 focus:border-primary ${focusRing}`;

/** Native select with the same look as inputs. */
export const selectClass = `${inputClass} pr-8`;

export const labelClass = "block text-sm font-medium text-ink";

type ButtonVariant = "primary" | "secondary" | "accent" | "ghost";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: buttonPrimary,
  secondary: buttonSecondary,
  accent: buttonAccent,
  ghost: buttonGhost,
};

export function buttonClass(variant: ButtonVariant = "primary"): string {
  return BUTTON_VARIANTS[variant];
}

/** A button in one of the design system's variants. `type` defaults to "button". */
export function Button({
  variant = "primary",
  className = "",
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return <button type={type} className={`${BUTTON_VARIANTS[variant]} ${className}`} {...props} />;
}

/** A white card: listings, panels, widgets. */
export function Card({
  children,
  className = "",
  as: Tag = "div",
  ...rest
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "li" | "section" | "article" | "aside";
} & Record<`data-${string}` | "aria-labelledby" | "aria-label", string | undefined>) {
  return (
    <Tag className={`rounded-card border border-line bg-white shadow-card ${className}`} {...rest}>
      {children}
    </Tag>
  );
}

export function Alert({
  tone = "error",
  children,
}: {
  tone?: "error" | "success" | "info";
  children: ReactNode;
}) {
  const styles = {
    error: "border-red-300 bg-red-50 text-red-900",
    success: "border-primary-light/40 bg-primary-soft text-primary-dark",
    info: "border-line bg-surface text-ink",
  }[tone];
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={`rounded-control border px-4 py-3 text-sm ${styles}`}
    >
      {children}
    </div>
  );
}

/** A page's title (display font) with an optional subtitle. */
export function PageHeading({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-6">
      <h1 className="font-display text-3xl font-bold tracking-tight text-primary sm:text-4xl">
        {title}
      </h1>
      {subtitle ? <p className="mt-2 text-muted">{subtitle}</p> : null}
    </div>
  );
}

/** A section title inside a page ("Popular destinations"), with an optional link on the right. */
export function SectionHeading({
  id,
  title,
  action,
}: {
  id?: string;
  title: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
      <h2 id={id} className="font-display text-2xl font-semibold text-primary">
        {title}
      </h2>
      {action}
    </div>
  );
}

export type BadgeTone = "good" | "wait" | "neutral" | "bad" | "accent";

const BADGE_TONES: Record<BadgeTone, string> = {
  good: "bg-primary-soft text-primary-dark ring-primary-light/40",
  wait: "bg-amber-50 text-amber-900 ring-amber-300",
  neutral: "bg-surface text-ink ring-line",
  bad: "bg-red-50 text-red-900 ring-red-300",
  accent: "bg-accent-soft text-accent-dark ring-accent/60",
};

/** A status badge ("Verified", "Pending", "Paid"). Colour is never the only signal: the label is. */
export function Badge({ label, tone = "neutral" }: { label: string; tone?: BadgeTone }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${BADGE_TONES[tone]}`}
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current opacity-70" />
      {label}
    </span>
  );
}

/** The original name of Badge, used across the dashboards (Phase 7). */
export function StatusPill({ label, tone = "neutral" }: { label: string; tone?: BadgeTone }) {
  return <Badge label={label} tone={tone} />;
}

export function statusTone(status: string): "good" | "wait" | "neutral" | "bad" {
  if (
    status === "CONFIRMED" ||
    status === "COMPLETED" ||
    status === "PAID" ||
    status === "PAID_AT_PROPERTY" ||
    status === "APPROVED" ||
    status === "VERIFIED"
  ) {
    return "good";
  }
  if (
    status === "PENDING" ||
    status === "DRAFT" ||
    status === "UNPAID" ||
    status === "PAY_AT_PROPERTY" ||
    status === "PENDING_REVIEW" ||
    status === "PENDING_VERIFICATION"
  ) {
    return "wait";
  }
  if (
    status === "CANCELLED" ||
    status === "EXPIRED" ||
    status === "NO_SHOW" ||
    status === "REJECTED" ||
    status === "SUSPENDED"
  )
    return "bad";
  return "neutral";
}
