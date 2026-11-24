"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { adminAccess, adminErrorView, type AdminErrorView } from "@/lib/admin-access";
import { apiRequest, type ApiRequest } from "@/lib/api-client";
import { useAuth } from "../auth/auth-provider";
import { SectionNav } from "../ui/data";
import { Alert, buttonSecondary } from "../ui/primitives";

/**
 * The admin console's shell (Phase 7 Track C, ADR 0012). Navigation convenience only: the API
 * refuses every /admin URL with 403 for non-admins before reading any data.
 */

const SECTIONS = [
  { href: "/admin", label: "Overview" },
  { href: "/admin/providers", label: "Providers" },
  { href: "/admin/listing-rules", label: "Listing rules" },
  { href: "/admin/invoices", label: "Invoices" },
  { href: "/admin/payouts", label: "Payouts" },
  { href: "/admin/audit-log", label: "Audit log" },
] as const;

/** What any unknown URL shows; also what a logged-in non-admin sees for the console. */
export function NotFoundPanel() {
  return (
    <section className="space-y-4 py-6" data-testid="admin-not-found">
      <h1 className="text-2xl font-bold tracking-tight text-navy">Page not found</h1>
      <p className="text-slate-600">This page doesn&apos;t exist or has moved.</p>
      <Link href="/" className={buttonSecondary}>
        Go to the home page
      </Link>
    </section>
  );
}

export function AdminGate({ children }: { children: ReactNode }) {
  const { state } = useAuth();
  const access = adminAccess(state);
  if (access === "not-found") return <NotFoundPanel />;
  if (access !== "admin") return <p className="py-6 text-sm text-slate-600">Loading…</p>;
  return (
    <>
      <p className="mb-1 text-sm font-semibold uppercase tracking-wide text-slate-600">
        MeroStay admin
      </p>
      <SectionNav label="Admin" rootHref="/admin" sections={SECTIONS} />
      {children}
    </>
  );
}

/** Calls `/admin${path}` with the session cookie and, on writes, the in-memory CSRF token. */
export function useAdminRequest() {
  const { state } = useAuth();
  const csrfToken = state.csrfToken;
  return useCallback(
    <T,>(path: string, options: Omit<ApiRequest, "csrfToken"> = {}) =>
      apiRequest<T>(`/admin${path}`, { ...options, csrfToken }),
    [csrfToken],
  );
}

/** Loads admin data with the cancellable-promise pattern; `reload` fetches again. */
export function useAdminData<T>(path: string | null) {
  const request = useAdminRequest();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<AdminErrorView | null>(null);
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
        if (!cancelled) setError(adminErrorView(err));
      });
    return () => {
      cancelled = true;
    };
  }, [path, request, version]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  return { data, error, reload, setData };
}

export function AdminError({
  view,
  backHref,
  backLabel,
}: {
  view: AdminErrorView;
  backHref?: string;
  backLabel?: string;
}) {
  return (
    <div
      className="space-y-4"
      data-testid={view.kind === "not-found" ? "admin-item-not-found" : undefined}
    >
      <Alert>{view.kind === "not-found" ? "Not found." : view.message}</Alert>
      {backHref ? (
        <Link href={backHref} className={buttonSecondary}>
          {backLabel ?? "Back"}
        </Link>
      ) : null}
    </div>
  );
}
