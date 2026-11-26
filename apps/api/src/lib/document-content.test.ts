import { describe, expect, it } from "vitest";
import {
  DocumentContentError,
  safeFileName,
  sniffDocumentType,
  stripDocumentMetadata,
} from "./document-content.js";

const u16 = (n: number) => Buffer.from([n >> 8, n & 0xff]);
const segment = (marker: number, payload: string) =>
  Buffer.concat([
    Buffer.from([0xff, marker]),
    u16(payload.length + 2),
    Buffer.from(payload, "latin1"),
  ]);
const SCAN = Buffer.from([0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0x3f, 0, 0xaa, 0xbb, 0xff, 0xd9]);
const jpeg = (...segments: Buffer[]) =>
  Buffer.concat([Buffer.from([0xff, 0xd8]), ...segments, SCAN]);

const chunk = (type: string, data: string) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([
    length,
    Buffer.from(type, "latin1"),
    Buffer.from(data, "latin1"),
    Buffer.alloc(4),
  ]);
};
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (...chunks: Buffer[]) => Buffer.concat([PNG_SIG, ...chunks, chunk("IEND", "")]);

describe("type sniffing (from the bytes, never the name)", () => {
  it("recognises PDF, PNG and JPEG signatures and nothing else", () => {
    expect(sniffDocumentType(Buffer.from("%PDF-1.7\n"))).toBe("application/pdf");
    expect(sniffDocumentType(png(chunk("IHDR", "x".repeat(13))))).toBe("image/png");
    expect(sniffDocumentType(jpeg())).toBe("image/jpeg");
    expect(sniffDocumentType(Buffer.from("<html>"))).toBeNull();
    expect(sniffDocumentType(Buffer.from("GIF89a"))).toBeNull();
    expect(sniffDocumentType(Buffer.from([0xff, 0xd8]))).toBeNull();
    expect(sniffDocumentType(Buffer.alloc(0))).toBeNull();
  });
});

describe("metadata stripping", () => {
  it("JPEG: drops EXIF/XMP (APP1), IPTC (APP13) and comments; keeps JFIF, ICC and the image data", () => {
    const input = jpeg(
      segment(0xe0, "JFIF\0"),
      segment(0xe1, "Exif\0\0GPS 27.7N 85.3E"),
      segment(0xe2, "ICC_PROFILE\0"),
      segment(0xed, "Photoshop 3.0 IPTC author"),
      segment(0xfe, "taken by a phone"),
    );
    const out = stripDocumentMetadata(input, "image/jpeg").toString("latin1");
    expect(out).not.toMatch(/Exif|GPS|IPTC|taken by/);
    expect(out).toContain("JFIF");
    expect(out).toContain("ICC_PROFILE");
    expect(out.endsWith(SCAN.toString("latin1"))).toBe(true);
  });

  it("PNG: drops text, EXIF and time chunks; keeps the rest byte for byte", () => {
    const ihdr = chunk("IHDR", "y".repeat(13));
    const idat = chunk("IDAT", "pixels");
    const input = png(
      ihdr,
      chunk("tEXt", "Author\0Maya"),
      chunk("eXIf", "GPS"),
      chunk("tIME", "1234567"),
      idat,
    );
    const out = stripDocumentMetadata(input, "image/png");
    expect(out).toEqual(Buffer.concat([PNG_SIG, ihdr, idat, chunk("IEND", "")]));
  });

  it("PDF is stored as uploaded (stripping PDF metadata is a recorded gap)", () => {
    const pdf = Buffer.from("%PDF-1.4\n/Author (Maya)\n%%EOF");
    expect(stripDocumentMetadata(pdf, "application/pdf")).toBe(pdf);
  });

  it("refuses truncated or malformed images instead of storing them", () => {
    const truncatedJpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      Buffer.from([0xff, 0xe1, 0x10, 0x00, 0x01]),
    ]);
    expect(() => stripDocumentMetadata(truncatedJpeg, "image/jpeg")).toThrow(DocumentContentError);
    expect(() =>
      stripDocumentMetadata(Buffer.from([0xff, 0xd8, 0x00, 0x00]), "image/jpeg"),
    ).toThrow(DocumentContentError);
    const noEnd = Buffer.concat([PNG_SIG, chunk("IHDR", "z".repeat(13))]);
    expect(() => stripDocumentMetadata(noEnd, "image/png")).toThrow(DocumentContentError);
    const lying = Buffer.concat([PNG_SIG, Buffer.from([0, 0, 0xff, 0xff]), Buffer.from("IDAT")]);
    expect(() => stripDocumentMetadata(lying, "image/png")).toThrow(DocumentContentError);
  });
});

describe("display file names", () => {
  it("keeps only the last path segment, without control or quoting characters", () => {
    expect(safeFileName("C:\\Users\\maya\\citizenship.pdf")).toBe("citizenship.pdf");
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName('my "id"\r\n.pdf')).toBe("my id.pdf");
    expect(safeFileName("नागरिकता.pdf")).toBe("नागरिकता.pdf");
    expect(safeFileName("   ")).toBe("document");
    expect(safeFileName("a".repeat(300)).length).toBe(200);
  });
});
