import type { Metadata } from "next";
import { Suspense } from "react";
import { ListingList } from "@/components/partner/listings-view";
import { PageHeading } from "@/components/ui/primitives";

export const metadata: Metadata = { title: "Your listings" };

export default function PartnerListingsPage() {
  return (
    <>
      <PageHeading title="Your listings" />
      <Suspense fallback={<p className="text-sm text-slate-600">Loading…</p>}>
        <ListingList />
      </Suspense>
    </>
  );
}
