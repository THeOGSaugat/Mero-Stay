import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pino } from "pino";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../../app.js";
import { mapDatabaseError } from "../../lib/database-errors.js";
import type { ErrorResponseBody } from "../../lib/errors.js";
import { createPrismaClient } from "../../lib/prisma.js";
import { testAuthConfig } from "../../testing/auth-config.js";
import { seededFileFields } from "../../testing/documents.js";
import { samplePdf, testStorage, uploadDocument } from "../../testing/document-upload.js";
import { resolveTestDatabase } from "../../testing/test-database.js";

/**
 * Gap 14 (ADR 0016): verification documents are real, private files.
 * request → upload (exact type and size, checked from the bytes; JPEG/PNG metadata removed) →
 * confirm. Only the owning partner and admins can fetch the file; deleting removes it.
 * Storage is a temporary local directory: no cloud and no secrets, also in CI.
 */

vi.setConfig({ testTimeout: 300_000 });

const prisma = createPrismaClient(resolveTestDatabase().pooledUrl);
const { storage, directory } = testStorage();
const app = createApp({
  logger: pino({ level: "silent" }),
  checkDatabase: () => Promise.resolve(),
  prisma,
  auth: testAuthConfig(),
  storage,
});
afterAll(() => prisma.$disconnect());

interface Client {
  agent: ReturnType<typeof request.agent>;
  csrfToken: string;
  userId: string;
}
interface Partner extends Client {
  providerId: string;
}

const codeOf = (res: request.Response) => [res.status, (res.body as ErrorResponseBody).error?.code];
const dataOf = <T>(res: request.Response) => (res.body as { data: T }).data;
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

async function signUp(label: string, appUnderTest = app): Promise<Client> {
  const agent = request.agent(appUnderTest);
  const res = await agent.post("/api/v1/auth/register").send({
    email: `${label}-${randomUUID().slice(0, 8)}@test.local`,
    password: "a long test passphrase",
    fullName: `${label} Person`,
  });
  expect(res.status).toBe(201);
  const body = res.body as { data: { user: { id: string }; csrfToken: string } };
  return { agent, csrfToken: body.data.csrfToken, userId: body.data.user.id };
}

async function partner(label: string, appUnderTest = app): Promise<Partner> {
  const who = await signUp(label, appUnderTest);
  const res = await who.agent
    .post("/api/v1/partner/onboarding")
    .set("X-CSRF-Token", who.csrfToken)
    .send({
      providerTypeCode: "hotel",
      legalName: `${label} Lodge Pvt. Ltd.`,
      displayName: `${label} ${randomUUID().slice(0, 6)}`,
    });
  expect(res.status).toBe(201);
  return { ...who, providerId: dataOf<{ id: string }>(res).id };
}

function requestUpload(who: Client, body: object) {
  return who.agent
    .post("/api/v1/partner/verification-documents")
    .set("X-CSRF-Token", who.csrfToken)
    .send(body);
}
function putFile(who: Client, id: string, contentType: string, bytes: Buffer) {
  return who.agent
    .put(`/api/v1/partner/verification-documents/${id}/file`)
    .set("X-CSRF-Token", who.csrfToken)
    .set("Content-Type", contentType)
    .send(bytes);
}
const getFile = (who: Client, id: string) =>
  who.agent.get(`/api/v1/partner/verification-documents/${id}/file`).buffer(true);

/** Where the object of a document lives on the test disk. */
async function objectPath(documentId: string): Promise<string> {
  const doc = await prisma.providerDocument.findUniqueOrThrow({ where: { id: documentId } });
  return join(directory, doc.storageKey);
}

// A JPEG with an EXIF block (GPS) and a comment, and a PNG with text and EXIF chunks.
const u16 = (n: number) => Buffer.from([n >> 8, n & 0xff]);
const segment = (marker: number, payload: Buffer) =>
  Buffer.concat([Buffer.from([0xff, marker]), u16(payload.length + 2), payload]);
