import { createHash } from "node:crypto";

/**
 * Columns a seeded document needs when it is inserted directly as PENDING or APPROVED: since
 * ADR 0016 such a document must have an uploaded file (time + SHA-256). Seeding writes no object:
 * these rows are setup that is not under test, so their file is "uploaded" but not readable.
 */
export function seededFileFields(label: string) {
  return {
    fileName: `${label}.pdf`,
    uploadedAt: new Date(),
    sha256: createHash("sha256").update(`seeded:${label}`).digest("hex"),
  };
}
