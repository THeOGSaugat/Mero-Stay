import type { Metadata } from "next";
import { Suspense } from "react";
import { ListingReviewQueue } from "@/components/admin/listing-review-view";
import { PageHeading } from "@/components/ui/primitives";

export const metadata: Metadata = {
  title: "Listings to review",
  robots: { index: false, follow: false },
};

export default function AdminListingsPage() {
  return (
    <>
      <PageHeading
        title="Listings to review"
        subtitle="Approve or reject what partners submitted."
      />
      <Suspense fallback={<p className="text-sm text-slate-600">Loading…</p>}>
        <ListingReviewQueue />
      </Suspense>
    </>
  );
}