const JPEG_WITH_METADATA = Buffer.concat([
  Buffer.from([0xff, 0xd8]),
  segment(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1")),
  segment(0xe1, Buffer.from("Exif\0\0GPS-SECRET-27.7172N-85.3240E", "latin1")),
  segment(0xfe, Buffer.from("secret comment", "latin1")),
  Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x12, 0x34, 0xff, 0xd9]),
]);
const chunk = (type: string, data: Buffer) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]);
};
const PNG_WITH_METADATA = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0])),
  chunk("tEXt", Buffer.from("Location\0Kathmandu-SECRET", "latin1")),
  chunk("eXIf", Buffer.from("GPS-SECRET", "latin1")),
  chunk("IDAT", Buffer.from([0x78, 0x9c, 0x63, 0x60, 0x00, 0x00])),
  chunk("IEND", Buffer.alloc(0)),
]);

let partnerA: Partner;
let partnerB: Partner;
let admin: Client;
let customer: Client;

beforeAll(async () => {
  partnerA = await partner("docsa");
  partnerB = await partner("docsb");
  customer = await signUp("docscustomer");
  admin = await signUp("docsadmin");
  await prisma.user.update({ where: { id: admin.userId }, data: { role: "ADMIN" } });
});

describe("gap 14: uploading a verification document", () => {
  it("a valid PDF: request → upload → confirm; stored privately with its hash; no key in responses", async () => {
    const pdf = samplePdf("owner-id-a");
    const requested = await requestUpload(partnerA, {
      documentType: "OWNER_ID",
      fileName: "C:\\Users\\maya\\citizenship.pdf",
      mimeType: "application/pdf",
      sizeBytes: pdf.length,
    });
    expect(requested.status).toBe(201);
    const doc = dataOf<{ id: string; status: string; fileName: string; hasFile: boolean }>(
      requested,
    );
    expect(doc).toMatchObject({
      status: "AWAITING_UPLOAD",
      fileName: "citizenship.pdf",
      hasFile: false,
    });
    expect((requested.body as { upload: unknown }).upload).toEqual({
      method: "PUT",
      path: `/api/v1/partner/verification-documents/${doc.id}/file`,
      contentType: "application/pdf",
      sizeBytes: pdf.length,
    });

    const uploaded = await putFile(partnerA, doc.id, "application/pdf", pdf);
    expect([uploaded.status, dataOf<{ status: string }>(uploaded).status]).toEqual([
      200,
      "UPLOADED",
    ]);
    const path = await objectPath(doc.id);
    expect(readFileSync(path)).toEqual(pdf);
    const row = await prisma.providerDocument.findUniqueOrThrow({ where: { id: doc.id } });
    expect(row.sha256).toBe(sha256(pdf));
    expect(row.storageKey).toMatch(
      new RegExp(`^documents/${partnerA.providerId}/${doc.id}/[0-9a-f]{32}$`),
    );

    const confirmed = await partnerA.agent
      .post(`/api/v1/partner/verification-documents/${doc.id}/confirm`)
      .set("X-CSRF-Token", partnerA.csrfToken)
      .send({});
    expect(dataOf<{ changed: boolean; document: { status: string } }>(confirmed)).toMatchObject({
      changed: true,
      document: { status: "PENDING" },
    });
    const list = await partnerA.agent.get("/api/v1/partner/verification-documents");
    expect(JSON.stringify(list.body)).not.toMatch(/storageKey|documents\//);
  });

  it("JPEG and PNG metadata (EXIF/GPS, comments, text chunks) is removed before storage", async () => {
    for (const [bytes, mimeType] of [
      [JPEG_WITH_METADATA, "image/jpeg"],
      [PNG_WITH_METADATA, "image/png"],
    ] as const) {
      const { id } = await uploadDocument(partnerA.agent, partnerA.csrfToken, {
        documentType: "PAN_CERTIFICATE",
        bytes,
        mimeType,
        fileName: "pan.img",
      });
      const stored = readFileSync(await objectPath(id));
      expect(stored.toString("latin1")).not.toMatch(/SECRET|secret comment/);
      expect(stored.length).toBeLessThan(bytes.length);
      expect(stored.subarray(0, 2)).toEqual(bytes.subarray(0, 2)); // still the same kind of file
      const row = await prisma.providerDocument.findUniqueOrThrow({ where: { id } });
      expect([row.sizeBytes, row.sha256]).toEqual([stored.length, sha256(stored)]);
    }
  });

  it("wrong type, wrong size, fake content or too large is refused, and nothing is stored", async () => {
    const pdf = samplePdf("refusals");
    const base = { documentType: "OWNER_ID", fileName: "x.pdf", mimeType: "application/pdf" };
    expect(
      codeOf(await requestUpload(partnerA, { ...base, mimeType: "image/gif", sizeBytes: 10 })),
    ).toEqual([400, "VALIDATION_ERROR"]);
    expect(
      codeOf(await requestUpload(partnerA, { ...base, mimeType: "image/webp", sizeBytes: 10 })),
    ).toEqual([400, "VALIDATION_ERROR"]);
    expect(
      codeOf(await requestUpload(partnerA, { ...base, sizeBytes: 10 * 1024 * 1024 + 1 })),
    ).toEqual([400, "VALIDATION_ERROR"]);

    const requested = await requestUpload(partnerA, { ...base, sizeBytes: pdf.length });
    const id = dataOf<{ id: string }>(requested).id;
    expect(codeOf(await putFile(partnerA, id, "text/plain", pdf))).toEqual([
      415,
      "UNSUPPORTED_MEDIA_TYPE",
    ]);
    expect(codeOf(await putFile(partnerA, id, "image/png", pdf))).toEqual([
      422,
      "DOCUMENT_TYPE_MISMATCH",
    ]);
    expect(
      codeOf(await putFile(partnerA, id, "application/pdf", Buffer.concat([pdf, pdf]))),
    ).toEqual([422, "DOCUMENT_SIZE_MISMATCH"]);
    // Declared as a PDF, but the bytes are an HTML page of the same length.
    const fake = Buffer.alloc(pdf.length, "<html><script>alert(1)</script>");
    expect(codeOf(await putFile(partnerA, id, "application/pdf", fake))).toEqual([
      422,
      "DOCUMENT_CONTENT_INVALID",
    ]);
    const huge = Buffer.alloc(10 * 1024 * 1024 + 1, 0x25);
    expect(codeOf(await putFile(partnerA, id, "application/pdf", huge))).toEqual([
      413,
      "PAYLOAD_TOO_LARGE",
    ]);

    const row = await prisma.providerDocument.findUniqueOrThrow({ where: { id } });
    expect([row.status, row.uploadedAt, row.sha256]).toEqual(["AWAITING_UPLOAD", null, null]);
    expect(existsSync(join(directory, row.storageKey))).toBe(false);
  });

  it("one upload per document; confirming needs the file; confirming again changes nothing", async () => {
    const pdf = samplePdf("once");
    const id = dataOf<{ id: string }>(
      await requestUpload(partnerA, {
        documentType: "OWNER_ID",
        fileName: "once.pdf",
        mimeType: "application/pdf",
        sizeBytes: pdf.length,
      }),
    ).id;
    const confirm = () =>
      partnerA.agent
        .post(`/api/v1/partner/verification-documents/${id}/confirm`)
        .set("X-CSRF-Token", partnerA.csrfToken)
        .send({});
    expect(codeOf(await confirm())).toEqual([409, "DOCUMENT_FILE_MISSING"]);
    expect((await putFile(partnerA, id, "application/pdf", pdf)).status).toBe(200);
    expect(codeOf(await putFile(partnerA, id, "application/pdf", pdf))).toEqual([
      409,
      "DOCUMENT_ALREADY_UPLOADED",
    ]);
    expect(dataOf<{ changed: boolean }>(await confirm()).changed).toBe(true);
    expect(dataOf<{ changed: boolean }>(await confirm()).changed).toBe(false);
    const audits = await prisma.auditLog.count({
      where: { entityId: id, action: "provider.document.submit" },
    });
    expect(audits).toBe(1);
  });
});

describe("gap 14: the file is private", () => {
  let docId: string;
  const pdf = samplePdf("private");

  beforeAll(async () => {
    docId = (
      await uploadDocument(partnerA.agent, partnerA.csrfToken, {
        documentType: "BUSINESS_REGISTRATION",
        bytes: pdf,
        fileName: "registration.pdf",
      })
    ).id;
  });

  it("the owning partner downloads it as an attachment, never cached", async () => {
    const res = await getFile(partnerA, docId);
    expect(res.status).toBe(200);
    expect(Buffer.from(res.body as Buffer)).toEqual(pdf);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="registration\.pdf"/);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.headers["content-security-policy"]).toContain("sandbox");
  });

  it("another partner gets 404 for read, upload and delete; customers 403; visitors 401", async () => {
    expect(codeOf(await getFile(partnerB, docId))).toEqual([404, "DOCUMENT_NOT_FOUND"]);
    expect(codeOf(await putFile(partnerB, docId, "application/pdf", pdf))).toEqual([
      404,
      "DOCUMENT_NOT_FOUND",
    ]);
    const del = await partnerB.agent
      .delete(`/api/v1/partner/verification-documents/${docId}`)
      .set("X-CSRF-Token", partnerB.csrfToken);
    expect(codeOf(del)).toEqual([404, "DOCUMENT_NOT_FOUND"]);
    expect((await getFile(customer, docId)).status).toBe(403);
    expect(
      (await request(app).get(`/api/v1/partner/verification-documents/${docId}/file`)).status,
    ).toBe(401);
    expect(
      (
        await customer.agent.get(
          `/api/v1/admin/providers/${partnerA.providerId}/documents/${docId}/file`,
        )
      ).status,
    ).toBe(403);
  });

  it("an admin can open it (audited as a view); under another provider's id it is not found", async () => {
    const url = `/api/v1/admin/providers/${partnerA.providerId}/documents/${docId}/file`;
    const res = await admin.agent.get(url).buffer(true);
    expect(res.status).toBe(200);
    expect(Buffer.from(res.body as Buffer)).toEqual(pdf);
    const view = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: docId, action: "provider.document.view" },
    });
    expect(view.actorUserId).toBe(admin.userId);
    expect(
      codeOf(
        await admin.agent.get(
          `/api/v1/admin/providers/${partnerB.providerId}/documents/${docId}/file`,
        ),
      ),
    ).toEqual([404, "DOCUMENT_NOT_FOUND"]);
  });
});

