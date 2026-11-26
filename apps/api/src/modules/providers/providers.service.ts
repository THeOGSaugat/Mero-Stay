import { createHash, randomUUID } from "node:crypto";
import type { z } from "zod";
import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import { toDbDate } from "../../domain/dates.js";
import { maskAccountNumber } from "../../domain/masking.js";
import { missingRequirements, requirementGroups } from "../../domain/verification.js";
import {
  DocumentContentError,
  safeFileName,
  sniffDocumentType,
  stripDocumentMetadata,
} from "../../lib/document-content.js";
import { AppError } from "../../lib/errors.js";
import { withIdempotency, type IdempotentResult } from "../../lib/idempotency.js";
import { skipTake, type Page, type ListSort } from "../../lib/pagination.js";
import { documentStorageKey, type DocumentStorage } from "../../lib/storage/index.js";
import { recordAudit, type AuditContext } from "../audit/audit.js";
import { assertProviderWritable } from "../partner/partner-context.js";
import type {
  adminProvidersQuerySchema,
  documentBodySchema,
  onboardingBodySchema,
  payoutAccountSchema,
  profilePatchSchema,
} from "./providers.schemas.js";

/**
 * Provider (partner) onboarding, profile, payout account, verification documents, and the admin
 * verification decision (ADR 0008).
 *
 * Writes lock the provider row (SELECT ... FOR UPDATE), so concurrent requests for one provider run
 * one after another and an admin decision is applied exactly once. Sensitive writes (onboarding,
 * bank-account change, document submission, verification submit/decision) are audited in the same
 * transaction.
 */

const TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 } as const;

/** A provider type's mapped listing types with their flags (ADR 0013). */
const ALLOWED_LISTING_TYPES_SELECT = {
  select: {
    listingType: {
      select: { code: true, name: true, unitLabel: true, isBookable: true, isActive: true },
    },
  },
  orderBy: { listingTypeCode: "asc" },
} satisfies Prisma.ProviderType$allowedListingTypesArgs;

