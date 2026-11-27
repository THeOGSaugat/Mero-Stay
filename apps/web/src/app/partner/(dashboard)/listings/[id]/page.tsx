import type { Metadata } from "next";
import { Suspense } from "react";
import { ListingDetailView } from "@/components/partner/listings-view";
import { PageHeading } from "@/components/ui/primitives";

export const metadata: Metadata = { title: "Listing" };

export default function PartnerListingPage() {
  return (
    <>
      <PageHeading title="Listing" />
      <Suspense fallback={<p className="text-sm text-muted">Loading…</p>}>
        <ListingDetailView />
      </Suspense>
    </>
  );
}
