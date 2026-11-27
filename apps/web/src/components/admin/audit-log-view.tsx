"use client";

import Form from "next/form";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { AuditEntry } from "@/lib/admin-types";
import {
  AUDIT_ACTIONS,
  auditActionLabel,
  auditActorLabel,
  auditQuery,
  auditRows,
} from "@/lib/audit-display";
import { formatTimestamp } from "@/lib/partner-display";
import type { Paged } from "@/lib/partner-types";
import { Pager, tableClass, tdClass, thClass } from "../ui/data";
import { Alert, buttonSecondary, inputClass, labelClass } from "../ui/primitives";
import { AdminError, useAdminData } from "./admin-ui";

const KEYS = ["actorUserId", "action", "entityType", "entityId", "from", "to"] as const;
const ENTITY_TYPES = ["provider", "booking_item", "trip"];

/**
 * Before/after as a text table. Every value is a string from `auditRows` rendered as a React
 * text node: never HTML. Secret-looking keys are hidden and account numbers re-masked as a
 * backstop to the API's own redaction.
 */
function Snapshot({ entry }: { entry: AuditEntry }) {
  const rows = auditRows(entry.before, entry.after);
  if (rows.length === 0) return <p className="text-sm text-muted">No details recorded.</p>;
  return (
    <div className="overflow-x-auto">
      <table className={tableClass} data-testid="audit-snapshot">
        <thead>
          <tr>
            <th className={thClass}>Field</th>
            <th className={thClass}>Before</th>
            <th className={thClass}>After</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((row) => (
            <tr
              key={row.key}
              data-key={row.key}
              className={row.changed ? "bg-surface/40" : undefined}
            >
              <td className={`${tdClass} font-mono text-xs`}>{row.key}</td>
              <td className={`${tdClass} break-all`}>{row.before}</td>
              <td
                className={`${tdClass} break-all ${row.changed ? "font-semibold text-primary" : ""}`}
              >
                {row.after}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** /admin/audit-log: newest first; filter by actor, action, entity and date. */
export function AuditLogView() {
  const search = useSearchParams();
  const values = Object.fromEntries(KEYS.map((k) => [k, search.get(k) ?? ""]));
  const page = Math.max(1, Number.parseInt(search.get("page") ?? "1", 10) || 1);
  const { data, error } = useAdminData<Paged<AuditEntry>>(`/audit-log?${auditQuery(values, page)}`);
  const hrefFor = (p: number) =>
    `/admin/audit-log?${auditQuery(values, p).replace(/&?pageSize=20/, "")}`;

  return (
    <div className="space-y-4">
      <Form
        action="/admin/audit-log"
        className="grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-3"
      >
        <label className={labelClass}>
          Action
          <select name="action" defaultValue={values.action} className={inputClass}>
            <option value="">All</option>
            {AUDIT_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {auditActionLabel(a)}
              </option>
            ))}
          </select>
        </label>
        <label className={labelClass}>
          Entity
          <select name="entityType" defaultValue={values.entityType} className={inputClass}>
            <option value="">All</option>
            {ENTITY_TYPES.map((t) => (
              <option key={t} value={t}>
                {t.replace("_", " ")}
              </option>
            ))}
          </select>
        </label>
        <label className={labelClass}>
          Entity id
          <input name="entityId" defaultValue={values.entityId} className={inputClass} />
        </label>
        <label className={labelClass}>
          Actor (user id)
          <input name="actorUserId" defaultValue={values.actorUserId} className={inputClass} />
        </label>
        <label className={labelClass}>
          From (UTC date)
          <input name="from" type="date" defaultValue={values.from} className={inputClass} />
        </label>
        <label className={labelClass}>
          Before (UTC date)
          <input name="to" type="date" defaultValue={values.to} className={inputClass} />
        </label>
        <button type="submit" className={buttonSecondary}>
          Filter
        </button>
      </Form>

      {error ? <AdminError view={error} /> : null}
      {!data && !error ? <p className="text-sm text-muted">Loading the audit log…</p> : null}
      {data ? <p className="text-sm text-muted">{data.page.total} entries</p> : null}
      {data && data.data.length === 0 ? <Alert tone="info">No entries match.</Alert> : null}
      <ul className="space-y-3" data-testid="audit-entries">
        {data?.data.map((entry) => (
          <li
            key={entry.id}
            data-testid="audit-entry"
            data-action={entry.action}
            className="rounded-card border border-line bg-white p-4 shadow-card"
          >
            <div className="mb-3 flex flex-wrap items-start justify-between gap-2 text-sm">
              <div>
                <p className="font-semibold text-primary">
                  {auditActionLabel(entry.action)}{" "}
                  <span className="font-mono text-xs text-muted">{entry.action}</span>
                </p>
                <p className="text-muted">
                  {entry.entity.type}{" "}
                  {entry.entity.type === "provider" ? (
                    <Link
                      href={`/admin/providers/${entry.entity.id}`}
                      className="font-mono text-xs text-primary underline"
                    >
                      {entry.entity.id}
                    </Link>
                  ) : (
                    <span className="font-mono text-xs">{entry.entity.id}</span>
                  )}
                </p>
              </div>
              <div className="text-right text-muted">
                <p>{formatTimestamp(entry.createdAt)}</p>
                <p>
                  <span data-testid="audit-actor">{auditActorLabel(entry.actor)}</span>
                  {entry.ip ? ` · ${entry.ip}` : ""}
                </p>
              </div>
            </div>
            <Snapshot entry={entry} />
          </li>
        ))}
      </ul>
      {data ? <Pager page={data.page} hrefFor={hrefFor} /> : null}
    </div>
  );
}
