import type { Metadata } from "next";
import { Suspense } from "react";
import { AdminAccounts } from "@/components/admin/admin-accounts-view";
import { PageHeading } from "@/components/ui/primitives";

export const metadata: Metadata = {
  title: "Admin accounts",
  robots: { index: false, follow: false },
};

export default function AdminAccountsPage() {
  return (
    <>
      <PageHeading title="Admin accounts" />
      <Suspense fallback={<p className="text-sm text-slate-600">Loading…</p>}>
        <AdminAccounts />
      </Suspense>
    </>
  );
}