describe("gap 14: deleting, counting and the audit trail", () => {
  it("deleting removes the object and all access; an approved document cannot be deleted", async () => {
    const { id } = await uploadDocument(partnerB.agent, partnerB.csrfToken, {
      documentType: "OWNER_ID",
    });
    const path = await objectPath(id);
    expect(existsSync(path)).toBe(true);
    const del = await partnerB.agent
      .delete(`/api/v1/partner/verification-documents/${id}`)
      .set("X-CSRF-Token", partnerB.csrfToken);
    expect(del.status).toBe(204);
    expect(existsSync(path)).toBe(false);
    expect(codeOf(await getFile(partnerB, id))).toEqual([404, "DOCUMENT_NOT_FOUND"]);
    const list = await partnerB.agent.get("/api/v1/partner/verification-documents");
    expect(dataOf<{ id: string }[]>(list).some((d) => d.id === id)).toBe(false);
    const again = await partnerB.agent
      .delete(`/api/v1/partner/verification-documents/${id}`)
      .set("X-CSRF-Token", partnerB.csrfToken);
    expect(codeOf(again)).toEqual([404, "DOCUMENT_NOT_FOUND"]);
    expect(
      (await prisma.providerDocument.findUniqueOrThrow({ where: { id } })).deletedAt,
    ).not.toBeNull();

    const approved = await uploadDocument(partnerB.agent, partnerB.csrfToken, {
      documentType: "PAN_CERTIFICATE",
    });
    await prisma.providerDocument.update({
      where: { id: approved.id },
      data: { status: "APPROVED" },
    });
    const refused = await partnerB.agent
      .delete(`/api/v1/partner/verification-documents/${approved.id}`)
      .set("X-CSRF-Token", partnerB.csrfToken);
    expect(codeOf(refused)).toEqual([409, "DOCUMENT_APPROVED"]);
    expect(existsSync(await objectPath(approved.id))).toBe(true);
  });

  it("only uploaded and confirmed documents count towards verification", async () => {
    const c = await partner("docsc");
    const submit = () =>
      c.agent.post("/api/v1/partner/verification/submit").set("X-CSRF-Token", c.csrfToken).send({});
    await uploadDocument(c.agent, c.csrfToken, { documentType: "OWNER_ID" }, { confirm: false });
    await uploadDocument(
      c.agent,
      c.csrfToken,
      { documentType: "LOCAL_GOVERNMENT_REGISTRATION" },
      { confirm: false },
    );
    expect(codeOf(await submit())).toEqual([409, "NO_PENDING_DOCUMENTS"]);
    const docs = dataOf<{ id: string }[]>(
      await c.agent.get("/api/v1/partner/verification-documents"),
    );
    for (const doc of docs) {
      await c.agent
        .post(`/api/v1/partner/verification-documents/${doc.id}/confirm`)
        .set("X-CSRF-Token", c.csrfToken)
        .send({});
    }
    expect(dataOf<{ changed: boolean }>(await submit()).changed).toBe(true);
  });

  it("audit rows hold metadata only: no bytes, no storage key, no hash", async () => {
    const rows = await prisma.auditLog.findMany({ where: { entityType: "provider_document" } });
    expect(rows.length).toBeGreaterThan(10);
    const docs = await prisma.providerDocument.findMany({
      select: { storageKey: true, sha256: true },
    });
    const all = JSON.stringify(rows);
    expect(all).not.toMatch(/%PDF|JFIF|Exif|SECRET/);
    for (const doc of docs) {
      expect(all).not.toContain(doc.storageKey);
      if (doc.sha256) expect(all).not.toContain(doc.sha256);
    }
    const upload = rows.find((r) => r.action === "provider.document.upload");
    const after = upload?.after as { fileName?: unknown; mimeType?: unknown } | undefined;
    expect([typeof after?.fileName, typeof after?.mimeType]).toEqual(["string", "string"]);
  });
});

