import type { Metadata } from "next";
import { Suspense } from "react";
import { ProviderList } from "@/components/admin/providers-view";
import { PageHeading } from "@/components/ui/primitives";

export const metadata: Metadata = { title: "Providers", robots: { index: false, follow: false } };

export default function AdminProvidersPage() {
  return (
    <>
      <PageHeading title="Providers" />
      <Suspense fallback={<p className="text-sm text-slate-600">Loading…</p>}>
        <ProviderList />
      </Suspense>
    </>
  );
}
