import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type request from "supertest";
import { LocalDiskStorage } from "../lib/storage/index.js";

/**
 * Document upload helpers for tests (ADR 0016). Storage is a fresh temporary directory on the
 * local disk: no cloud, no secrets, nothing shared between test files.
 */
export function testStorage(): { storage: LocalDiskStorage; directory: string } {
  const directory = mkdtempSync(join(tmpdir(), "merostay-docs-"));
  return { storage: new LocalDiskStorage(directory), directory };
}

/** A tiny but well-formed PDF (signature, one object, trailer), unique per label. */
export function samplePdf(label = "document"): Buffer {
  return Buffer.from(
    `%PDF-1.4\n1 0 obj << /Title (${label}) >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n`,
    "latin1",
  );
}

type Agent = ReturnType<typeof request.agent>;

/**
 * request → upload → (confirm): the partner flow through the API. Returns the document id and
 * each response; expects every step to succeed.
 */
export async function uploadDocument(
  agent: Agent,
  csrfToken: string,
  input: {
    documentType: string;
    bytes?: Buffer;
    mimeType?: string;
    fileName?: string;
    documentNumber?: string;
  },
  options: { confirm?: boolean } = {},
): Promise<{ id: string; requested: request.Response; uploaded: request.Response }> {
  const bytes = input.bytes ?? samplePdf(input.documentType);
  const mimeType = input.mimeType ?? "application/pdf";
  const requested = await agent
    .post("/api/v1/partner/verification-documents")
    .set("X-CSRF-Token", csrfToken)
    .send({
      documentType: input.documentType,
      fileName: input.fileName ?? `${input.documentType.toLowerCase()}.pdf`,
      mimeType,
      sizeBytes: bytes.length,
      ...(input.documentNumber ? { documentNumber: input.documentNumber } : {}),
    });
  if (requested.status !== 201) {
    throw new Error(`request → ${requested.status} ${JSON.stringify(requested.body)}`);
  }
  const id = (requested.body as { data: { id: string } }).data.id;
  const uploaded = await agent
    .put(`/api/v1/partner/verification-documents/${id}/file`)
    .set("X-CSRF-Token", csrfToken)
    .set("Content-Type", mimeType)
    .send(bytes);
  if (uploaded.status !== 200) {
    throw new Error(`upload → ${uploaded.status} ${JSON.stringify(uploaded.body)}`);
  }
  if (options.confirm !== false) {
    const confirmed = await agent
      .post(`/api/v1/partner/verification-documents/${id}/confirm`)
      .set("X-CSRF-Token", csrfToken)
      .send({});
    if (confirmed.status !== 200) {
      throw new Error(`confirm → ${confirmed.status} ${JSON.stringify(confirmed.body)}`);
    }
  }
  return { id, requested, uploaded };
}
