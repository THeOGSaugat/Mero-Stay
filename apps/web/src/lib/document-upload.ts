import { ApiError } from "./api-client";
import type { DocumentStatus, ProviderStatus } from "./partner-types";

/**
 * Verification document uploads in the browser (ADR 0016, gap 14). Pure, so it is unit-tested.
 *
 * request (type, size, name) → upload the file itself → confirm it for review. The browser checks
 * type and size first to save a wasted upload; the API checks again from the file's own bytes.
 */

export const DOCUMENT_FILE_TYPES = ["application/pdf", "image/jpeg", "image/png"] as const;
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

/** A problem with the chosen file, in words, or null when it can be sent. */
export function checkDocumentFile(file: { type: string; size: number } | null): string | null {
  if (!file || file.size === 0) return "Choose the document file.";
  if (!(DOCUMENT_FILE_TYPES as readonly string[]).includes(file.type)) {
    return "The file must be a PDF, JPEG or PNG.";
  }
  if (file.size > MAX_DOCUMENT_BYTES) return "The file must be 10 MB or smaller.";
  return null;
}

export type UploadStep = "requesting" | "uploading" | "confirming";

export function uploadStepLabel(step: UploadStep): string {
  return {
    requesting: "Preparing the upload…",
    uploading: "Uploading the file…",
    confirming: "Sending it for review…",
  }[step];
}

/** The API path the owner downloads its own file from (same origin, with the session cookie). */
export function documentFileHref(documentId: string): string {
  return `/api/v1/partner/verification-documents/${encodeURIComponent(documentId)}/file`;
}

/** The admin's path for a provider's document file (each view is audited). */
export function adminDocumentFileHref(providerId: string, documentId: string): string {
  return `/api/v1/admin/providers/${encodeURIComponent(providerId)}/documents/${encodeURIComponent(documentId)}/file`;
}

/**
 * Whether the partner may delete a document: never an approved one, and not one under review
 * while MeroStay is deciding (the API enforces the same).
 */
export function canDeleteDocument(status: DocumentStatus, providerStatus: ProviderStatus): boolean {
  if (status === "APPROVED") return false;
  if (status === "PENDING" && providerStatus === "PENDING_VERIFICATION") return false;
  return providerStatus !== "SUSPENDED";
}

/** Upload errors in words; null = not an upload-specific error (use the general message). */
export function describeUploadError(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  switch (error.code) {
    case "DOCUMENT_CONTENT_INVALID":
      return "That file isn't a readable PDF, JPEG or PNG. Export or scan it again and retry.";
    case "DOCUMENT_TYPE_MISMATCH":
    case "UNSUPPORTED_MEDIA_TYPE":
      return "The file type changed during upload. Choose the file again.";
    case "DOCUMENT_SIZE_MISMATCH":
      return "The file changed during upload. Choose it again.";
    case "PAYLOAD_TOO_LARGE":
      return "The file must be 10 MB or smaller.";
    case "STORAGE_UNAVAILABLE":
      return "Uploads are not available right now. Try again later.";
    case "DOCUMENT_APPROVED":
      return "An approved document can't be deleted.";
    case "PROVIDER_UNDER_REVIEW":
      return "Documents under review can't be deleted until MeroStay has decided.";
    default:
      return null;
  }
}
