import type { Metadata } from "next";
import { Suspense } from "react";
import { PayoutSummary } from "@/components/partner/finance-view";
import { PageHeading } from "@/components/ui/primitives";

export const metadata: Metadata = { title: "Payouts" };

export default function PartnerPayoutsPage() {
  return (
    <>
      <PageHeading title="Payouts" />
      <Suspense fallback={<p className="text-sm text-slate-600">Loading…</p>}>
        <PayoutSummary />
      </Suspense>
    </>
  );
}
