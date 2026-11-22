import { Suspense } from "react";
import { RequireAuth } from "@/components/auth/require-auth";
import { PartnerGate } from "@/components/partner/partner-context";
import { PartnerNav } from "@/components/partner/partner-ui";

/**
 * The partner dashboard (Phase 7 Track B, ADR 0011). Client-rendered behind the login and role
 * gate; every page reads its data from /api/v1/partner…, which scopes it to the partner's business.
 */
export default function PartnerDashboardLayout({ children }: LayoutProps<"/partner">) {
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
      <p className="mb-1 text-sm font-semibold uppercase tracking-wide text-slate-600">Partner</p>
      <Suspense fallback={<p className="text-sm text-slate-600">Loading…</p>}>
        <RequireAuth>
          <PartnerGate>
            <PartnerNav />
            {children}
          </PartnerGate>
        </RequireAuth>
      </Suspense>
    </div>
  );
}
