import type { Metadata } from "next";
import { Suspense } from "react";
import { AuditLogView } from "@/components/admin/audit-log-view";
import { PageHeading } from "@/components/ui/primitives";

export const metadata: Metadata = { title: "Audit log", robots: { index: false, follow: false } };

export default function AdminAuditLogPage() {
  return (
    <>
      <PageHeading title="Audit log" />
      <Suspense fallback={<p className="text-sm text-slate-600">Loading…</p>}>
        <AuditLogView />
      </Suspense>
    </>
  );
}
