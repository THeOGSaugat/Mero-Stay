import type { Metadata } from "next";
import { AdminOverview } from "@/components/admin/admin-overview";
import { PageHeading } from "@/components/ui/primitives";

export const metadata: Metadata = { title: "Overview", robots: { index: false, follow: false } };

export default function AdminHomePage() {
  return (
    <>
      <PageHeading title="Overview" />
      <AdminOverview />
    </>
  );
}
