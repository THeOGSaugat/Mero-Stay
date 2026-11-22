import type { Metadata } from "next";
import { ListingForm } from "@/components/partner/listings-view";
import { Panel } from "@/components/partner/partner-ui";
import { PageHeading } from "@/components/ui/primitives";

export const metadata: Metadata = { title: "New listing" };

export default function PartnerNewListingPage() {
  return (
    <>
      <PageHeading
        title="New listing"
        subtitle="New listings start as drafts. Submit one for review when it's ready; MeroStay approves it before it goes live."
      />
      <Panel title="Listing details">
        <ListingForm />
      </Panel>
    </>
  );
}
