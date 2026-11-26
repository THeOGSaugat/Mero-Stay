import type { Metadata } from "next";
import { Suspense } from "react";
import { LatePaymentsQueue } from "@/components/admin/admin-queues-view";
import { PageHeading } from "@/components/ui/primitives";

export const metadata: Metadata = {
  title: "Late payments",
  robots: { index: false, follow: false },
};

export default function AdminLatePaymentsPage() {
  return (
    <>
      <PageHeading
        title="Late payments"
        subtitle="Money a gateway confirmed that could not be applied to a booking."
      />
      <Suspense fallback={<p className="text-sm text-slate-600">Loading…</p>}>
        <LatePaymentsQueue />
      </Suspense>
    </>
  );
}
