import type { Metadata } from "next";
import { Suspense } from "react";
import { AdminPayoutSummary } from "@/components/admin/finance-view";
import { PageHeading } from "@/components/ui/primitives";

export const metadata: Metadata = { title: "Payouts", robots: { index: false, follow: false } };

export default function AdminPayoutsPage() {
  return (
    <>
      <PageHeading title="Payouts" />
      <Suspense fallback={<p className="text-sm text-slate-600">Loading…</p>}>
        <AdminPayoutSummary />
      </Suspense>
    </>
  );
}
