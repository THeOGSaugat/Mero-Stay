import { safeMaskedAccountNumber } from "./partner-display";

/**
 * Turns an audit entry's `before` / `after` snapshots into plain-text rows (Track C, ADR 0012).
 *
 * - Values become TEXT (strings), rendered by React as text nodes: nothing is ever injected as
 *   HTML, so a value like `<img onerror=…>` shows literally.
 * - The API already strips secrets and masks bank numbers (redactForAudit + a database CHECK).
 *   As a backstop the UI hides any secret-looking key and re-masks account numbers, so a server
 *   regression still can't put a secret on screen.
 */

export interface AuditRow {
  /** Dotted path, e.g. "payoutAccount.bankName". */
  key: string;
  before: string;
  after: string;
  changed: boolean;
}

const HIDDEN = "[hidden]";
const SECRET_KEYS =
  /^(password|passwordhash|token|tokenhash|sessiontoken|csrftoken|sessionsecret|secret|apikey)$/;
const MAX_DEPTH = 6;

const normalise = (key: string) => key.toLowerCase().replace(/[_-]/g, "");

function leafText(key: string, value: unknown): string {
  const k = normalise(key.split(".").at(-1) ?? key);
  if (SECRET_KEYS.test(k)) return HIDDEN;
  if (k === "accountnumber" || k === "accountnumbermasked") return safeMaskedAccountNumber(value);
  if (value === null) return "null";
  if (value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/** Flattens an object to { "a.b": leaf } (arrays of primitives stay one value). */
function flatten(value: unknown, prefix: string, out: Map<string, string>, depth: number): void {
  const isPlainObject = typeof value === "object" && value !== null && !Array.isArray(value);
  if (!isPlainObject || depth >= MAX_DEPTH) {
    if (prefix) out.set(prefix, leafText(prefix, value));
    return;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0 && prefix) out.set(prefix, "{}");
  for (const [key, inner] of entries) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (SECRET_KEYS.test(normalise(key))) {
      out.set(path, HIDDEN);
      continue;
    }
    flatten(inner, path, out, depth + 1);
  }
}

/** Before/after side by side, one row per key in either snapshot, sorted by key. */
export function auditRows(before: unknown, after: unknown): AuditRow[] {
  const b = new Map<string, string>();
  const a = new Map<string, string>();
  flatten(before ?? {}, "", b, 0);
  flatten(after ?? {}, "", a, 0);
  const keys = [...new Set([...b.keys(), ...a.keys()])].sort();
  return keys.map((key) => {
    const beforeText = b.get(key) ?? "—";
    const afterText = a.get(key) ?? "—";
    return { key, before: beforeText, after: afterText, changed: beforeText !== afterText };
  });
}

const ACTION_LABELS: Record<string, string> = {
  "provider.create": "Business created",
  "provider.payout_account.change": "Payout account changed",
  "provider.document.submit": "Document added",
  "provider.verification.submit": "Submitted for verification",
  "provider.verification.approve": "Verification approved",
  "provider.verification.reject": "Verification rejected",
  "booking_item.settle_at_property": "Paid at the property (partner)",
  "trip.settle_at_property": "Paid at the property (admin)",
};

/** The actions the API records (api.md), for the filter and readable labels. */
export const AUDIT_ACTIONS = Object.keys(ACTION_LABELS);

export function auditActionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

/** Query string for GET /admin/audit-log from the filter form (empty fields dropped). */
export function auditQuery(filters: Readonly<Record<string, string>>, page: number): string {
  const query = new URLSearchParams({ page: String(page), pageSize: "20" });
  for (const key of ["actorUserId", "action", "entityType", "entityId", "from", "to"]) {
    const value = (filters[key] ?? "").trim();
    if (value) query.set(key, value);
  }
  return query.toString();
}

/**
 * Who did it, for people (gap 25): the actor's name and role; a row without a user is a system
 * action. The API returns the name only (no email or phone).
 */
export function auditActorLabel(
  actor: { userId: string; role: string | null; name: string | null } | null,
): string {
  if (!actor) return "MeroStay system";
  const role = actor.role ? actor.role.toLowerCase() : "user";
  return `${actor.name?.trim() || "Unknown user"} (${role})`;
}
