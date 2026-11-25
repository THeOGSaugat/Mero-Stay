"use client";

import { useEffect, useState, type FormEvent } from "react";
import { apiRequest } from "@/lib/api-client";
import { describePartnerError } from "@/lib/partner-access";
import {
  DOCUMENT_TYPES,
  documentStatusLabel,
  documentTypeLabel,
  formatFileSize,
  formatTimestamp,
  providerStatusLabel,
  requirementChecklist,
} from "@/lib/partner-display";
import type { PartnerProfile, ProviderTypeOffer, VerificationDocument } from "@/lib/partner-types";
import { formatServiceDate } from "@/lib/trip-display";
import { Alert, buttonPrimary, inputClass, labelClass, StatusPill } from "../ui/primitives";
import { usePartner } from "./partner-context";
import { Panel, PartnerError, tableClass, tdClass, thClass, usePartnerData } from "./partner-ui";
import { providerStatusTone } from "./profile-view";

const ALLOWED_MIME = ["application/pdf", "image/jpeg", "image/png", "image/webp"];
const MAX_BYTES = 10 * 1024 * 1024;

function documentTone(status: string): "good" | "wait" | "bad" {
  return status === "APPROVED" ? "good" : status === "REJECTED" ? "bad" : "wait";
}

/**
 * /partner/verification: the required-document groups of the business's type (ADR 0009) with
 * which are satisfied, the documents and their review status, adding a document, and submitting
 * for verification.
 *
 * File upload is not built yet (operational gap 14, Phase 10): the browser reads the chosen file's
 * type and size, and only those details are recorded. The file never leaves the device.
 */
