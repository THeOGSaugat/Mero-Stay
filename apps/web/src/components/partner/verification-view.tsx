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
import {
  canDeleteDocument,
  checkDocumentFile,
  describeUploadError,
  uploadStepLabel,
  type UploadStep,
} from "@/lib/document-upload";
import {
  Alert,
  buttonPrimary,
  buttonSecondary,
  inputClass,
  labelClass,
  StatusPill,
} from "../ui/primitives";
import { usePartner } from "./partner-context";
import { Panel, PartnerError, tableClass, tdClass, thClass, usePartnerData } from "./partner-ui";
import { providerStatusTone } from "./profile-view";

function documentTone(status: string): "good" | "wait" | "bad" {
  return status === "APPROVED" ? "good" : status === "REJECTED" ? "bad" : "wait";
}

/**
 * /partner/verification: the required-document groups of the business's type (ADR 0009) with
 * which are satisfied, the documents and their review status, adding a document, and submitting
 * for verification.
 *
 * Adding a document uploads the file itself (ADR 0016, gap 14): request → upload → confirm for
 * review. The file is private: only this business (and MeroStay admins) can open it, through the
 * API. A document that is not approved can be deleted (its file is removed).
 */
export function VerificationView() {
  const { profile, request, requestFile, setProfile } = usePartner();
  const docs = usePartnerData<{ data: VerificationDocument[] }>("/verification-documents");
  const [types, setTypes] = useState<ProviderTypeOffer[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<UploadStep | null>(null);

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
    const chosen = form.get("file");
    const file = chosen instanceof File ? chosen : null;
    const problem = checkDocumentFile(file);
    if (problem || !file) {
      setError(problem);
      return;
    }
    const text = (name: string) => String(form.get(name) ?? "").trim() || null;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setStep("requesting");
      const created = await request<{ data: VerificationDocument }>("/verification-documents", {
        method: "POST",
        headers: { "Idempotency-Key": `doc-${crypto.randomUUID()}` },
        body: {
          documentType: String(form.get("documentType")),
          fileName: file.name,
          mimeType: file.type,
          sizeBytes: file.size,
          documentNumber: text("documentNumber"),
          expiresOn: text("expiresOn"),
        },
      });
      const id = created.data.id;
      setStep("uploading");
      await request(`/verification-documents/${id}/file`, {
        method: "PUT",
        rawBody: { data: file, contentType: file.type },
      });
      setStep("confirming");
      await request(`/verification-documents/${id}/confirm`, { method: "POST", body: {} });
      formElement.reset();
      setNotice("Document uploaded and sent for review.");
    } catch (err) {
      setError(describeUploadError(err) ?? describePartnerError(err));
    } finally {
      setStep(null);
      setBusy(false);
      docs.reload();
    }
  }

  async function onDocumentAction(
    doc: VerificationDocument,
    action: "open" | "confirm" | "delete",
  ) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (action === "open") {
        const blob = await requestFile(`/verification-documents/${doc.id}/file`);
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = doc.fileName ?? "document";
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
      } else if (action === "confirm") {
        await request(`/verification-documents/${doc.id}/confirm`, { method: "POST", body: {} });
        setNotice("Document sent for review.");
        docs.reload();
      } else {
        await request(`/verification-documents/${doc.id}`, { method: "DELETE" });
        setNotice("Document deleted. Its file was removed.");
        docs.reload();
      }
    } catch (err) {
      setError(describeUploadError(err) ?? describePartnerError(err));
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
          Only documents uploaded and sent for review count. Rejected ones don&apos;t; add a new
          one.
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
                  <th className={thClass}>Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-mist">
                {docs.data.data.map((doc) => (
                  <tr key={doc.id} data-testid="document-row" data-status={doc.status}>
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
                      {doc.fileName ? <span className="block">{doc.fileName}</span> : null}
                      <span className="block text-slate-600">
                        {doc.mimeType
                          .replace("application/", "")
                          .replace("image/", "")
                          .toUpperCase()}
                        , {formatFileSize(doc.sizeBytes)}
                      </span>
                    </td>
                    <td className={tdClass}>{formatTimestamp(doc.createdAt)}</td>
                    <td className={tdClass}>
                      <div className="flex flex-wrap gap-2">
                        {doc.hasFile ? (
                          <button
                            type="button"
                            className={buttonSecondary}
                            disabled={busy}
                            onClick={() => void onDocumentAction(doc, "open")}
                          >
                            Open
                          </button>
                        ) : null}
                        {doc.status === "UPLOADED" ? (
                          <button
                            type="button"
                            className={buttonSecondary}
                            disabled={busy}
                            onClick={() => void onDocumentAction(doc, "confirm")}
                          >
                            Send for review
                          </button>
                        ) : null}
                        {canDeleteDocument(doc.status, profile.status) ? (
                          <button
                            type="button"
                            className={buttonSecondary}
                            disabled={busy}
                            onClick={() => void onDocumentAction(doc, "delete")}
                          >
                            Delete
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {profile.status !== "SUSPENDED" ? (
        <Panel title="Add a document">
          <p className="mb-4 text-sm text-slate-600">
            Your file is stored privately: only your business and MeroStay&apos;s verification team
            can open it. Photos lose their location and camera details before they are stored.
          </p>
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
              File (PDF, JPEG or PNG, up to 10 MB)
              <input
                name="file"
                type="file"
                required
                accept="application/pdf,image/jpeg,image/png"
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
                {step ? uploadStepLabel(step) : busy ? "Working…" : "Upload document"}
              </button>
            </div>
          </form>
        </Panel>
      ) : null}
    </div>
  );
}
