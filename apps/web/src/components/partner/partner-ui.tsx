"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { partnerErrorView, type PartnerErrorView } from "@/lib/partner-access";
import { SectionNav } from "../ui/data";
import { Alert, buttonSecondary } from "../ui/primitives";
import { usePartner } from "./partner-context";

/** Partner dashboard pieces; the generic ones (Panel, Facts, Pager, tables) live in ui/data.tsx. */

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
  return <SectionNav label="Partner" rootHref="/partner" sections={SECTIONS} />;
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

export { Facts, Pager, Panel, tableClass, tdClass, thClass } from "../ui/data";
