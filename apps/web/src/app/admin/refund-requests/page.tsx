import type { Metadata } from "next";
import { Suspense } from "react";
import { RefundRequestsQueue } from "@/components/admin/admin-queues-view";
import { PageHeading } from "@/components/ui/primitives";

export const metadata: Metadata = {
  title: "Refund requests",
  robots: { index: false, follow: false },
};

export default function AdminRefundRequestsPage() {
  return (
    <>
      <PageHeading title="Refund requests" />
      <Suspense fallback={<p className="text-sm text-muted">Loading…</p>}>
        <RefundRequestsQueue />
      </Suspense>
    </>
  );
}
