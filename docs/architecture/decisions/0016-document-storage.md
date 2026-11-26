# 0016. Private storage for verification documents

- **Status:** Accepted
- **Date:** 2026-11-26
- **Phase:** 10 (closes operational gap 14)

## Context

Until Phase 10 a verification document was metadata only (gap 14):

- the browser sent the file's type and size, plus a storage key of its own choosing;
- the file never left the partner's device;
- admins verified providers without seeing anything.

Security guidelines §6 asks for:

- allow-listed types checked from the content;
- a size limit and metadata stripping;
- random names, and storage outside the web root;
- private access.

CI and tests must need no cloud secrets.

## Decision

### 1. A storage interface with two implementations

`DocumentStorage` (`src/lib/storage/`) has `put`, `get`, `delete`, and keys only. It is chosen at
startup from the environment:

| Driver | Used for | Notes |
|---|---|---|
| `local` (`LocalDiskStorage`) | Development (default `apps/api/.storage`, git-ignored), tests (a temporary directory), CI, E2E | Absolute root outside any web root; atomic writes (temporary file + rename); files 0600, directories 0700; refuses any key that would leave the root |
| `s3` (`S3Storage`, `@aws-sdk/client-s3`, owner approved) | Production: AWS S3, Cloudflare R2, MinIO, Backblaze (`S3_ENDPOINT`) | Private bucket; `ServerSideEncryption: AES256` on AWS (S3-compatible stores encrypt at rest themselves and may reject the header); credentials from `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` or the SDK's default chain. Unit-tested with a fake client |

- **Production:** `STORAGE_DRIVER` is required. `local` needs an absolute `STORAGE_LOCAL_DIR`; `s3`
  needs `S3_BUCKET` and `S3_REGION`; access keys come together or not at all.
- **Errors:** messages never echo values.
- **Logging:** the startup log names the driver only.

### 2. Upload flow: request → upload → confirm, through the API

The file goes through the API, not a presigned URL. The API checks the actual bytes (type
signature, exact size, metadata stripping) before anything is stored; a presigned direct upload
would store first and check later. 10 MB through the API is fine for this use.

| Step | Request | Result |
|---|---|---|
| 1. Request | `POST /partner/verification-documents` `{ documentType, fileName, mimeType, sizeBytes, documentNumber?, expiresOn? }` | `201`: record `AWAITING_UPLOAD` with a server-generated key `documents/<provider>/<document>/<random>`. `upload: { method: "PUT", path, contentType, sizeBytes }` |
| 2. Upload | `PUT …/:id/file` with the raw file as the body (`Content-Type` = the declared type) | `200 UPLOADED` |
| 3. Confirm | `POST …/:id/confirm` | `UPLOADED → PENDING` (for review). Repeating changes nothing |

**What step 2 checks, in order:**

1. The `Content-Type` must be the declared one (`422 DOCUMENT_TYPE_MISMATCH`).
2. The length must be exactly the declared size (`422 DOCUMENT_SIZE_MISMATCH`).
3. The first bytes must really be that type: `%PDF-`, the PNG signature, or `FF D8 FF`
   (`422 DOCUMENT_CONTENT_INVALID`).

**What it stores:**

- JPEG and PNG are copied without metadata: APP1 (EXIF/XMP, including GPS), APP13 (IPTC) and
  comments; `tEXt`/`zTXt`/`iTXt`/`eXIf`/`tIME` chunks. Malformed images are refused.
- The SHA-256 and size of the stored bytes are recorded.

**Limits and type rules:**

- **Body size:** a body over 10 MB is `413`, and other types are `415`. One upload per document
  (`409 DOCUMENT_ALREADY_UPLOADED`); to replace a file, delete the document and request a new one.
- **Allowed types:** PDF, JPEG and PNG only. WebP, previously accepted as metadata, is not.

**The web proxy.** Next.js buffers proxied request bodies up to `proxyClientMaxBodySize` and
silently cuts larger ones, which would leave the API waiting. The web server (`server.mts`)
therefore refuses `/api/v1` bodies above 10 MB + 64 KB at once, and the buffer is set to the same
value. Tested with 9.9 MB, 10 MB + 1 byte and 20 MB through the proxy.

### 3. Access: private, through the API only

| Who | Endpoint | Result |
|---|---|---|
| The owning partner | `GET /partner/verification-documents/:id/file` | The file |
| Admins | `GET /admin/providers/:id/documents/:documentId/file` | The file; every view is audited (`provider.document.view`, metadata only) |
| Another partner | Either path | `404`, like a missing document |
| Customers | — | `403` |
| Visitors | — | `401` |

- **Response headers:** the stored type, `Content-Disposition: attachment` with a sanitised name,
  `Cache-Control: private, no-store`, and `Content-Security-Policy: default-src 'none'; sandbox`.
- **Never exposed:** responses never include the storage key; there are no public URLs and no
  presigned links.
- **Display name:** `fileName` is the last path segment, with control and quoting characters
  removed. It is never a path.

### 4. Lifecycle, enforced by the database

`AWAITING_UPLOAD → UPLOADED → PENDING → APPROVED | REJECTED`, with the admin's decision from
Phase 6.

- **A file exists from `UPLOADED` on:** `uploaded_at` and `sha256` are set (CHECK
  `provider_documents_file_chk`).
- **Fixed by trigger `provider_documents_guard`:** the transitions; the storage key and provider;
  the stored file (hash, size, type).
- **Counting:** only `PENDING` and `APPROVED` documents count towards the required-documents check
  and "submit for verification". So do only those the admin decides on.

### 5. Retention and deletion

- **Who can delete:** the partner can delete a document that is not approved (approved documents
  are verification evidence: `409 DOCUMENT_APPROVED`), and not a submitted one while MeroStay is
  deciding (`409 PROVIDER_UNDER_REVIEW`).
- **What deletion does:**
  - the row becomes a **tombstone** (`deleted_at`): never listed, counted, served or changed again,
    and kept for the audit trail;
  - the **stored object is removed** right after the transaction. If that removal fails, it is
    logged and the orphan is never served; clean-up is gap 6.
- **Not decided yet:** how long kept documents are retained, and backups (gap 28).

### 6. Audit rows hold metadata only

`provider.document.request`, `.upload`, `.submit` (confirm), `.delete` and `.view` record the
document type, file name, type, size, status and whether a number was given. They never record
bytes, the storage key or the hash (tested).

## Consequences

- **Residual gaps:**
  - malware scanning (26);
  - provisioning production storage (27, on the launch checklist);
  - backup and retention (28);
  - PDF metadata and image re-encoding (29);
  - orphaned objects (folded into gap 6).
- **Single instance or bucket:** the local driver suits a single instance with a backed-up disk;
  several instances need the S3 driver.
- **Listing photos** (public images) can reuse the interface later. They are a separate,
  unscheduled roadmap item.
- **Breaking change to the partner API:** `storageKey` is no longer accepted or returned.
