import type { z } from "zod";
import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import { toDbDate } from "../../domain/dates.js";
import { maskAccountNumber } from "../../domain/masking.js";
import { missingRequirements, requirementGroups } from "../../domain/verification.js";
import { AppError } from "../../lib/errors.js";
import { withIdempotency, type IdempotentResult } from "../../lib/idempotency.js";
import { skipTake, type Page } from "../../lib/pagination.js";
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

export const PROVIDER_PROFILE_INCLUDE = {
  providerType: { select: { code: true, name: true } },
  payoutAccounts: { where: { isDefault: true }, take: 1 },
  documents: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
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
    where: { providerId },
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

/** Provider types offered at onboarding, with their required document groups (public). */
export async function listOfferedProviderTypes(prisma: PrismaClient) {
  const types = await prisma.providerType.findMany({
    where: { isActive: true },
    orderBy: { code: "asc" },
    include: { requiredDocuments: { select: { requirement: true, documentType: true } } },
  });
  return types.map((type) => ({
    code: type.code,
    name: type.name,
    description: type.description,
    requiredDocuments: requirementGroups(type.requiredDocuments),
  }));
}

export function createProvidersService({ prisma, now }: { prisma: PrismaClient; now: () => Date }) {
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

  async function submitDocument(
    ctx: AuditContext,
    providerId: string,
    providerStatus: Parameters<typeof assertProviderWritable>[0],
    input: z.infer<typeof documentBodySchema>,
    idempotencyKey: string | null,
  ): Promise<IdempotentResult> {
    assertProviderWritable(providerStatus);
    return withIdempotency(
      prisma,
      idempotencyKey && {
        userId: ctx.actorUserId,
        key: idempotencyKey,
        scope: "partner.document.submit",
        request: { providerId, ...input },
      },
      async (tx) => {
        await lockProvider(tx, providerId);
        const doc = await tx.providerDocument.create({
          data: {
            providerId,
            documentType: input.documentType,
            storageKey: input.storageKey,
            mimeType: input.mimeType,
            sizeBytes: input.sizeBytes,
            documentNumber: input.documentNumber ?? null,
            expiresOn: input.expiresOn ? toDbDate(input.expiresOn) : null,
            status: "PENDING",
          },
        });
        await recordAudit(tx, ctx, {
          action: "provider.document.submit",
          entityType: "provider_document",
          entityId: doc.id,
          after: {
            providerId,
            documentType: doc.documentType,
            mimeType: doc.mimeType,
            sizeBytes: doc.sizeBytes,
            hasDocumentNumber: doc.documentNumber !== null,
            status: doc.status,
          },
        });
        return { resourceId: doc.id, status: 201 };
      },
    );
  }

  async function getDocument(providerId: string, documentId: string) {
    const doc = await prisma.providerDocument.findFirst({ where: { id: documentId, providerId } });
    if (!doc) throw new AppError(404, "DOCUMENT_NOT_FOUND", "Document not found.");
    return doc;
  }

  async function listDocuments(providerId: string) {
    return prisma.providerDocument.findMany({
      where: { providerId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
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
        where: { providerId, status: "PENDING" },
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
    const where: Prisma.ProviderWhereInput = {
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.providerType ? { providerTypeCode: filters.providerType } : {}),
    };
    const [providers, total] = await Promise.all([
      prisma.provider.findMany({
        where,
        include: ADMIN_PROVIDER_INCLUDE,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
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
        include: { documents: { where: { status: "PENDING" }, select: { id: true } } },
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
    submitDocument,
    getDocument,
    listDocuments,
    submitForVerification,
    adminListProviders,
    adminGetProvider,
    adminDecide,
  };
}

export type ProvidersService = ReturnType<typeof createProvidersService>;