describe("gap 14: the database guards the lifecycle", () => {
  const dbCode = async (write: Promise<unknown>) => {
    try {
      await write;
      return "written";
    } catch (err) {
      return mapDatabaseError(err)?.code ?? "unmapped";
    }
  };

  it("no skipping the upload, no replacing a stored file, no changing a tombstone", async () => {
    const pdf = samplePdf("db-guard");
    const id = dataOf<{ id: string }>(
      await requestUpload(partnerB, {
        documentType: "OWNER_ID",
        fileName: "guard.pdf",
        mimeType: "application/pdf",
        sizeBytes: pdf.length,
      }),
    ).id;
    expect(
      await dbCode(prisma.providerDocument.update({ where: { id }, data: { status: "PENDING" } })),
    ).toBe("DOCUMENT_STATE_CONFLICT");
    expect(
      await dbCode(
        prisma.providerDocument.create({
          data: {
            providerId: partnerB.providerId,
            documentType: "OWNER_ID",
            storageKey: `documents/raw/${randomUUID()}`,
            mimeType: "application/pdf",
            sizeBytes: 10,
            status: "PENDING", // a submitted document without a file
          },
        }),
      ),
    ).toBe("DOCUMENT_STATE_CONFLICT");

    await putFile(partnerB, id, "application/pdf", pdf);
    expect(
      await dbCode(
        prisma.providerDocument.update({ where: { id }, data: { sha256: "f".repeat(64) } }),
      ),
    ).toBe("DOCUMENT_STATE_CONFLICT");
    await prisma.providerDocument.update({ where: { id }, data: { deletedAt: new Date() } });
    expect(
      await dbCode(prisma.providerDocument.update({ where: { id }, data: { status: "PENDING" } })),
    ).toBe("DOCUMENT_STATE_CONFLICT");
    // Seeded rows may be inserted as submitted, with a file (setup that is not under test).
    expect(
      await dbCode(
        prisma.providerDocument.create({
          data: {
            providerId: partnerB.providerId,
            documentType: "OWNER_ID",
            storageKey: `documents/raw/${randomUUID()}`,
            mimeType: "application/pdf",
            sizeBytes: 10,
            status: "PENDING",
            ...seededFileFields("guard-ok"),
          },
        }),
      ),
    ).toBe("written");
  });
});

describe("gap 14: without storage", () => {
  it("file endpoints answer 503 STORAGE_UNAVAILABLE; nothing is half-written", async () => {
    const bare = createApp({
      logger: pino({ level: "silent" }),
      checkDatabase: () => Promise.resolve(),
      prisma,
      auth: testAuthConfig(),
    });
    const p = await partner("nostore", bare);
    const res = await requestUpload(p, {
      documentType: "OWNER_ID",
      fileName: "x.pdf",
      mimeType: "application/pdf",
      sizeBytes: 100,
    });
    expect(codeOf(res)).toEqual([503, "STORAGE_UNAVAILABLE"]);
    expect(await prisma.providerDocument.count({ where: { providerId: p.providerId } })).toBe(0);
  });
});
