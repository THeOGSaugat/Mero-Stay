"use client";

import Link from "next/link";
import type { AdminProviderSummary } from "@/lib/admin-types";
import type { Paged } from "@/lib/partner-types";
import { Panel } from "../ui/data";
import { buttonPrimary } from "../ui/primitives";
import { useAdminData } from "./admin-ui";

/** /admin: what needs attention (providers waiting for verification) and the console's areas. */
export function AdminOverview() {
  const { data } = useAdminData<Paged<AdminProviderSummary>>(
    "/providers?status=PENDING_VERIFICATION&pageSize=1",
  );
  return (
    <div className="space-y-4">
      <Panel title="Waiting for verification">
        <p className="text-3xl font-bold text-navy" data-testid="pending-count">
          {data ? data.page.total : "…"}
        </p>
        <p className="mt-1 text-sm text-slate-600">providers asked to be verified</p>
        <Link
          href="/admin/providers?status=PENDING_VERIFICATION"
          className={`${buttonPrimary} mt-4`}
        >
          Review providers
        </Link>
      </Panel>
      <div className="grid gap-4 sm:grid-cols-3">
        {[
          {
            href: "/admin/invoices",
            title: "Invoices",
            text: "Commission invoices of every provider",
          },
          {
            href: "/admin/payouts",
            title: "Payouts",
            text: "What MeroStay owes providers (read-only)",
          },
          { href: "/admin/audit-log", title: "Audit log", text: "Who changed what, and when" },
        ].map((card) => (
          <Link
            key={card.href}
            href={card.href}
            className="rounded-xl border border-mist bg-white p-4 shadow-sm hover:border-teal focus-visible:outline-2 focus-visible:outline-teal"
          >
            <span className="block font-semibold text-navy">{card.title}</span>
            <span className="mt-1 block text-sm text-slate-600">{card.text}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
