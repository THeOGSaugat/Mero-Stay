"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { partnerErrorView, type PartnerErrorView } from "@/lib/partner-access";
import type { PageInfo } from "@/lib/partner-types";
import { Alert, buttonSecondary } from "../ui/primitives";
import { usePartner } from "./partner-context";

/** Shared pieces of the partner dashboard, built on the Track A primitives and palette. */

const SECTIONS = [
  { href: "/partner", label: "Overview" },
  { href: "/partner/listings", label: "Listings" },
  { href: "/partner/bookings", label: "Bookings" },
  { href: "/partner/invoices", label: "Invoices" },
  { href: "/partner/payouts", label: "Payouts" },
  { href: "/partner/verification", label: "Verification" },
  { href: "/partner/profile", label: "Profile" },
] as const;

export function PartnerNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Partner" className="-mx-4 mb-6 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <ul className="flex min-w-max gap-1 border-b border-mist">
        {SECTIONS.map((section) => {
          const active =
            section.href === "/partner"
              ? pathname === "/partner"
              : pathname === section.href || pathname.startsWith(`${section.href}/`);
          return (
            <li key={section.href}>
              <Link
                href={section.href}
                aria-current={active ? "page" : undefined}
                className={`inline-flex min-h-11 items-center border-b-2 px-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-teal ${
                  active
                    ? "border-navy text-navy"
                    : "border-transparent text-ink hover:border-mint hover:text-navy"
                }`}
              >
                {section.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** A section card. */
export function Panel({
  title,
  children,
  actions,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-mist bg-white p-4 shadow-sm sm:p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-navy">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** Label/value rows. */
export function Facts({ rows }: { rows: readonly { label: string; value: ReactNode }[] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[minmax(0,12rem)_1fr]">
      {rows.map((row) => (
        <div key={row.label} className="contents">
          <dt className="font-medium text-slate-600">{row.label}</dt>
          <dd className="text-ink">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * What a failed partner request shows. A 404 is "not found", whether the thing does not exist
 * or belongs to another business: the API answers the same for both, and so does the UI.
 */
export function PartnerError({
  view,
  backHref,
  backLabel,
}: {
  view: PartnerErrorView;
  backHref?: string;
  backLabel?: string;
}) {
  const message =
    view.kind === "not-found"
      ? "Not found. It may have been removed, or it isn't part of your business."
      : view.kind === "message"
        ? view.message
        : view.kind === "forbidden"
          ? "Your account can't use the partner area."
          : "The partner area is not available.";
  return (
    <div
      className="space-y-4"
      data-testid={view.kind === "not-found" ? "partner-not-found" : undefined}
    >
      <Alert>{message}</Alert>
      {backHref ? (
        <Link href={backHref} className={buttonSecondary}>
          {backLabel ?? "Back"}
        </Link>
      ) : null}
    </div>
  );
}

/** Loads partner data with the cancellable-promise pattern; `reload` fetches again. */
export function usePartnerData<T>(path: string | null) {
  const { request } = usePartner();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<PartnerErrorView | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (path === null) return;
    let cancelled = false;
    request<T>(path)
      .then((body) => {
        if (cancelled) return;
        setData(body);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(partnerErrorView(err));
      });
    return () => {
      cancelled = true;
    };
  }, [path, request, version]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  return { data, error, reload, setData };
}

/** Previous / next for partner lists (`page: { page, pageSize, total }`). */
export function Pager({ page, hrefFor }: { page: PageInfo; hrefFor: (page: number) => string }) {
  const totalPages = Math.max(1, Math.ceil(page.total / page.pageSize));
  if (totalPages <= 1) return null;
  return (
    <nav aria-label="Pages" className="mt-4 flex items-center justify-between">
      {page.page > 1 ? (
        <Link className={buttonSecondary} href={hrefFor(page.page - 1)}>
          Previous
        </Link>
      ) : (
        <span />
      )}
      <span className="text-sm text-slate-600">
        Page {page.page} of {totalPages}
      </span>
      {page.page < totalPages ? (
        <Link className={buttonSecondary} href={hrefFor(page.page + 1)}>
          Next
        </Link>
      ) : (
        <span />
      )}
    </nav>
  );
}

export const tableClass = "min-w-full divide-y divide-mist text-sm";
export const thClass =
  "bg-mist px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-navy";
export const tdClass = "px-3 py-2 align-top text-ink";
