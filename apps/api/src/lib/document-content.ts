/**
 * Checks and cleans an uploaded verification document (ADR 0016, security guidelines §6).
 *
 * - The real type comes from the file's first bytes, never from its name or the client's header.
 * - JPEG and PNG lose their metadata (EXIF, including GPS; comments; text chunks) before storage:
 *   the bytes are copied without those segments/chunks; the image data is untouched.
 * - PDFs are stored as uploaded (stripping PDF metadata needs a PDF library: a recorded gap).
 */

export const DOCUMENT_MIME_TYPES = ["application/pdf", "image/jpeg", "image/png"] as const;
export type DocumentMimeType = (typeof DOCUMENT_MIME_TYPES)[number];
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The type the bytes really are (by signature), or null for anything else. */
export function sniffDocumentType(bytes: Buffer): DocumentMimeType | null {
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString("latin1") === "%PDF-") {
    return "application/pdf";
  }
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  return null;
}

export class DocumentContentError extends Error {}

/**
 * JPEG: drops APP1 (EXIF / XMP), APP12, APP13 (IPTC) and COM segments; keeps APP0 (JFIF), APP2
 * (ICC colour profile), APP14 (Adobe colour transform) and everything from the first SOS on.
 */
function stripJpeg(bytes: Buffer): Buffer {
  const drop = new Set([0xe1, 0xec, 0xed, 0xfe]);
  const parts: Buffer[] = [bytes.subarray(0, 2)]; // SOI
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) throw new DocumentContentError("malformed JPEG");
    let marker = bytes[offset + 1];
    // Fill bytes (0xFF 0xFF …) before a marker are allowed.
    const start = offset;
    while (marker === 0xff) {
      offset += 1;
      marker = bytes[offset + 1];
    }
    if (marker === undefined) throw new DocumentContentError("truncated JPEG");
    if (marker === 0xda || marker === 0xd9) {
      // Start of scan (or end of image): the rest is image data, copied as-is.
      parts.push(bytes.subarray(start));
      return Buffer.concat(parts);
    }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      parts.push(bytes.subarray(start, offset + 2));
      offset += 2;
      continue;
    }
    if (offset + 4 > bytes.length) throw new DocumentContentError("truncated JPEG");
    const length = bytes.readUInt16BE(offset + 2);
    const end = offset + 2 + length;
    if (length < 2 || end > bytes.length) throw new DocumentContentError("truncated JPEG");
    if (!drop.has(marker)) parts.push(bytes.subarray(start, end));
    offset = end;
  }
  throw new DocumentContentError("JPEG has no image data");
}

/** PNG: drops tEXt, zTXt, iTXt, eXIf and tIME chunks; keeps every other chunk byte for byte. */
function stripPng(bytes: Buffer): Buffer {
  const drop = new Set(["tEXt", "zTXt", "iTXt", "eXIf", "tIME"]);
  const parts: Buffer[] = [PNG_SIGNATURE];
  let offset = 8;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw new DocumentContentError("truncated PNG");
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("latin1");
    const end = offset + 12 + length;
    if (end > bytes.length) throw new DocumentContentError("truncated PNG");
    if (!drop.has(type)) parts.push(bytes.subarray(offset, end));
    offset = end;
    if (type === "IEND") return Buffer.concat(parts);
  }
  throw new DocumentContentError("PNG has no end chunk");
}

/** The bytes to store: metadata removed for JPEG and PNG, unchanged for PDF. */
export function stripDocumentMetadata(bytes: Buffer, type: DocumentMimeType): Buffer {
  if (type === "image/jpeg") return stripJpeg(bytes);
  if (type === "image/png") return stripPng(bytes);
  return bytes;
}

/**
 * A display name safe to store and to send back in Content-Disposition: the last path segment,
 * control and quoting characters removed, at most 200 characters. Never used as a path.
 */
export function safeFileName(raw: string): string {
  const last = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = last
    // Control characters (U+0000–U+001F, U+007F) and characters that break quoting or paths.
    .replace(/[\p{Cc}"<>|*?:;]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  return cleaned || "document";
}
