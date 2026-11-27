import type { Metadata } from "next";
import { Suspense } from "react";
import { PayoutSummary } from "@/components/partner/finance-view";
import { PartnerClawbacks, PartnerPayoutBatches } from "@/components/partner/payout-batches-list";
import { PageHeading } from "@/components/ui/primitives";

export const metadata: Metadata = { title: "Payouts" };

export default function PartnerPayoutsPage() {
  return (
    <>
      <PageHeading title="Payouts" />
      <Suspense fallback={<p className="text-sm text-muted">Loading…</p>}>
        <div className="space-y-6">
          <PayoutSummary />
          <PartnerPayoutBatches />
          <PartnerClawbacks />
        </div>
      </Suspense>
    </>
  );
}
