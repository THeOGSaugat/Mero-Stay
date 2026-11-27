import type { Metadata } from "next";
import { Suspense } from "react";
import { PartnerProfileView } from "@/components/partner/profile-view";
import { PageHeading } from "@/components/ui/primitives";

export const metadata: Metadata = { title: "Business profile" };

export default function PartnerProfilePage() {
  return (
    <>
      <PageHeading title="Business profile" />
      <Suspense fallback={<p className="text-sm text-muted">Loading…</p>}>
        <PartnerProfileView />
      </Suspense>
    </>
  );
}
