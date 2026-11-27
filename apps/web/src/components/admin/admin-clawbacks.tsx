"use client";

import type { Clawback } from "@/lib/refunds-display";
import { AdminError, useAdminData } from "./admin-ui";
import { ClawbackList } from "./clawbacks-view";

export function AdminClawbacks() {
  const { data, error } = useAdminData<{ data: Clawback[] }>("/clawbacks");
  if (error) return <AdminError view={error} />;
  if (!data) return <p className="text-sm text-muted">Loading clawbacks…</p>;
  return (
    <ClawbackList rows={data.data} showProvider emptyText="No paid-out booking has been voided." />
  );
}
