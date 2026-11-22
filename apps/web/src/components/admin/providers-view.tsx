"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { describeAdminError } from "@/lib/admin-access";
import type { AdminProvider, AdminProviderSummary, AuditEntry } from "@/lib/admin-types";
import { apiRequest } from "@/lib/api-client";
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
import type { Paged, ProviderTypeOffer } from "@/lib/partner-types";
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
import { AdminError, useAdminData, useAdminRequest } from "./admin-ui";

const STATUSES = ["", "PENDING_VERIFICATION", "DRAFT", "VERIFIED", "REJECTED", "SUSPENDED"];

/** Provider types for filters and requirement groups (public: offered types only, ADR 0009). */
function useProviderTypes(): ProviderTypeOffer[] | null {
  const [types, setTypes] = useState<ProviderTypeOffer[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    apiRequest<{ data: ProviderTypeOffer[] }>("/provider-types")
      .then((body) => !cancelled && setTypes(body.data))
      .catch(() => !cancelled && setTypes([]));
    return () => {
      cancelled = true;
    };
  }, []);
  return types;
}

/** /admin/providers: every provider, filtered by type and verification status, paginated. */
export function ProviderList() {
  const search = useSearchParams();
  const router = useRouter();
  const types = useProviderTypes();
  const page = Math.max(1, Number.parseInt(search.get("page") ?? "1", 10) || 1);
  const status = search.get("status") ?? "";
  const providerType = search.get("providerType") ?? "";
  const query = new URLSearchParams({ page: String(page), pageSize: "20" });
  if (status) query.set("status", status);
  if (providerType) query.set("providerType", providerType);
  const { data, error } = useAdminData<Paged<AdminProviderSummary>>(
    `/providers?${query.toString()}`,
  );

  const hrefWith = (next: Record<string, string>) => {
    const q = new URLSearchParams({ status, providerType, ...next });
    for (const [k, v] of [...q.entries()]) if (!v) q.delete(k);
    const text = q.toString();
    return text ? `/admin/providers?${text}` : "/admin/providers";
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:max-w-2xl">
        <label className={labelClass}>
          Verification status
          <select
            className={inputClass}
            value={status}
            onChange={(e) => router.push(hrefWith({ status: e.target.value, page: "" }))}
          >
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
            className={inputClass}
            value={providerType}
            onChange={(e) => router.push(hrefWith({ providerType: e.target.value, page: "" }))}
          >
            <option value="">All</option>
            {types?.map((t) => (
              <option key={t.code} value={t.code}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
      </div>
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
      {data ? <Pager page={data.page} hrefFor={(p) => hrefWith({ page: String(p) })} /> : null}
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
                      {formatFileSize(doc.sizeBytes)}
                      {doc.storageKey.startsWith("not-uploaded/") ? (
                        <span className="block text-slate-600">
                          File not uploaded (uploads come later)
                        </span>
                      ) : null}
                    </td>
                    <td className={tdClass}>{formatTimestamp(doc.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

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
