import type { Metadata } from "next";
import { Suspense } from "react";
import { InvoiceList } from "@/components/partner/finance-view";
import { PageHeading } from "@/components/ui/primitives";

export const metadata: Metadata = { title: "Commission invoices" };

export default function PartnerInvoicesPage() {
  return (
    <>
      <PageHeading title="Commission invoices" />
      <Suspense fallback={<p className="text-sm text-slate-600">Loading…</p>}>
        <InvoiceList />
      </Suspense>
    </>
  );
}
