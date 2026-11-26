"use client";

import Link from "next/link";
import Form from "next/form";
import { useParams, useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { describeAdminError } from "@/lib/admin-access";
import type {
  AdminProvider,
  AdminProviderSummary,
  AdminProviderType,
  AuditEntry,
} from "@/lib/admin-types";
import { listHref, PROVIDER_LIST_KEYS, PROVIDER_SORTS, readListQuery } from "@/lib/admin-lists";
import {
  bpsToPercentText,
  documentStatusLabel,
  documentTypeLabel,
  formatFileSize,
  formatTimestamp,
  payoutAccountSummary,
  providerStatusLabel,
  requirementChecklist,
  safeMaskedAccountNumber,
} from "@/lib/partner-display";
import type { Paged } from "@/lib/partner-types";
import { providerStatusTone } from "../partner/profile-view";
import { Facts, Pager, Panel, tableClass, tdClass, thClass } from "../ui/data";
import {
  Alert,
  buttonPrimary,
  buttonSecondary,
  inputClass,
  labelClass,
  StatusPill,
} from "../ui/primitives";
import { adminDocumentFileHref } from "@/lib/document-upload";
import { policySummary } from "@/lib/cancellation-policy";
import type { PolicyList } from "@/lib/partner-types";
import { AdminError, useAdminData, useAdminRequest } from "./admin-ui";

const STATUSES = ["", "PENDING_VERIFICATION", "DRAFT", "VERIFIED", "REJECTED", "SUSPENDED"];

/** Every provider type with its required documents and listing rules (admin, incl. inactive). */
function useProviderTypes(): AdminProviderType[] | null {
  const { data, error } = useAdminData<{ data: AdminProviderType[] }>("/provider-types");
  if (error) return [];
  return data?.data ?? null;
}

/** /admin/providers: every provider, filtered by type and verification status, paginated. */
export function ProviderList() {
  const types = useProviderTypes();
  const { values, page, apiQuery } = readListQuery(useSearchParams(), PROVIDER_LIST_KEYS);
  const { data, error } = useAdminData<Paged<AdminProviderSummary>>(`/providers?${apiQuery}`);

  return (
    <div className="space-y-4">
      <Form
        action="/admin/providers"
        className="grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-5"
        data-testid="provider-search"
      >
        <label className={`${labelClass} lg:col-span-2`}>
          Search
          <input
            name="q"
            type="search"
            defaultValue={values.q}
            maxLength={100}
            placeholder="Name, owner email or kind of business"
            className={inputClass}
          />
        </label>
        <label className={labelClass}>
          Verification status
          <select name="status" defaultValue={values.status} className={inputClass}>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s ? providerStatusLabel(s) : "All"}
              </option>
            ))}
          </select>
        </label>
        <label className={labelClass}>
          Kind of business
          <select
            name="providerType"
            defaultValue={values.providerType}
            key={types ? "loaded" : "loading"}
            className={inputClass}
          >
            <option value="">All</option>
            {types?.map((t) => (
              <option key={t.code} value={t.code}>
                {t.name}
                {t.isActive ? "" : " (not offered)"}
              </option>
            ))}
          </select>
        </label>
        <label className={labelClass}>
          Order
          <select name="sort" defaultValue={values.sort || "newest"} className={inputClass}>
            {PROVIDER_SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className={buttonSecondary}>
          Search
        </button>
      </Form>
      {error ? <AdminError view={error} /> : null}
      {!data && !error ? <p className="text-sm text-slate-600">Loading providers…</p> : null}
      {data ? (
        <p className="text-sm text-slate-600" data-testid="providers-total">
          {data.page.total} providers
        </p>
      ) : null}
      {data && data.data.length === 0 ? <Alert tone="info">No providers match.</Alert> : null}
      {data && data.data.length > 0 ? (
        <div className="overflow-x-auto rounded-xl border border-mist bg-white">
          <table className={tableClass} data-testid="admin-providers">
            <thead>
              <tr>
                <th className={thClass}>Provider</th>
                <th className={thClass}>Status</th>
                <th className={thClass}>Documents</th>
                <th className={thClass}>Owner</th>
                <th className={thClass}>Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-mist">
              {data.data.map((p) => (
                <tr key={p.id} data-testid="admin-provider-row">
                  <td className={tdClass}>
                    <Link
                      href={`/admin/providers/${p.id}`}
                      className="font-semibold text-navy hover:underline"
                    >
                      {p.displayName}
                    </Link>
                    <span className="block text-slate-600">{p.providerType.name}</span>
                  </td>
                  <td className={tdClass}>
                    <StatusPill
                      label={providerStatusLabel(p.status)}
                      tone={providerStatusTone(p.status)}
                    />
                  </td>
                  <td className={tdClass}>
                    {p.documents.PENDING} under review · {p.documents.APPROVED} approved ·{" "}
                    {p.documents.REJECTED} rejected
                  </td>
                  <td className={tdClass}>{p.owner.fullName}</td>
                  <td className={tdClass}>{formatTimestamp(p.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {data ? (
        <Pager page={data.page} hrefFor={(p) => listHref("/admin/providers", values, p)} />
      ) : null}
      {data && page > 1 && data.data.length === 0 ? (
        <Link href={listHref("/admin/providers", values, 1)} className={buttonSecondary}>
          Back to the first page
        </Link>
      ) : null}
    </div>
  );
}

/**
 * The decision panel. Approval needs every required group of the provider's type satisfied
 * (ADR 0009). The page shows the block BEFORE anyone clicks (from the same rule), and the API
 * enforces it anyway: a 409 REQUIRED_DOCUMENTS_MISSING is shown the same way.
 */
function DecisionPanel({
  provider,
  missing,
  requirementsKnown,
  onDecided,
}: {
  provider: AdminProvider;
  missing: string[];
  requirementsKnown: boolean;
  onDecided: (
    provider: AdminProvider,
    audit: AuditEntry | null,
    decision: "approve" | "reject",
  ) => void;
}) {
  const request = useAdminRequest();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocked = missing.length > 0;

  async function decide(decision: "approve" | "reject", reason?: string) {
    setBusy(true);
    setError(null);
    try {
      const body = await request<{ data: AdminProvider }>(
        `/providers/${provider.id}/verification/${decision}`,
        { method: "POST", body: reason ? { reason } : {} },
      );
      // The audit row is written by the API in the same transaction; read it back to confirm.
      const audit = await request<Paged<AuditEntry>>(
        `/audit-log?entityType=provider&entityId=${provider.id}&action=provider.verification.${decision}&pageSize=1`,
      ).catch(() => null);
      onDecided(body.data, audit?.data[0] ?? null, decision);
    } catch (err) {
      setError(describeAdminError(err));
    } finally {
      setBusy(false);
    }
  }

  function onReject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const reason = String(new FormData(event.currentTarget).get("reason") ?? "").trim();
    if (reason.length < 3) {
      setError("Give a reason (at least 3 characters) to reject.");
      return;
    }
    void decide("reject", reason);
  }

  return (
    <Panel title="Decision">
      <div className="space-y-4">
        {blocked ? (
          <div data-testid="approval-blocked">
            <Alert>
              Approval is blocked: no document for {missing.join(", ")}. Ask the provider to add it,
              or reject with a reason.
            </Alert>
          </div>
        ) : !requirementsKnown ? (
          <Alert tone="info">
            This kind of business isn&apos;t offered, so its requirements aren&apos;t listed here.
            The API still checks them when you approve.
          </Alert>
        ) : null}
        {error ? (
          <div data-testid="decision-error">
            <Alert>{error}</Alert>
          </div>
        ) : null}
        <button
          type="button"
          className={buttonPrimary}
          disabled={busy || blocked}
          aria-describedby={blocked ? "approval-blocked-reason" : undefined}
          onClick={() => void decide("approve")}
        >
          Approve provider
        </button>
        {blocked ? (
          <p id="approval-blocked-reason" className="text-sm text-slate-600">
            Approve stays disabled until every required group has a document.
          </p>
        ) : null}
        <form onSubmit={onReject} className="space-y-2 border-t border-mist pt-4">
          <label className={labelClass}>
            Reason for rejecting (shown to the provider)
            <textarea
              name="reason"
              rows={3}
              minLength={3}
              maxLength={1000}
              required
              className={inputClass}
            />
          </label>
          <button type="submit" className={buttonSecondary} disabled={busy}>
            Reject
          </button>
        </form>
      </div>
    </Panel>
  );
}

/** /admin/providers/[id]: profile, owner, masked payout account, documents, requirements, decision. */
export function ProviderReview() {
  const params = useParams<{ id: string }>();
  const types = useProviderTypes();
  const { data, error, setData } = useAdminData<{ data: AdminProvider }>(
    `/providers/${encodeURIComponent(params.id)}`,
  );
  const [outcome, setOutcome] = useState<{
    decision: "approve" | "reject";
    audit: AuditEntry | null;
  } | null>(null);

  if (error)
    return <AdminError view={error} backHref="/admin/providers" backLabel="Back to providers" />;
  if (!data || types === null) return <p className="text-sm text-slate-600">Loading provider…</p>;
  const p = data.data;
  const groups = types.find((t) => t.code === p.providerType.code)?.requiredDocuments;
  const checklist = requirementChecklist(groups ?? [], p.documentList);
  const missing = checklist.filter((r) => r.state === "missing").map((r) => r.label);
  const account = p.payoutAccount;

  return (
    <div className="space-y-4">
      {outcome ? (
        <div data-testid="decision-outcome">
          <Alert tone="success">
            {outcome.decision === "approve"
              ? "Approved: the provider is verified."
              : "Rejected: the provider can fix and resubmit."}{" "}
            {outcome.audit ? (
              <>
                Audit entry recorded {formatTimestamp(outcome.audit.createdAt)} (
                {outcome.audit.action}).{" "}
                <Link
                  href={`/admin/audit-log?entityType=provider&entityId=${p.id}`}
                  className="font-semibold underline"
                >
                  View in the audit log
                </Link>
              </>
            ) : (
              "The audit entry could not be loaded; check the audit log."
            )}
          </Alert>
        </div>
      ) : null}

      <Panel
        title={p.displayName}
        actions={
          <StatusPill label={providerStatusLabel(p.status)} tone={providerStatusTone(p.status)} />
        }
      >
        <Facts
          rows={[
            { label: "Legal name", value: p.legalName },
            { label: "Kind", value: p.providerType.name },
            { label: "Owner", value: p.owner.fullName },
            { label: "Owner email", value: p.owner.email ?? "—" },
            { label: "Owner phone", value: p.owner.phone ?? "—" },
            { label: "Business phone", value: p.contact.phone ?? "—" },
            { label: "PAN", value: p.tax.panNumber ?? "—" },
            { label: "VAT", value: p.tax.vatNumber ?? "—" },
            { label: "Registration no.", value: p.tax.businessRegistrationNo ?? "—" },
            {
              label: "Commission",
              value:
                p.commissionRateBps === null
                  ? "Platform rate"
                  : bpsToPercentText(p.commissionRateBps),
            },
            { label: "Verified", value: p.verifiedAt ? formatTimestamp(p.verifiedAt) : "—" },
            ...(p.rejectionReason ? [{ label: "Rejection reason", value: p.rejectionReason }] : []),
          ]}
        />
      </Panel>

      <Panel title="Listing rules">
        <p className="text-sm text-ink" data-testid="provider-listing-rules">
          {p.providerType.allowedListingTypes.length > 0
            ? `May list: ${p.providerType.allowedListingTypes.map((t) => t.name).join(", ")}`
            : "May list nothing right now (its kind of business, or its listing types, are not offered)."}
        </p>
        <p className="mt-2 flex flex-wrap gap-3 text-sm">
          <Link
            href={`/admin/invoices?providerId=${p.id}`}
            className="font-semibold text-navy underline"
          >
            This provider&apos;s invoices
          </Link>
          <Link
            href={`/admin/payouts?providerId=${p.id}`}
            className="font-semibold text-navy underline"
          >
            This provider&apos;s payouts
          </Link>
          <Link href="/admin/listing-rules" className="font-semibold text-navy underline">
            All listing rules
          </Link>
        </p>
      </Panel>

      <Panel title="Payout account">
        <p className="text-sm text-ink">{payoutAccountSummary(account)}</p>
        {account ? (
          <p className="mt-1 text-sm text-slate-600">
            {account.accountName} ·{" "}
            <span data-testid="admin-account-masked">
              {safeMaskedAccountNumber(account.accountNumberMasked)}
            </span>{" "}
            · {account.verified ? "verified" : "not verified (approval verifies it)"}
          </p>
        ) : null}
      </Panel>

      <Panel title="Required documents">
        {groups ? (
          <ul className="space-y-2" data-testid="admin-requirements">
            {checklist.map((row) => (
              <li
                key={row.requirement}
                data-requirement={row.requirement}
                data-state={row.state}
                className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-mist p-3 text-sm"
              >
                <span>
                  <span className="block font-semibold text-ink">{row.label}</span>
                  <span className="block text-slate-600">
                    One of: {row.acceptedDocumentTypes.map(documentTypeLabel).join(", ")}
                  </span>
                </span>
                <StatusPill
                  label={
                    row.state === "approved"
                      ? "Approved"
                      : row.state === "pending"
                        ? "Provided"
                        : "Missing"
                  }
                  tone={
                    row.state === "missing" ? "bad" : row.state === "approved" ? "good" : "neutral"
                  }
                />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-slate-600">
            This kind of business isn&apos;t offered; no requirements are published.
          </p>
        )}
        <p className="mt-2 text-xs text-slate-600">
          A pending or approved document satisfies a group; a rejected one never does.
        </p>
      </Panel>

      <Panel title="Documents">
        {p.documentList.length === 0 ? (
          <p className="text-sm text-slate-600">No documents.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className={tableClass}>
              <thead>
                <tr>
                  <th className={thClass}>Document</th>
                  <th className={thClass}>Status</th>
                  <th className={thClass}>File</th>
                  <th className={thClass}>Added</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-mist">
                {p.documentList.map((doc) => (
                  <tr key={doc.id}>
                    <td className={tdClass}>
                      {documentTypeLabel(doc.documentType)}
                      {doc.documentNumber ? (
                        <span className="block text-slate-600">No. {doc.documentNumber}</span>
                      ) : null}
                    </td>
                    <td className={tdClass}>
                      {documentStatusLabel(doc.status)}
                      {doc.rejectionReason ? (
                        <span className="block text-slate-600">{doc.rejectionReason}</span>
                      ) : null}
                    </td>
                    <td className={tdClass}>
                      {doc.fileName ? <span className="block">{doc.fileName}</span> : null}
                      <span className="block text-slate-600">{formatFileSize(doc.sizeBytes)}</span>
                      {doc.hasFile ? (
                        // Private: the API checks the admin role; each view is audited (ADR 0016).
                        <a
                          href={adminDocumentFileHref(p.id, doc.id)}
                          className="mt-1 inline-block font-medium text-navy underline"
                          data-testid="admin-document-file"
                        >
                          Open file
                        </a>
                      ) : (
                        <span className="block text-slate-600">No file uploaded yet</span>
                      )}
                    </td>
                    <td className={tdClass}>{formatTimestamp(doc.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <ProviderPoliciesPanel providerId={p.id} />

      {p.status === "PENDING_VERIFICATION" ? (
        <DecisionPanel
          provider={p}
          missing={missing}
          requirementsKnown={Boolean(groups)}
          onDecided={(next, audit, decision) => {
            setData({ data: next });
            setOutcome({ decision, audit });
          }}
        />
      ) : null}
    </div>
  );
}

/** A provider's cancellation policies, read-only (ADR 0015): editing is the partner's. */
function ProviderPoliciesPanel({ providerId }: { providerId: string }) {
  const { data, error } = useAdminData<{ data: PolicyList }>(
    `/providers/${encodeURIComponent(providerId)}/cancellation-policies`,
  );
  return (
    <Panel title="Cancellation policies (read-only)">
      {error ? (
        <p className="text-sm text-slate-600">The policies could not be loaded.</p>
      ) : !data ? (
        <p className="text-sm text-slate-600">Loading…</p>
      ) : data.data.policies.length === 0 ? (
        <p className="text-sm text-slate-600" data-testid="admin-no-policies">
          This business has no cancellation policies: its listings show customers that none applies.
        </p>
      ) : (
        <ul className="space-y-2" data-testid="admin-policy-list">
          {data.data.policies.map((policy) => (
            <li key={policy.id} className="rounded-lg border border-mist p-3 text-sm">
              <span className="font-medium text-navy">{policy.name}</span>
              {policy.id === data.data.defaultPolicyId ? " · default" : ""}
              {policy.isActive ? "" : " · off"}
              <span className="block text-ink">{policySummary(policy)}</span>
              <span className="block text-xs text-slate-500">
                Used by {policy.usage?.listings ?? 0} listing(s)
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
