# Phase 10: Cancellation policies & verification documents

- **Status:** complete, awaiting owner review.
- **Branch:** `phase/10-policies-documents`
- **Date:** 2026-11-26

## Scope (as approved)

Close **gap 23** (partners could not set a cancellation policy) and **gap 14** (verification
documents were metadata only; the file stayed on the partner's device): backend, frontend, tests
and docs. Nothing else.

**Not built (confirmed):**

- live payment gateway, refund or payout execution;
- reviews, notifications;
- OAuth, 2FA, email verification and reset;
- admin moderation (gaps 9, 13, 15).

No refund is computed: only the structured rule is stored. Phase 11 has not been started.

**Bookkeeping commit on `main` first (`2214a0d`, CI `45753979568` ✔):**

- Phase 9 marked as tagged;
- Admin moderation assigned to **Phase 12**, with later phases moved down by one;
- gap 15 now states that approval must re-check the listing-type rule;
- a launch checklist added.

**Owner decisions (asked at the start, 2026-11-26):**

- **Presets:** cancellation policies are partner-authored only; no MeroStay presets (requirements
  §6 updated).
- **S3:** ship an S3-compatible implementation using `@aws-sdk/client-s3` (new dependency, approved).
- **Roadmap:** listing photos and bulk pricing move to an unscheduled roadmap row.

## What was built

### Gap 23: cancellation policies (ADR 0015)

| Part | What |
|---|---|
| Model | The existing `cancellation_policies` gains `is_active` and `non_refundable`. Rule = refund tiers `[{ minHoursBeforeStart, refundBps }]` (1–10, hours strictly decreasing, refund 0.01–100% never increasing), or non-refundable with none. Checked by the API and by `cancellation_rules_valid()` (CHECK) |
| Precedence | `providers.default_cancellation_policy_id` (new). Resolution **listing → provider default → none** (`resolveCancellationPolicy`) |
| Snapshot | Adding an item freezes `{ policyId, name, description, nonRefundable, rules, source, capturedAt }` (the Phase 5 mechanism, extended). Edits never change bookings; no refund amount anywhere |
| Database rules | Only an active policy of the same provider can be attached (`FOR SHARE`, serialised with deactivation); an attached policy cannot be switched off; a policy never changes owner |
| Endpoints | Partner: list (with usage), create, read, edit, on/off, default. Listing create/update attaches (own and active only). Admin: read-only list. Public listing detail: the policy that applies now with its `source`, or `null`. All partner writes audited |
| No policy | Explicit everywhere ("No cancellation policy is set…", "…was attached to this booking"); the partner is warned; booking is not blocked (gap 30) |
| Web | `/partner/cancellation-policies` (tier editor, default selector, on/off), a policy panel on bookable listings, one `CancellationTerms` component for listings (current, with source) and trips and partner bookings (frozen), an admin read-only panel |

### Gap 14: verification documents (ADR 0016)

| Part | What |
|---|---|
| Storage | `DocumentStorage` interface: `LocalDiskStorage` (dev default `apps/api/.storage`, temporary directory in tests/E2E, CI; atomic, 0600, never leaves its root; no secrets) and `S3Storage` (AWS S3/R2/MinIO/Backblaze, private, AES256 on AWS). `STORAGE_DRIVER` required in production |
| Flow | `POST` request (type, size, name) → `AWAITING_UPLOAD` with a server-generated key → `PUT …/file` (raw body) → `UPLOADED` → `POST …/confirm` → `PENDING` → admin approves/rejects (Phase 6). Through the API, not presigned, so bytes are checked before storage |
| Validation | PDF/JPEG/PNG only, checked from the first bytes; `Content-Type` and length must match the declaration; 10 MB; JPEG/PNG metadata (EXIF/GPS, IPTC, comments, text chunks) stripped; SHA-256 recorded; one upload per document |
| Access | Owner `GET …/file` and admin `GET /admin/providers/:id/documents/:documentId/file` only (attachment, `no-store`, sandbox CSP); admin views audited; another partner 404, customers 403, visitors 401. No key or URL is ever returned |
| Lifecycle | Triggers: the transitions, fixed key, provider and stored file, tombstones immutable. Only `PENDING`/`APPROVED` count towards verification |
| Retention | Delete (not approved; not while under review) → tombstone + object removed; a failed removal is logged (clean-up: gap 6). Retention periods and backups: gap 28 |
| Audit | request, upload, submit, delete, view: metadata only (type, file name, size, status), never bytes, key or hash |
| Web | Real upload in `/partner/verification` (step labels; open, send for review, delete), admin "Open file". `server.mts` refuses `/api/v1` bodies > 10 MB + 64 KB, and `experimental.proxyClientMaxBodySize` is set to the same: Next.js otherwise cuts bigger bodies and the API hangs waiting (found by the E2E test) |

### Migrations

- `20261126090000_document_upload_statuses`: the new enum values, in a migration of their own,
  because PostgreSQL cannot use a new enum value in the transaction that adds it.
- `20261126090100_cancellation_policies_and_document_storage`: the columns, checks, triggers and
  functions for both gaps.
- Both are additive. Dev had no rows to migrate (checked read-only: 0 providers, documents,
  policies and bookings).

## Verification (real results)

| Check | Result |
|---|---|
| `format:check`, `lint`, `typecheck` (API, web, e2e), `build` | Pass |
| API unit | **287/287** (250 + 37 new) |
| Web unit | **91/91** (83 + 8 new) |
| API integration, disposable PostgreSQL 17 (local) | **233/233** (209 + 12 gap 23 + 12 gap 14) |
| E2E local (booking mode, CI settings) | **26/26** (20 + 6 new), with 1, 2, 2, 8, 8 workers |
| Commit 1 on its own (stash check) | format, lint, typecheck pass; API unit 250, web unit 83, integration 209, E2E 20/20 |
| `npm audit` (after adding `@aws-sdk/client-s3` 3.1178.0) | 0 vulnerabilities |
| CI on `f993dff` | Run `45788063011`: `verify` ✔, `e2e` ✔ **26 passed** (30.0 s) |
| **Neon integration (end of phase)** | **16/16 files, 233/233 tests**, 2,560.89 s, exit 0 (attempt 1, below) |

### Gap 23 cases

| Case | Level | Result |
|---|---|---|
| Partner creates a policy and attaches it; the customer sees it on the listing | Integration + E2E | `source: "listing"`, tiers as written; usage `{ listings: 1 }` |
| Listing override vs provider default; clearing the default | Integration | Own policy wins; the default applies otherwise; then `null` |
| No policy | Integration + web unit + E2E | Listing `null` → "No cancellation policy is set…"; the booking's snapshot is `null` |
| Booking freezes; a later edit (rules and name) | Integration + E2E | The stored snapshot is unchanged; a new booking gets the new terms. The trip page still shows 72 h/100% after the partner changed it to 168 h/25% |
| Snapshot holds the rule only | Integration | Exactly `capturedAt, description, name, nonRefundable, policyId, rules, source` |
| Bad rules (7 shapes) | Integration + unit | `400`, nothing written |
| Another provider's policy | Integration | `404` read/edit; `422 UNKNOWN_CANCELLATION_POLICY` as a default or on a listing |
| Switch off an attached policy; attach a switched-off one | Integration | `409 CANCELLATION_POLICY_IN_USE` `{ listings: 1, providerDefault: false }`; `422 CANCELLATION_POLICY_INACTIVE` |
| Direct database writes | Integration | Invalid rule, foreign attach, deactivate attached, change owner: all refused |
| Admin read-only list; non-admin; unknown provider | Integration | `200`; `403`; `404` |
| Audit | Integration | create, update and default rows |

### Gap 14 cases

| Case | Level | Result |
|---|---|---|
| Valid PDF: request → upload → confirm | Integration | The object on disk equals the bytes; the row's SHA-256 matches; key `documents/<provider>/<document>/<32 hex>`; no key in any response |
| JPEG with EXIF/GPS and a comment; PNG with text/EXIF chunks | Integration + unit | Stored without them, still the same kind of file; size and hash of the stored bytes |
| GIF/WebP declared, > 10 MB declared, wrong `Content-Type`, wrong size, HTML posing as PDF, body > 10 MB | Integration | `400`, `400`, `415`/`422`, `422`, `422 DOCUMENT_CONTENT_INVALID`, `413`; nothing stored, still `AWAITING_UPLOAD` |
| Confirm before upload; second upload; confirm twice | Integration | `409 DOCUMENT_FILE_MISSING`; `409 DOCUMENT_ALREADY_UPLOADED`; one audit row |
| Owner download | Integration + E2E | `200`, attachment, `private, no-store`, sandbox CSP |
| Another partner (read, upload, delete) / customer / visitor / admin route for a customer | Integration | `404` / `403` / `401` / `403` |
| Admin download; under another provider's id | Integration + E2E | `200` + a `provider.document.view` audit row; `404` |
| Delete | Integration | `204`, object gone, `404` after, hidden from the list; approved → `409 DOCUMENT_APPROVED` |
| Counting | Integration + unit | Uploaded but unconfirmed documents → `409 NO_PENDING_DOCUMENTS`; after confirming, the submission is accepted |
| Audit content | Integration | No `%PDF`/JFIF/EXIF, no storage key, no hash in any document audit row |
| Database guards | Integration | Skipping the upload, a submitted row without a file, replacing the hash, changing a tombstone: all refused |
| No storage configured | Integration | `503 STORAGE_UNAVAILABLE`, nothing written |
| Through the web server | E2E | 9.9 MB → `200`; 10 MB + 1 → `413` (API); 20 MB → `413` (web server, no hang) |
| Upload → under review → submit → admin opens → approve → partner sees approved | E2E | Desktop and mobile |

**Mutation checks** (each reverted; the migration restored byte for byte):

| Mutation | Result |
|---|---|
| Resolution ignores the provider default | 2 tests fail |
| The attach trigger never refuses | The database-rules test fails |
| Document reads not scoped to the provider | 2 tests fail |
| No content sniffing | The refusals test fails |
| No metadata stripping | The metadata test fails |

### What E2E found (fixed before committing)

1. **The `Document` select couldn't be found by label:** the label wraps the select, so its text
   includes every option. It is now found by name.
2. **A hidden duplicate during streaming:** React briefly keeps a hidden copy of streamed
   listing-page content (the Phase 9 problem again). The listing-page locators are now restricted
   to visible elements.
3. **The proxy body cut** described above: a body just over 10 MB hung the request.
4. **A reset connection:** answering 413 with `Connection: close` reset the connection while the
   client was still sending. The rest of the body is now discarded instead.

## Neon integration run (end of phase)

Command: `caffeinate -i npm run test:integration` on committed code `f993dff` (all code committed;
the working tree held only docs), against the Neon test branch from `apps/api/.env.test` (endpoint
`ep-gentle-salad-beigu8ag`, reachable when checked just before; no URL printed).

| Attempt | Started (UTC) | Result |
|---|---|---|
| 1 | 09:04:40 | **Clean: 16/16 files, 233/233 tests passed**, 2,560.89 s (about 43 min), exit 0, ended 09:47:21. No stalls, no access errors, no retries |

The same 233 tests pass locally on PostgreSQL 17 (11 s) and in CI `verify` on every push.

## Operational gaps

- **Closed:** 23 (cancellation policies) and 14 (verification documents).
- **New residuals:**
  - 26 malware scanning;
  - 27 production storage provisioning (also on the launch checklist);
  - 28 backup and retention of documents;
  - 29 PDF metadata and image re-encoding;
  - 30 listings may have no policy (to decide with refunds, Phase 14).
  - Gap 6 also covers orphaned document objects.
- **Open, 21:** 1–4, 6–10, 12, 13, 15–17, 20, 24, 26–30. **No launch blocker.**

## Commits

| Hash | Message |
|---|---|
| `2214a0d` (on `main`) | docs: mark Phase 9 tagged, assign Phase 12, add launch checklist |
| `8ff20d4` | feat: cancellation policies and private verification document uploads (gaps 23, 14) |
| `787ee43` | test(api): cover cancellation policies, document uploads and access control (gaps 23, 14) |
| `f993dff` | test(e2e,web): Phase 10 journeys and web unit tests (gaps 23, 14) |
| (this commit) | docs: record Phase 10 cancellation policies and document storage, ADRs 0015 and 0016, gaps |

**Why the feature is one commit.** An API-only first commit would have broken the E2E suite (the
admin page read the removed `storageKey`), so the feature ships API and web together. Tests follow
in their own commits, and each commit was checked on its own.

## Security checklist

- **Documents are private:**
  - server-generated keys, never sent to clients;
  - no public or presigned URLs;
  - owner and admins only, through the API;
  - attachment, `no-store`, sandbox CSP.
- **Validation:** types checked from the bytes, exact size, 10 MB; image metadata stripped.
- **Audit:** every document action is audited with metadata only.
- **Tests need no cloud secrets:** local disk in tests, E2E and CI.
- **Secrets never surface:** S3 credentials are optional and never logged or echoed; the startup
  log shows only the driver.
- **Unchanged:** partner scoping (404 for another provider), CSRF on every write, idempotency on
  creates, and money as digit strings (nothing new touches money).
- **Secret scan** before every commit. The only hits were variable names, empty `.env.example`
  placeholders, test fixtures and the documented throwaway CI credentials.

## Known limitations / follow-ups

- **Refunds** (Phase 14) will read the snapshot's tiers. The clock reference ("hours before the
  start": start date at 00:00 Nepal time, or a check-in time) is that phase's decision.
- **Documents:**
  - malware scanning, PDF metadata and image re-encoding (gaps 26, 29);
  - production storage (gap 27);
  - retention (gap 28).
- **`npm run dev`** uses the local driver in `apps/api/.storage`, which is git-ignored.
- **Partners with several businesses** open their own files through a fetch, because a plain link
  cannot send `X-Provider-Id`.

## How to review

1. Read ADRs [0015](../architecture/decisions/0015-cancellation-policies.md) and
   [0016](../architecture/decisions/0016-document-storage.md), and the two migrations.
2. `npm run dev`. As a partner:
   - `/partner/cancellation-policies`: add a policy and set a default;
   - a listing's page: choose a policy;
   - `/partner/verification`: upload a PDF.

   As a customer, the listing and a trip. As an admin, the provider page: "Open file" and the
   policies panel.
3. `E2E_DATABASE_URL="postgresql://…disposable…" npm run test:e2e:booking`.
