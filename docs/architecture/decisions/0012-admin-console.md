# 0012. Admin console (web)

- **Status:** Accepted
- **Date:** 2026-11-22
- **Phase:** 07 (Track C)

## Context

Track C adds the admin console to `apps/web` on top of the Phase 6 admin API (ADR 0008):

- providers, and a verification decision for each;
- commission invoices;
- the read-only payout summary;
- the append-only audit log.

The API requires role `ADMIN` for every `/admin` URL (403 before any data is read). It enforces
the required-document groups on approval (`409 REQUIRED_DOCUMENTS_MISSING`, ADR 0009), and writes
one audit row per decision in the same transaction. It also strips secrets from audit snapshots
(redaction in code, plus a database CHECK).

No backend change was needed for Track C.

## Decisions

### 1. Who sees the console: admins only; everyone else sees "Page not found"

`app/admin/layout.tsx` wraps every page in `RequireAuth` → `AdminGate`.

- **Visitors** are sent to `/login?next=…`, like every account page.
- **Logged-in customers and partners** see the same "Page not found" panel as any unknown URL. The
  console is not advertised: there is no "Admin" link for them, and pages are `noindex`.
- **The API stays the security.** It answers 403 to them for every `/admin` call, and an E2E test
  checks both the page and the 403.
- **Client-rendered:** admin pages are private, so there is nothing to render on the server.

### 2. The incomplete-provider block is shown before anyone clicks

The review page builds the checklist from two sources, the provider type's required groups
(`GET /provider-types`) and the provider's documents, with the same `requirementChecklist` as the
partner page and the same rule as the API: a pending or approved document counts.

- **Groups missing:** the page shows "Approval is blocked: no document for …", and **Approve is
  disabled**. Rejecting with a reason is still possible.
- **The API checks anyway.** A forced approval returns 409, and the UI shows that refusal the same
  way. The E2E test makes that call.
- **Type not offered (e.g. airline):** its groups are not published, so the page says the API
  will check them, and leaves Approve enabled.

### 3. "Audited" is confirmed from the audit log itself

After a decision, the page reads the newest matching audit entry
(`GET /admin/audit-log?entityType=provider&entityId=…&action=provider.verification.<decision>`).
It shows "Audit entry recorded <time> (<action>)" with a link to the filtered log.

This confirmation comes from the server's own row, not from an assumption.

### 4. Audit snapshots are rendered as text only

`lib/audit-display.ts` flattens `before` / `after` into rows of **strings** (`status`,
`payoutAccount.bankName`, …). React renders these as text nodes.

- **No raw HTML:** the web app never uses `dangerouslySetInnerHTML`, and a unit test scans every
  source file to keep it that way. A value like `<script>` shows as literal text.
- **Backstop redaction:** the API already removes secrets. In addition, the UI hides
  secret-looking keys (`password`, `tokenHash`, `csrfToken`, …) and re-masks any account number
  with `safeMaskedAccountNumber`.

### 5. One shared set of display components

Track B's generic pieces moved to `components/ui/data.tsx`, so both dashboards use the same
building blocks and palette tokens:

- `SectionNav`, `Panel`, `Facts`, `Pager`;
- the table classes.

### 6. Filters match what the API offers

| Page | Filters |
|---|---|
| Providers | Type, verification status (including `SUSPENDED`, the inactive state). The API has no separate per-provider "active" flag, so none is invented |
| Invoices | Provider, status, issued date |
| Payouts | Provider, service date |
| Audit log | Actor id, action, entity type and id, date |

The provider picker lists the first 100 providers (the API's page limit); a search comes with
gap 25.

## Alternatives considered

- **A 403 page for non-admins:** honest, but it advertises the console. Showing the same "not
  found" as an unknown URL reveals less, and the API's 403 is unchanged.
- **Leave Approve enabled and let the API refuse:** simpler, but the reviewer learns about the
  block only after clicking. Showing it up front, with the API as the final check, is clearer.
- **Render audit JSON as a `<pre>` blob:** safe, but hard to read. Field rows with before and
  after side by side show what changed.

## Consequences

- No backend change in Track C.
- **New operational gap 25:** admin lists have no search and are sorted oldest first; the
  provider picker shows 100 providers; audit actors appear as user ids, not names (Phase 8).
