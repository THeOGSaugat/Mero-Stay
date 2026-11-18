import { connection } from "next/server";
import { getSystemHealth, type ServiceState } from "@/lib/api-health";
import { getApiBaseUrl } from "@/lib/config";

const STATE_STYLES: Record<ServiceState, { label: string; dot: string; text: string }> = {
  up: { label: "Operational", dot: "bg-emerald-500", text: "text-emerald-700" },
  down: { label: "Unavailable", dot: "bg-red-500", text: "text-red-700" },
  unknown: { label: "Unknown", dot: "bg-slate-400", text: "text-slate-600" },
};

const kathmanduTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kathmandu",
  dateStyle: "medium",
  timeStyle: "medium",
});

function StatusBadge({ state }: { state: ServiceState }) {
  const style = STATE_STYLES[state];
  return (
    <span className={`inline-flex items-center gap-2 text-sm font-medium ${style.text}`}>
      <span aria-hidden="true" className={`size-2.5 rounded-full ${style.dot}`} />
      {style.label}
    </span>
  );
}

/**
 * Live status of the web app, API and database. Rendered on the server at
 * request time; must be wrapped in <Suspense> (Cache Components).
 */
export async function SystemStatus() {
  // Opt into request-time rendering so API_URL and the health result are fresh.
  await connection();

  const health = await getSystemHealth(getApiBaseUrl());
  const rows: { id: string; label: string; state: ServiceState }[] = [
    { id: "web", label: "Web app", state: "up" },
    { id: "api", label: "API", state: health.api },
    { id: "database", label: "Database", state: health.database },
  ];

  return (
    <>
      <ul role="list" className="divide-y divide-slate-200">
        {rows.map((row) => (
          <li
            key={row.id}
            data-testid={`status-${row.id}`}
            className="flex items-center justify-between gap-4 py-3"
          >
            <span className="text-slate-700">{row.label}</span>
            <StatusBadge state={row.state} />
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-slate-500">
        Checked{" "}
        <time dateTime={health.checkedAt}>{kathmanduTime.format(new Date(health.checkedAt))}</time>{" "}
        (Nepal time)
      </p>
    </>
  );
}

export function SystemStatusSkeleton() {
  return (
    <p className="py-3 text-sm text-slate-500" aria-live="polite">
      Checking services…
    </p>
  );
}
