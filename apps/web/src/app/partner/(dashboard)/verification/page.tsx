import type { Metadata } from "next";
import { Suspense } from "react";
import { VerificationView } from "@/components/partner/verification-view";
import { PageHeading } from "@/components/ui/primitives";

export const metadata: Metadata = { title: "Verification" };

export default function PartnerVerificationPage() {
  return (
    <>
      <PageHeading title="Verification" />
      <Suspense fallback={<p className="text-sm text-slate-600">Loading…</p>}>
        <VerificationView />
      </Suspense>
    </>
  );
}
