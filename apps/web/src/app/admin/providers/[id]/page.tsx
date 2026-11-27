import type { Metadata } from "next";
import { Suspense } from "react";
import { ProviderReview } from "@/components/admin/providers-view";
import { PageHeading } from "@/components/ui/primitives";

export const metadata: Metadata = {
  title: "Provider review",
  robots: { index: false, follow: false },
};

export default function AdminProviderPage() {
  return (
    <>
      <PageHeading title="Provider review" />
      <Suspense fallback={<p className="text-sm text-muted">Loading…</p>}>
        <ProviderReview />
      </Suspense>
    </>
  );
}
