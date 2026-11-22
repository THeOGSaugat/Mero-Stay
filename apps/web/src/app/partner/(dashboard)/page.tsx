import type { Metadata } from "next";
import { PartnerOverview } from "@/components/partner/profile-view";
import { PageHeading } from "@/components/ui/primitives";

export const metadata: Metadata = { title: "Partner" };

export default function PartnerHomePage() {
  return (
    <>
      <PageHeading title="Your business" />
      <PartnerOverview />
    </>
  );
}
