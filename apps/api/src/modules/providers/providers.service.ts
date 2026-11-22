import type { z } from "zod";
import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import { toDbDate } from "../../domain/dates.js";
import { maskAccountNumber } from "../../domain/masking.js";
import { AppError } from "../../lib/errors.js";
import { withIdempotency, type IdempotentResult } from "../../lib/idempotency.js";
import { recordAudit, type AuditContext } from "../audit/audit.js";
import { assertProviderWritable } from "../partner/partner-context.js";
import type {
  documentBodySchema,
  onboardingBodySchema,
  payoutAccountSchema,
  profilePatchSchema,
} from "./providers.schemas.js";

/**
 * Provider (partner) onboarding, profile, payout account and verification documents (ADR 0008).
 *
 * Writes lock the provider row (SELECT ... FOR UPDATE), so concurrent requests for one provider run
 * one after another. Sensitive writes (onboarding, bank-account change, document submission,
 * verification submit) are audited in the same transaction.
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

export function createProvidersService({ prisma }: { prisma: PrismaClient; now: () => Date }) {
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

  return {
    getProfile,
    onboard,
    updateProfile,
    submitDocument,
    getDocument,
    listDocuments,
    submitForVerification,
  };
}

export type ProvidersService = ReturnType<typeof createProvidersService>;
