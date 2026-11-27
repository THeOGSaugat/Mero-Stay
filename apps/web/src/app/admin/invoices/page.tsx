import type { Metadata } from "next";
import { Suspense } from "react";
import { AdminInvoiceList } from "@/components/admin/finance-view";
import { PageHeading } from "@/components/ui/primitives";

export const metadata: Metadata = {
  title: "Commission invoices",
  robots: { index: false, follow: false },
};

export default function AdminInvoicesPage() {
  return (
    <>
      <PageHeading title="Commission invoices" />
      <Suspense fallback={<p className="text-sm text-muted">Loading…</p>}>
        <AdminInvoiceList />
      </Suspense>
    </>
  );
}
