import type { Metadata } from "next";
import { ListingRulesView } from "@/components/admin/listing-rules-view";
import { PageHeading } from "@/components/ui/primitives";

export const metadata: Metadata = {
  title: "Listing rules",
  robots: { index: false, follow: false },
};

export default function AdminListingRulesPage() {
  return (
    <>
      <PageHeading title="Listing rules" />
      <ListingRulesView />
    </>
  );
}
