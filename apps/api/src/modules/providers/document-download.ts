import type { Response } from "express";
import { safeFileName } from "../../lib/document-content.js";

/**
 * Sends a verification document's file to an authorised caller (ADR 0016): the stored type,
 * always as an attachment, never cached, and sandboxed so a crafted file cannot run as a page.
 */
export function sendDocumentFile(
  res: Response,
  doc: { fileName: string | null; mimeType: string; documentType: string },
  body: Buffer,
): void {
  const name = safeFileName(doc.fileName ?? `${doc.documentType.toLowerCase()}`);
  const ascii = name.replace(/[^\x20-\x7e]/g, "_");
  res.setHeader("Content-Type", doc.mimeType);
  res.setHeader("Content-Length", String(body.length));
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
  );
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  res.status(200).end(body);
}
