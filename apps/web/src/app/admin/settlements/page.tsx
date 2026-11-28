import type { Metadata } from "next";
import { Suspense } from "react";
import { SettlementReconciliation } from "@/components/admin/settlements-view";
import { PageHeading } from "@/components/ui/primitives";

export const metadata: Metadata = {
  title: "Settlements",
  robots: { index: false, follow: false },
};

export default function AdminSettlementsPage() {
  return (
    <>
      <PageHeading title="Pay-at-property settlements" />
      <Suspense fallback={<p className="text-sm text-muted">Loading…</p>}>
        <SettlementReconciliation />
      </Suspense>
    </>
  );
}
