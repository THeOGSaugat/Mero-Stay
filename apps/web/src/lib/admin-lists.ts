/**
 * Admin list filters ⇄ URL ⇄ API query (gap 25). Pure, so it is unit-tested.
 *
 * The page's URL holds the filters (shareable, back button works); the same values become the
 * API query. Empty values are dropped; `page` defaults to 1 and `pageSize` is fixed per list.
 */

export interface ListQuery {
  /** The filter values present in the URL (trimmed; "" when absent). */
  values: Record<string, string>;
  page: number;
  /** For GET /api/v1/admin/... */
  apiQuery: string;
}

export function readListQuery(
  search: Pick<URLSearchParams, "get">,
  keys: readonly string[],
  pageSize = 20,
): ListQuery {
  const values: Record<string, string> = {};
  const api = new URLSearchParams();
  for (const key of keys) {
    const value = (search.get(key) ?? "").trim();
    values[key] = value;
    if (value) api.set(key, value);
  }
  const raw = Number.parseInt(search.get("page") ?? "1", 10);
  const page = Number.isFinite(raw) && raw >= 1 ? Math.min(raw, 10_000) : 1;
  api.set("page", String(page));
  api.set("pageSize", String(pageSize));
  return { values, page, apiQuery: api.toString() };
}

/** The page URL for the same filters on another page (page 1 is left implicit). */
export function listHref(base: string, values: Record<string, string>, page: number): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value) q.set(key, value);
  if (page > 1) q.set("page", String(page));
  const text = q.toString();
  return text ? `${base}?${text}` : base;
}

export const PROVIDER_LIST_KEYS = ["q", "status", "providerType", "sort"] as const;
export const INVOICE_LIST_KEYS = ["q", "providerId", "status", "from", "to"] as const;
export const PAYOUT_LIST_KEYS = ["q", "providerId", "from", "to"] as const;

export const PROVIDER_SORTS = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "name", label: "Name (A–Z)" },
] as const;
