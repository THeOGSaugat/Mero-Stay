"use client";

import type { AdminProviderType } from "@/lib/admin-types";
import { tableClass, tdClass, thClass } from "../ui/data";
import { Alert, StatusPill } from "../ui/primitives";
import { AdminError, useAdminData } from "./admin-ui";

/**
 * /admin/listing-rules (read-only, ADR 0013): which listing types each kind of business may
 * create, with both active flags. A pair is usable only when it is mapped and both types are
 * active. The mapping changes by migration (data only); editing it here is a later phase.
 */
export function ListingRulesView() {
  const { data, error } = useAdminData<{ data: AdminProviderType[] }>("/provider-types");
  if (error) return <AdminError view={error} />;
  if (!data) return <p className="text-sm text-muted">Loading the rules…</p>;
  return (
    <div className="space-y-4">
      <Alert tone="info">
        Read-only. A listing type can be listed only when it is mapped to the kind of business and
        both are offered. The API enforces this on every create and update.
      </Alert>
      <div className="overflow-x-auto rounded-card border border-line bg-white">
        <table className={tableClass} data-testid="listing-rules">
          <thead>
            <tr>
              <th className={thClass}>Kind of business</th>
              <th className={thClass}>Offered</th>
              <th className={thClass}>Mapped listing types</th>
              <th className={thClass}>Usable now</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {data.data.map((type) => (
              <tr key={type.code} data-provider-type={type.code}>
                <td className={tdClass}>
                  <span className="font-semibold text-primary">{type.name}</span>
                  <span className="block font-mono text-xs text-muted">{type.code}</span>
                </td>
                <td className={tdClass}>
                  <StatusPill
                    label={type.isActive ? "Yes" : "No"}
                    tone={type.isActive ? "good" : "neutral"}
                  />
                </td>
                <td className={tdClass}>
                  <ul className="space-y-1">
                    {type.listingTypes.map((lt) => (
                      <li key={lt.code}>
                        {lt.name}{" "}
                        <span className="text-xs text-muted">
                          {lt.isActive ? "" : "(listing type not offered)"}
                        </span>
                      </li>
                    ))}
                  </ul>
                </td>
                <td className={tdClass} data-testid="usable">
                  {type.usableListingTypes.length > 0 ? type.usableListingTypes.join(", ") : "None"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