export const PROVIDER_PROFILE_INCLUDE = {
  providerType: {
    select: {
      code: true,
      name: true,
      isActive: true,
      allowedListingTypes: ALLOWED_LISTING_TYPES_SELECT,
    },
  },
  payoutAccounts: { where: { isDefault: true }, take: 1 },
  documents: { where: { deletedAt: null }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
} satisfies Prisma.ProviderInclude;

export type ProviderProfile = Prisma.ProviderGetPayload<{
  include: typeof PROVIDER_PROFILE_INCLUDE;
}>;

export const ADMIN_PROVIDER_INCLUDE = {
  ...PROVIDER_PROFILE_INCLUDE,
  owner: { select: { id: true, fullName: true, email: true, phone: true } },
} satisfies Prisma.ProviderInclude;

export type AdminProvider = Prisma.ProviderGetPayload<{ include: typeof ADMIN_PROVIDER_INCLUDE }>;

type PayoutAccountInput = z.infer<typeof payoutAccountSchema>;

/** Fields an audit row may show for a payout account: the number only masked. */
function payoutAccountAudit(
  account: {
    bankName: string;
    branch: string | null;
    accountName: string;
    accountNumber: string;
  } | null,
) {
  if (!account) return null;
  return {
    bankName: account.bankName,
    branch: account.branch,
    accountName: account.accountName,
    accountNumberMasked: maskAccountNumber(account.accountNumber),
  };
}

function sameAccount(
  a: { bankName: string; branch: string | null; accountName: string; accountNumber: string },
  b: PayoutAccountInput,
): boolean {
  return (
    a.bankName === b.bankName &&
    (a.branch ?? null) === (b.branch ?? null) &&
    a.accountName === b.accountName &&
    a.accountNumber === b.accountNumber
  );
}

const providerNotFound = () => new AppError(404, "PROVIDER_NOT_FOUND", "Provider not found.");
const documentNotFound = () => new AppError(404, "DOCUMENT_NOT_FOUND", "Document not found.");
const documentFileNotFound = () =>
  new AppError(404, "DOCUMENT_FILE_NOT_FOUND", "This document has no stored file.");
const documentContentInvalid = () =>
  new AppError(
    422,
    "DOCUMENT_CONTENT_INVALID",
    "The file is not a valid PDF, JPEG or PNG of the declared type.",
  );

/** What an audit row may show about a document: metadata only, never its content or key. */
function documentAudit(doc: {
  documentType: string;
  fileName: string | null;
  mimeType: string;
  sizeBytes: number;
  status: string;
  documentNumber: string | null;
}) {
  return {
    documentType: doc.documentType,
    fileName: doc.fileName,
    mimeType: doc.mimeType,
    sizeBytes: doc.sizeBytes,
    status: doc.status,
    hasDocumentNumber: doc.documentNumber !== null,
  };
}

async function lockProvider(tx: Prisma.TransactionClient, id: string): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM providers WHERE id = ${id}::uuid FOR UPDATE`;
  if (rows.length !== 1) throw providerNotFound();
}

/**
 * 409 REQUIRED_DOCUMENTS_MISSING unless every requirement group of the provider type has a PENDING
 * or APPROVED document (ADR 0009). The requirements are data (provider_type_required_documents).
 */
async function assertRequiredDocuments(
  tx: Prisma.TransactionClient,
  providerId: string,
  providerTypeCode: string,
): Promise<void> {
  // Sequential on purpose: one transaction = one connection, so no parallel queries on it.
  const rows = await tx.providerTypeRequiredDocument.findMany({
    where: { providerTypeCode },
    select: { requirement: true, documentType: true },
  });
  const documents = await tx.providerDocument.findMany({
    where: { providerId, deletedAt: null },
    select: { documentType: true, status: true },
  });
  const missing = missingRequirements(rows, documents);
  if (missing.length > 0) {
    throw new AppError(
      409,
      "REQUIRED_DOCUMENTS_MISSING",
      "Some required verification documents are missing.",
      { missing },
    );
  }
}

type MappedListingType = {
  listingType: {
    code: string;
    name: string;
    unitLabel: string;
    isBookable: boolean;
    isActive: boolean;
  };
};

/** The mapped listing types a provider of this type can use NOW (both types active, ADR 0013). */
export function usableListingTypesOf(type: {
  isActive: boolean;
  allowedListingTypes: readonly MappedListingType[];
}) {
  if (!type.isActive) return [];
  return type.allowedListingTypes
    .map((m) => m.listingType)
    .filter((t) => t.isActive)
    .map(({ code, name, unitLabel, isBookable }) => ({ code, name, unitLabel, isBookable }));
}

/**
 * Provider types offered at onboarding, with their required document groups (ADR 0009) and the
 * listing types they may create (ADR 0013, active listing types only). Public.
 */
export async function listOfferedProviderTypes(prisma: PrismaClient) {
  const types = await prisma.providerType.findMany({
    where: { isActive: true },
    orderBy: { code: "asc" },
    include: {
      requiredDocuments: { select: { requirement: true, documentType: true } },
      allowedListingTypes: ALLOWED_LISTING_TYPES_SELECT,
    },
  });
  return types.map((type) => ({
    code: type.code,
    name: type.name,
    description: type.description,
    requiredDocuments: requirementGroups(type.requiredDocuments),
    allowedListingTypes: usableListingTypesOf(type),
  }));
}

/**
 * ADMIN (read-only): EVERY provider type, offered or not, with its required documents and its
 * full listing-type mapping including each type's active flag (ADR 0013). Editing is a later
 * phase: the mapping changes by migration.
 */
export async function listAllProviderTypeRules(prisma: PrismaClient) {
  const types = await prisma.providerType.findMany({
    orderBy: { code: "asc" },
    include: {
      requiredDocuments: { select: { requirement: true, documentType: true } },
      allowedListingTypes: ALLOWED_LISTING_TYPES_SELECT,
    },
  });
  return types.map((type) => ({
    code: type.code,
    name: type.name,
    isActive: type.isActive,
    requiredDocuments: requirementGroups(type.requiredDocuments),
    listingTypes: type.allowedListingTypes.map((m) => m.listingType),
    usableListingTypes: usableListingTypesOf(type).map((t) => t.code),
  }));
}

/**
 * Admin provider list filters (gap 25). `q` matches the display or legal name, the owner's email
 * or the provider type's name (case-insensitive, contains), or the type code exactly. Combined
 * with the status and type filters by AND.
 */
export function adminProviderWhere(
  filters: Pick<z.infer<typeof adminProvidersQuerySchema>, "q" | "status" | "providerType">,
): Prisma.ProviderWhereInput {
  const q = filters.q;
  const contains = q ? { contains: q, mode: "insensitive" as const } : undefined;
  return {
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.providerType ? { providerTypeCode: filters.providerType } : {}),
    ...(contains
      ? {
          OR: [
            { displayName: contains },
            { legalName: contains },
            { owner: { email: contains } },
            { providerType: { name: contains } },
            { providerTypeCode: q!.toLowerCase() },
          ],
        }
      : {}),
  };
}

/** Stable orders: newest (default), oldest, or by name; `id` breaks ties. */
export function adminProviderOrder(sort: ListSort): Prisma.ProviderOrderByWithRelationInput[] {
  switch (sort) {
    case "oldest":
      return [{ createdAt: "asc" }, { id: "asc" }];
    case "name":
      return [{ displayName: "asc" }, { id: "asc" }];
    default:
      return [{ createdAt: "desc" }, { id: "desc" }];
  }
}

export function createProvidersService({
  prisma,
  now,
  storage,
}: {
  prisma: PrismaClient;
  now: () => Date;
  /** Private document storage (ADR 0016). Without it, document files are 503 STORAGE_UNAVAILABLE. */
  storage?: DocumentStorage;
}) {
  async function getProfile(providerId: string): Promise<ProviderProfile> {
    const provider = await prisma.provider.findUnique({
      where: { id: providerId },
      include: PROVIDER_PROFILE_INCLUDE,
    });
    if (!provider) throw providerNotFound();
    return provider;
  }

  /**
   * A logged-in customer (or partner) creates a provider and becomes a PARTNER. The provider starts
   * as DRAFT; it is verified by an admin after the partner submits documents.
   */
  async function onboard(
    ctx: AuditContext,
    input: z.infer<typeof onboardingBodySchema>,
    idempotencyKey: string | null,
  ): Promise<IdempotentResult> {
    return withIdempotency(
      prisma,
      idempotencyKey && {
        userId: ctx.actorUserId,
        key: idempotencyKey,
        scope: "partner.onboarding",
        request: input,
      },
      async (tx) => {
        const type = await tx.providerType.findUnique({ where: { code: input.providerTypeCode } });
        if (!type) {
          throw new AppError(422, "UNKNOWN_PROVIDER_TYPE", "Unknown provider type.", {
            providerTypeCode: input.providerTypeCode,
          });
        }
        if (!type.isActive) {
          throw new AppError(
            422,
            "PROVIDER_TYPE_NOT_OFFERED",
            "This provider type is not offered yet.",
            { providerTypeCode: input.providerTypeCode },
          );
        }
        const provider = await tx.provider.create({
          data: { ...input, ownerUserId: ctx.actorUserId, status: "DRAFT" },
        });
        if (ctx.actorRole === "CUSTOMER") {
          await tx.user.update({ where: { id: ctx.actorUserId }, data: { role: "PARTNER" } });
        }
        await recordAudit(tx, ctx, {
          action: "provider.create",
          entityType: "provider",
          entityId: provider.id,
          after: {
            providerTypeCode: provider.providerTypeCode,
            legalName: provider.legalName,
            displayName: provider.displayName,
            status: provider.status,
            ownerRoleBefore: ctx.actorRole,
          },
        });
        return { resourceId: provider.id, status: 201 };
      },
    );
  }

  /**
   * Updates the partner's own provider. Contact fields: any time (unless suspended). Legal/tax
   * identity: only while DRAFT or REJECTED. A new payout account replaces the default one and
   * starts UNVERIFIED (re-verification); sending the current account again changes nothing.
   */
  async function updateProfile(
    ctx: AuditContext,
    providerId: string,
    patch: z.infer<typeof profilePatchSchema>,
  ): Promise<ProviderProfile> {
    await prisma.$transaction(async (tx) => {
      await lockProvider(tx, providerId);
      const provider = await tx.provider.findUniqueOrThrow({
        where: { id: providerId },
        include: { payoutAccounts: { where: { isDefault: true }, take: 1 } },
      });
      assertProviderWritable(provider.status);

      const { payoutAccount, legalName, panNumber, vatNumber, businessRegistrationNo, ...contact } =
        patch;
      const identity = { legalName, panNumber, vatNumber, businessRegistrationNo };
      const changesIdentity = Object.values(identity).some((v) => v !== undefined);
      if (changesIdentity && provider.status !== "DRAFT" && provider.status !== "REJECTED") {
        throw new AppError(
          409,
          "PROVIDER_IDENTITY_LOCKED",
          `Legal and tax details cannot change while the provider is ${provider.status}.`,
          { status: provider.status },
        );
      }
      await tx.provider.update({ where: { id: providerId }, data: { ...contact, ...identity } });

      const current = provider.payoutAccounts[0] ?? null;
      if (payoutAccount && !(current && sameAccount(current, payoutAccount))) {
        if (current) {
          await tx.providerPayoutAccount.update({
            where: { id: current.id },
            data: { isDefault: false },
          });
        }
        const created = await tx.providerPayoutAccount.create({
          data: {
            providerId,
            bankName: payoutAccount.bankName,
            branch: payoutAccount.branch ?? null,
            accountName: payoutAccount.accountName,
            accountNumber: payoutAccount.accountNumber,
            isDefault: true,
            verifiedAt: null, // a changed account must be verified again
          },
        });
        await recordAudit(tx, ctx, {
          action: "provider.payout_account.change",
          entityType: "provider",
          entityId: providerId,
          before: { payoutAccount: payoutAccountAudit(current) },
          after: { payoutAccount: payoutAccountAudit(created), verified: false },
        });
      }
    }, TX_OPTIONS);
    return getProfile(providerId);
  }

  // ------------------------------------------------------- verification documents (ADR 0016)

  function requireStorage(): DocumentStorage {
    if (!storage) {
      throw new AppError(503, "STORAGE_UNAVAILABLE", "Document storage is not configured.");
    }
    return storage;
  }

  /** The live (not deleted) document of this provider, locked; 404 otherwise. */
  async function lockDocument(
    tx: Prisma.TransactionClient,
    providerId: string,
    documentId: string,
  ) {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM provider_documents
       WHERE id = ${documentId}::uuid AND provider_id = ${providerId}::uuid AND deleted_at IS NULL
         FOR UPDATE`;
    if (rows.length !== 1) throw documentNotFound();
    return tx.providerDocument.findUniqueOrThrow({ where: { id: documentId } });
  }

  /**
   * Step 1: the partner asks to upload one document. Creates the record (AWAITING_UPLOAD) with a
   * server-generated private storage key; nothing the client sends becomes a path.
   */
  async function requestDocumentUpload(
    ctx: AuditContext,
    providerId: string,
    providerStatus: Parameters<typeof assertProviderWritable>[0],
    input: z.infer<typeof documentBodySchema>,
    idempotencyKey: string | null,
  ): Promise<IdempotentResult> {
    assertProviderWritable(providerStatus);
    requireStorage();
    return withIdempotency(
      prisma,
      idempotencyKey && {
        userId: ctx.actorUserId,
        key: idempotencyKey,
        scope: "partner.document.request",
        request: { providerId, ...input },
      },
      async (tx) => {
        await lockProvider(tx, providerId);
        const id = randomUUID();
        const doc = await tx.providerDocument.create({
          data: {
            id,
            providerId,
            documentType: input.documentType,
            storageKey: documentStorageKey(providerId, id),
            fileName: safeFileName(input.fileName),
            mimeType: input.mimeType,
            sizeBytes: input.sizeBytes,
            documentNumber: input.documentNumber ?? null,
            expiresOn: input.expiresOn ? toDbDate(input.expiresOn) : null,
            status: "AWAITING_UPLOAD",
          },
        });
        await recordAudit(tx, ctx, {
          action: "provider.document.request",
          entityType: "provider_document",
          entityId: doc.id,
          after: { providerId, ...documentAudit(doc) },
        });
        return { resourceId: doc.id, status: 201 };
      },
    );
  }

  /**
   * Step 2: the file itself (raw body). It must be exactly what was declared (type and size), and
   * its first bytes must really be that type. JPEG/PNG metadata is removed before storage; the
   * stored bytes' SHA-256 is recorded. One upload per document: to replace a file, delete the
   * document and request a new one.
   */
  async function uploadDocumentFile(
    ctx: AuditContext,
    providerId: string,
    providerStatus: Parameters<typeof assertProviderWritable>[0],
    documentId: string,
    body: Buffer,
    contentTypeHeader: string | undefined,
  ): Promise<void> {
    assertProviderWritable(providerStatus);
    const store = requireStorage();
    const contentType = (contentTypeHeader ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    await prisma.$transaction(async (tx) => {
      const doc = await lockDocument(tx, providerId, documentId);
      if (doc.status !== "AWAITING_UPLOAD") {
        throw new AppError(
          409,
          "DOCUMENT_ALREADY_UPLOADED",
          "This document's file is already uploaded.",
          {
            status: doc.status,
          },
        );
      }
      if (contentType !== doc.mimeType) {
        throw new AppError(
          422,
          "DOCUMENT_TYPE_MISMATCH",
          "The file type is not the one you declared.",
          {
            expected: doc.mimeType,
            received: contentType || null,
          },
        );
      }
      if (body.length !== doc.sizeBytes) {
        throw new AppError(
          422,
          "DOCUMENT_SIZE_MISMATCH",
          "The file size is not the one you declared.",
          {
            expected: doc.sizeBytes,
            received: body.length,
          },
        );
      }
      const sniffed = sniffDocumentType(body);
      if (sniffed !== doc.mimeType) {
        throw documentContentInvalid();
      }
      let stored: Buffer;
      try {
        stored = stripDocumentMetadata(body, sniffed);
      } catch (err) {
        if (err instanceof DocumentContentError) throw documentContentInvalid();
        throw err;
      }
      const sha256 = createHash("sha256").update(stored).digest("hex");
      await store.put(doc.storageKey, stored, doc.mimeType);
      const updated = await tx.providerDocument.update({
        where: { id: documentId },
        data: { status: "UPLOADED", uploadedAt: now(), sha256, sizeBytes: stored.length },
      });
      await recordAudit(tx, ctx, {
        action: "provider.document.upload",
        entityType: "provider_document",
        entityId: documentId,
        before: { status: doc.status },
        after: documentAudit(updated),
      });
    }, TX_OPTIONS);
  }

  /** Step 3: the partner confirms the uploaded file: UPLOADED → PENDING (for review). Repeatable. */
  async function confirmDocument(
    ctx: AuditContext,
    providerId: string,
    providerStatus: Parameters<typeof assertProviderWritable>[0],
    documentId: string,
  ): Promise<{ changed: boolean }> {
    assertProviderWritable(providerStatus);
    return prisma.$transaction(async (tx) => {
      const doc = await lockDocument(tx, providerId, documentId);
      if (doc.status === "PENDING") return { changed: false };
      if (doc.status === "AWAITING_UPLOAD") {
        throw new AppError(409, "DOCUMENT_FILE_MISSING", "Upload the file before confirming it.");
      }
      if (doc.status !== "UPLOADED") {
        throw new AppError(409, "DOCUMENT_NOT_CONFIRMABLE", `This document is ${doc.status}.`, {
          status: doc.status,
        });
      }
      const updated = await tx.providerDocument.update({
        where: { id: documentId },
        data: { status: "PENDING" },
      });
      await recordAudit(tx, ctx, {
        action: "provider.document.submit",
        entityType: "provider_document",
        entityId: documentId,
        before: { status: doc.status },
        after: { providerId, ...documentAudit(updated) },
      });
      return { changed: true };
    }, TX_OPTIONS);
  }

  /**
   * The partner deletes a document that is not approved (a replaced, rejected or unwanted one).
   * The row becomes a tombstone (never shown or counted again) and the stored object is removed.
   * While the provider is under review, its submitted (PENDING) documents stay as they are.
   * Returns whether the object was removed (false: it is left for a clean-up, and logged).
   */
  async function deleteDocument(
    ctx: AuditContext,
    providerId: string,
    providerStatus: Parameters<typeof assertProviderWritable>[0],
    documentId: string,
  ): Promise<{ objectRemoved: boolean }> {
    assertProviderWritable(providerStatus);
    const store = requireStorage();
    const doc = await prisma.$transaction(async (tx) => {
      await lockProvider(tx, providerId);
      const current = await lockDocument(tx, providerId, documentId);
      if (current.status === "APPROVED") {
        throw new AppError(409, "DOCUMENT_APPROVED", "An approved document cannot be deleted.");
      }
      if (current.status === "PENDING" && providerStatus === "PENDING_VERIFICATION") {
        throw new AppError(
          409,
          "PROVIDER_UNDER_REVIEW",
          "Documents under review cannot be deleted until MeroStay has decided.",
        );
      }
      await tx.providerDocument.update({ where: { id: documentId }, data: { deletedAt: now() } });
      await recordAudit(tx, ctx, {
        action: "provider.document.delete",
        entityType: "provider_document",
        entityId: documentId,
        before: { providerId, ...documentAudit(current) },
        after: { deleted: true },
      });
      return current;
    }, TX_OPTIONS);
    try {
      await store.delete(doc.storageKey);
      return { objectRemoved: true };
    } catch {
      return { objectRemoved: false };
    }
  }

  /** A live document of this provider (metadata). 404 for another provider's or a deleted one. */
  async function getDocument(providerId: string, documentId: string) {
    const doc = await prisma.providerDocument.findFirst({
      where: { id: documentId, providerId, deletedAt: null },
    });
    if (!doc) throw documentNotFound();
    return doc;
  }

  async function listDocuments(providerId: string) {
    return prisma.providerDocument.findMany({
      where: { providerId, deletedAt: null },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  }

  /** The stored file of a live, uploaded document of this provider; 404 when there is none. */
  async function readDocumentFile(providerId: string, documentId: string) {
    const store = requireStorage();
    const doc = await getDocument(providerId, documentId);
    if (!doc.uploadedAt) throw documentFileNotFound();
    const body = await store.get(doc.storageKey);
    if (!body) throw documentFileNotFound();
    return { doc, body };
  }

  /** ADMIN: a provider's document file. Every view of a document is audited (metadata only). */
  async function adminReadDocumentFile(ctx: AuditContext, providerId: string, documentId: string) {
    const file = await readDocumentFile(providerId, documentId);
    await prisma.$transaction((tx) =>
      recordAudit(tx, ctx, {
        action: "provider.document.view",
        entityType: "provider_document",
        entityId: documentId,
        after: { providerId, ...documentAudit(file.doc) },
      }),
    );
    return file;
  }

  /**
   * The partner asks for review: DRAFT or REJECTED → PENDING_VERIFICATION. Needs at least one
   * pending document. Already pending → unchanged (idempotent).
   */
  async function submitForVerification(
    ctx: AuditContext,
    providerId: string,
  ): Promise<{ provider: ProviderProfile; changed: boolean }> {
    const changed = await prisma.$transaction(async (tx) => {
      await lockProvider(tx, providerId);
      const provider = await tx.provider.findUniqueOrThrow({ where: { id: providerId } });
      assertProviderWritable(provider.status);
      if (provider.status === "PENDING_VERIFICATION") return false;
      if (provider.status !== "DRAFT" && provider.status !== "REJECTED") {
        throw new AppError(409, "PROVIDER_NOT_SUBMITTABLE", `Provider is ${provider.status}.`, {
          status: provider.status,
        });
      }
      const pendingDocs = await tx.providerDocument.count({
        where: { providerId, status: "PENDING", deletedAt: null },
      });
      if (pendingDocs === 0) {
        throw new AppError(
          409,
          "NO_PENDING_DOCUMENTS",
          "Submit at least one verification document first.",
        );
      }
      await assertRequiredDocuments(tx, providerId, provider.providerTypeCode);
      await tx.provider.update({
        where: { id: providerId },
        data: { status: "PENDING_VERIFICATION", rejectionReason: null },
      });
      await recordAudit(tx, ctx, {
        action: "provider.verification.submit",
        entityType: "provider",
        entityId: providerId,
        before: { status: provider.status },
        after: { status: "PENDING_VERIFICATION", pendingDocuments: pendingDocs },
      });
      return true;
    }, TX_OPTIONS);
    return { provider: await getProfile(providerId), changed };
  }

  // ------------------------------------------------------------------------------- admin

  async function adminListProviders(
    filters: z.infer<typeof adminProvidersQuerySchema>,
  ): Promise<{ providers: AdminProvider[]; total: number; page: Page }> {
    const where = adminProviderWhere(filters);
    const [providers, total] = await Promise.all([
      prisma.provider.findMany({
        where,
        include: ADMIN_PROVIDER_INCLUDE,
        orderBy: adminProviderOrder(filters.sort),
        ...skipTake(filters),
      }),
      prisma.provider.count({ where }),
    ]);
    return { providers, total, page: filters };
  }

  async function adminGetProvider(id: string): Promise<AdminProvider> {
    const provider = await prisma.provider.findUnique({
      where: { id },
      include: ADMIN_PROVIDER_INCLUDE,
    });
    if (!provider) throw providerNotFound();
    return provider;
  }

  /**
   * ADMIN: approve or reject a provider that asked for verification. Applied once: the provider
   * must be PENDING_VERIFICATION (a repeat is 409 and writes no second audit row).
   * - approve → VERIFIED; pending documents → APPROVED; the default payout account is verified.
   * - reject  → REJECTED with a reason; pending documents → REJECTED with the same reason.
   */
  async function adminDecide(
    ctx: AuditContext,
    providerId: string,
    decision: "approve" | "reject",
    reason: string | undefined,
  ): Promise<AdminProvider> {
    if (decision === "reject" && !reason) {
      throw new AppError(400, "VALIDATION_ERROR", "A reason is required to reject.", [
        { path: "reason", message: "is required when rejecting" },
      ]);
    }
    await prisma.$transaction(async (tx) => {
      await lockProvider(tx, providerId);
      const provider = await tx.provider.findUniqueOrThrow({
        where: { id: providerId },
        include: {
          documents: { where: { status: "PENDING", deletedAt: null }, select: { id: true } },
        },
      });
      if (provider.status !== "PENDING_VERIFICATION") {
        throw new AppError(
          409,
          "PROVIDER_NOT_PENDING",
          `Provider is ${provider.status}; only PENDING_VERIFICATION can be decided.`,
          { status: provider.status },
        );
      }
      const at = now();
      const pendingIds = provider.documents.map((d) => d.id);
      if (decision === "approve") {
        // Checked again here: an incomplete provider can never be approved (ADR 0009).
        await assertRequiredDocuments(tx, providerId, provider.providerTypeCode);
        await tx.provider.update({
          where: { id: providerId },
          data: { status: "VERIFIED", verifiedAt: at, rejectionReason: null },
        });
        await tx.providerDocument.updateMany({
          where: { id: { in: pendingIds } },
          data: { status: "APPROVED", reviewedById: ctx.actorUserId, reviewedAt: at },
        });
        await tx.providerPayoutAccount.updateMany({
          where: { providerId, isDefault: true, verifiedAt: null },
          data: { verifiedAt: at },
        });
      } else {
        await tx.provider.update({
          where: { id: providerId },
          data: { status: "REJECTED", rejectionReason: reason ?? null },
        });
        await tx.providerDocument.updateMany({
          where: { id: { in: pendingIds } },
          data: {
            status: "REJECTED",
            reviewedById: ctx.actorUserId,
            reviewedAt: at,
            rejectionReason: reason ?? null,
          },
        });
      }
      await recordAudit(tx, ctx, {
        action: `provider.verification.${decision}`,
        entityType: "provider",
        entityId: providerId,
        before: { status: provider.status, pendingDocumentIds: pendingIds },
        after: {
          status: decision === "approve" ? "VERIFIED" : "REJECTED",
          documentStatus: decision === "approve" ? "APPROVED" : "REJECTED",
          reason: reason ?? null,
        },
      });
    }, TX_OPTIONS);
    return adminGetProvider(providerId);
  }

  return {
    getProfile,
    onboard,
    updateProfile,
    requestDocumentUpload,
    uploadDocumentFile,
    confirmDocument,
    deleteDocument,
    getDocument,
    listDocuments,
    readDocumentFile,
    adminReadDocumentFile,
    submitForVerification,
    adminListProviders,
    adminGetProvider,
    adminDecide,
  };
}

export type ProvidersService = ReturnType<typeof createProvidersService>;
