import type { Metadata } from "next";
import { Suspense } from "react";
import { PoliciesView } from "@/components/partner/policies-view";
import { PageHeading } from "@/components/ui/primitives";

export const metadata: Metadata = { title: "Cancellation policies" };

export default function PartnerPoliciesPage() {
  return (
    <>
      <PageHeading
        title="Cancellation policies"
        subtitle="Your refund terms. Each booking keeps the terms it was booked with."
      />
      <Suspense fallback={<p className="text-sm text-slate-600">Loading…</p>}>
        <PoliciesView />
      </Suspense>
    </>
  );
}
