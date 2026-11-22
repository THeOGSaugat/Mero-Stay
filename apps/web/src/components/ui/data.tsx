"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import type { PageInfo } from "@/lib/partner-types";
import { buttonSecondary } from "./primitives";

/**
 * Data display building blocks shared by the partner (Track B) and admin (Track C) dashboards:
 * a section nav, cards, label/value rows, paging and table classes. Palette tokens only.
 */

export interface Section {
  href: string;
  label: string;
}

/** Tabs for a dashboard area. `rootHref` is active only on itself; others also on sub-pages. */
export function SectionNav({
  label,
  rootHref,
  sections,
}: {
  label: string;
  rootHref: string;
  sections: readonly Section[];
}) {
  const pathname = usePathname();
  return (
    <nav aria-label={label} className="-mx-4 mb-6 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <ul className="flex min-w-max gap-1 border-b border-mist">
        {sections.map((section) => {
          const active =
            section.href === rootHref
              ? pathname === rootHref
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

/** Previous / next for partner and admin lists (`page: { page, pageSize, total }`). */
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