export function VerificationView() {
  const { profile, request, setProfile } = usePartner();
  const docs = usePartnerData<{ data: VerificationDocument[] }>("/verification-documents");
  const [types, setTypes] = useState<ProviderTypeOffer[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiRequest<{ data: ProviderTypeOffer[] }>("/provider-types")
      .then((body) => !cancelled && setTypes(body.data))
      .catch(() => !cancelled && setTypes([]));
    return () => {
      cancelled = true;
    };
  }, []);

  if (docs.error) return <PartnerError view={docs.error} />;
  if (!docs.data || types === null) return <p className="text-sm text-slate-600">Loading…</p>;

  const groups = types.find((t) => t.code === profile.providerType.code)?.requiredDocuments ?? [];
  const checklist = requirementChecklist(groups, docs.data.data);
  const canSubmit = profile.status === "DRAFT" || profile.status === "REJECTED";
  const suggested = [
    ...new Set([...groups.flatMap((g) => g.acceptedDocumentTypes), ...DOCUMENT_TYPES]),
  ];

  async function onAddDocument(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) {
      setError("Choose the document file.");
      return;
    }
    if (!ALLOWED_MIME.includes(file.type)) {
      setError("The file must be a PDF, JPEG, PNG or WebP.");
      return;
    }
    if (file.size > MAX_BYTES) {
      setError("The file must be 10 MB or smaller.");
      return;
    }
    const text = (name: string) => String(form.get(name) ?? "").trim() || null;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await request("/verification-documents", {
        method: "POST",
        headers: { "Idempotency-Key": `doc-${crypto.randomUUID()}` },
        body: {
          documentType: String(form.get("documentType")),
          // Not uploaded: an honest placeholder key until private storage exists (gap 14).
          storageKey: `not-uploaded/${crypto.randomUUID()}`,
          mimeType: file.type,
          sizeBytes: file.size,
          documentNumber: text("documentNumber"),
          expiresOn: text("expiresOn"),
        },
      });
      formElement.reset();
      setNotice("Document details recorded.");
      docs.reload();
    } catch (err) {
      setError(describePartnerError(err));
    } finally {
      setBusy(false);
    }
  }

  async function onSubmitForVerification() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const body = await request<{ data: { changed: boolean; provider: PartnerProfile } }>(
        "/verification/submit",
        { method: "POST", body: {} },
      );
      setProfile(body.data.provider);
      setNotice("Submitted. MeroStay will review your documents.");
    } catch (err) {
      setError(describePartnerError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {error ? <Alert>{error}</Alert> : null}

      <Panel
        title="Verification"
        actions={
          <StatusPill
            label={providerStatusLabel(profile.status)}
            tone={providerStatusTone(profile.status)}
          />
        }
      >
        {profile.status === "REJECTED" && profile.rejectionReason ? (
          <div className="mb-3">
            <Alert>MeroStay asked for changes: {profile.rejectionReason}</Alert>
          </div>
        ) : null}
        <h3 className="mb-2 text-sm font-semibold text-navy">
          Required for {profile.providerType.name.toLowerCase()}
        </h3>
        <ul className="space-y-2" data-testid="requirement-checklist">
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
                  row.state === "approved" ? "good" : row.state === "pending" ? "neutral" : "wait"
                }
              />
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-slate-600">
          Rejected documents don&apos;t count; add a new one.
        </p>
        {canSubmit ? (
          <button
            type="button"
            className={`${buttonPrimary} mt-4`}
            disabled={busy}
            onClick={onSubmitForVerification}
          >
            Submit for verification
          </button>
        ) : null}
      </Panel>

      <Panel title="Your documents">
        {docs.data.data.length === 0 ? (
          <p className="text-sm text-slate-600">No documents yet.</p>
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
                {docs.data.data.map((doc) => (
                  <tr key={doc.id}>
                    <td className={tdClass}>
                      {documentTypeLabel(doc.documentType)}
                      {doc.documentNumber ? (
                        <span className="block text-slate-600">No. {doc.documentNumber}</span>
                      ) : null}
                      {doc.expiresOn ? (
                        <span className="block text-slate-600">
                          Expires {formatServiceDate(doc.expiresOn)}
                        </span>
                      ) : null}
                    </td>
                    <td className={tdClass}>
                      <StatusPill
                        label={documentStatusLabel(doc.status)}
                        tone={documentTone(doc.status)}
                      />
                      {doc.rejectionReason ? (
                        <span className="mt-1 block text-red-900">{doc.rejectionReason}</span>
                      ) : null}
                    </td>
                    <td className={tdClass}>
                      {doc.mimeType.replace("application/", "").replace("image/", "").toUpperCase()}
                      , {formatFileSize(doc.sizeBytes)}
                    </td>
                    <td className={tdClass}>{formatTimestamp(doc.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {profile.status !== "SUSPENDED" ? (
        <Panel title="Add a document">
          <div className="mb-4">
            <Alert tone="info">
              File upload is coming soon. For now, MeroStay records the document&apos;s type, size
              and number; the file itself stays on your device and is collected when uploads open.
            </Alert>
          </div>
          <form onSubmit={onAddDocument} className="grid gap-4 sm:grid-cols-2">
            <label className={labelClass}>
              Document
              <select
                name="documentType"
                required
                className={inputClass}
                defaultValue={suggested[0]}
              >
                {suggested.map((type) => (
                  <option key={type} value={type}>
                    {documentTypeLabel(type)}
                  </option>
                ))}
              </select>
            </label>
            <label className={labelClass}>
              File (PDF, JPEG, PNG or WebP, up to 10 MB)
              <input
                name="file"
                type="file"
                required
                accept="application/pdf,image/jpeg,image/png,image/webp"
                className={`${inputClass} py-1.5`}
              />
            </label>
            <label className={labelClass}>
              Document number (optional)
              <input name="documentNumber" maxLength={60} className={inputClass} />
            </label>
            <label className={labelClass}>
              Expires on (optional)
              <input name="expiresOn" type="date" className={inputClass} />
            </label>
            <div className="sm:col-span-2">
              <button type="submit" className={buttonPrimary} disabled={busy}>
                {busy ? "Saving…" : "Add document"}
              </button>
            </div>
          </form>
        </Panel>
      ) : null}
    </div>
  );
}
