import type { z } from "zod";
import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import type { ProviderStatus } from "../../generated/prisma/enums.js";
import {
  cancellationRuleProblems,
  type CancellationTier,
} from "../../domain/cancellation-policy.js";
import { AppError } from "../../lib/errors.js";
import { withIdempotency, type IdempotentResult } from "../../lib/idempotency.js";
import { recordAudit, type AuditContext } from "../audit/audit.js";
import { assertProviderWritable } from "../partner/partner-context.js";
import type {
  createPolicyBodySchema,
  updatePolicyBodySchema,
} from "./cancellation-policies.schemas.js";

/**
 * Cancellation policies that partners author (ADR 0015, gap 23).
 *
 * - A partner sees and edits only its own provider's policies (another provider's is a 404).
 * - Editing a policy never changes existing bookings: each booking item keeps a frozen snapshot.
 * - An attached policy (a listing's or the provider's default) cannot be deactivated; the database
 *   enforces the same (cancellation_policies_in_use_chk), and refuses attaching an inactive or
 *   foreign policy (cancellation_policies_attach_chk).
 * - Every write is audited in its transaction; rules are data, never money: nothing is refunded.
 */

const TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 } as const;

const policyNotFound = () =>
  new AppError(404, "CANCELLATION_POLICY_NOT_FOUND", "Cancellation policy not found.");

function auditView(policy: {
  name: string;
  description: string;
  nonRefundable: boolean;
  rules: unknown;
  isActive: boolean;
}) {
  return {
    name: policy.name,
    description: policy.description,
    nonRefundable: policy.nonRefundable,
    rules: policy.rules,
    isActive: policy.isActive,
  };
}

async function lockProvider(tx: Prisma.TransactionClient, providerId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM providers WHERE id = ${providerId}::uuid FOR UPDATE`;
}

export function createCancellationPoliciesService({ prisma }: { prisma: PrismaClient }) {
  /** The provider's own policies with where each is used, oldest first. */
  async function listOwn(providerId: string) {
    const [policies, provider] = await Promise.all([
      prisma.cancellationPolicy.findMany({
        where: { providerId },
        include: { _count: { select: { listings: true } } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
      prisma.provider.findUniqueOrThrow({
        where: { id: providerId },
        select: { defaultCancellationPolicyId: true },
      }),
    ]);
    return {
      defaultPolicyId: provider.defaultCancellationPolicyId,
      policies: policies.map((policy) => ({
        policy,
        usage: {
          listings: policy._count.listings,
          providerDefault: provider.defaultCancellationPolicyId === policy.id,
        },
      })),
    };
  }

  async function getOwn(providerId: string, policyId: string) {
    const policy = await prisma.cancellationPolicy.findFirst({
      where: { id: policyId, providerId },
      include: { _count: { select: { listings: true } } },
    });
    if (!policy) throw policyNotFound();
    const provider = await prisma.provider.findUniqueOrThrow({
      where: { id: providerId },
      select: { defaultCancellationPolicyId: true },
    });
    return {
      policy,
      usage: {
        listings: policy._count.listings,
        providerDefault: provider.defaultCancellationPolicyId === policy.id,
      },
    };
  }

  async function create(
    ctx: AuditContext,
    providerId: string,
    providerStatus: ProviderStatus,
    input: z.infer<typeof createPolicyBodySchema>,
    idempotencyKey: string | null,
  ): Promise<IdempotentResult> {
    assertProviderWritable(providerStatus);
    return withIdempotency(
      prisma,
      idempotencyKey && {
        userId: ctx.actorUserId,
        key: idempotencyKey,
        scope: "partner.cancellation_policy.create",
        request: { providerId, ...input },
      },
      async (tx) => {
        const policy = await tx.cancellationPolicy.create({
          data: {
            providerId,
            name: input.name,
            description: input.description,
            nonRefundable: input.nonRefundable,
            rules: input.rules,
          },
        });
        await recordAudit(tx, ctx, {
          action: "cancellation_policy.create",
          entityType: "cancellation_policy",
          entityId: policy.id,
          after: { providerId, ...auditView(policy) },
        });
        return { resourceId: policy.id, status: 201 };
      },
    );
  }

  /**
   * Edits name, description, rule or the active flag. The merged rule is checked again
   * (e.g. `nonRefundable: true` alone also clears the tiers). Deactivating an attached policy is
   * 409 CANCELLATION_POLICY_IN_USE with where it is used.
   */
  async function update(
    ctx: AuditContext,
    providerId: string,
    providerStatus: ProviderStatus,
    policyId: string,
    patch: z.infer<typeof updatePolicyBodySchema>,
  ): Promise<void> {
    assertProviderWritable(providerStatus);
    await prisma.$transaction(async (tx) => {
      await lockProvider(tx, providerId);
      const before = await tx.cancellationPolicy.findFirst({
        where: { id: policyId, providerId },
      });
      if (!before) throw policyNotFound();

      const nonRefundable = patch.nonRefundable ?? before.nonRefundable;
      const rules: CancellationTier[] =
        patch.rules ?? (nonRefundable ? [] : (before.rules as unknown as CancellationTier[]));
      const problems = cancellationRuleProblems({ nonRefundable, tiers: rules });
      if (problems.length > 0) {
        throw new AppError(
          400,
          "VALIDATION_ERROR",
          "The cancellation rule is not valid.",
          problems.map((message) => ({ path: "rules", message })),
        );
      }

      const isActive = patch.isActive ?? before.isActive;
      if (before.isActive && !isActive) {
        // Sequential: one transaction = one connection.
        const listings = await tx.listing.count({
          where: { defaultCancellationPolicyId: policyId },
        });
        const provider = await tx.provider.findUniqueOrThrow({
          where: { id: providerId },
          select: { defaultCancellationPolicyId: true },
        });
        const providerDefault = provider.defaultCancellationPolicyId === policyId;
        if (listings > 0 || providerDefault) {
          throw new AppError(
            409,
            "CANCELLATION_POLICY_IN_USE",
            "This policy is in use. Choose another policy for those listings (and the default) first.",
            { listings, providerDefault },
          );
        }
      }

      const after = await tx.cancellationPolicy.update({
        where: { id: policyId },
        data: {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.description !== undefined ? { description: patch.description } : {}),
          nonRefundable,
          rules: rules as unknown as Prisma.InputJsonValue,
          isActive,
        },
      });
      await recordAudit(tx, ctx, {
        action: "cancellation_policy.update",
        entityType: "cancellation_policy",
        entityId: policyId,
        before: auditView(before),
        after: auditView(after),
      });
    }, TX_OPTIONS);
  }

  /** Sets (or clears, with null) the provider's default policy. Setting the same value is a no-op. */
  async function setProviderDefault(
    ctx: AuditContext,
    providerId: string,
    providerStatus: ProviderStatus,
    policyId: string | null,
  ): Promise<{ changed: boolean }> {
    assertProviderWritable(providerStatus);
    return prisma.$transaction(async (tx) => {
      await lockProvider(tx, providerId);
      const provider = await tx.provider.findUniqueOrThrow({
        where: { id: providerId },
        select: { defaultCancellationPolicyId: true },
      });
      if (provider.defaultCancellationPolicyId === policyId) return { changed: false };
      if (policyId) await assertAttachable(tx, providerId, policyId);
      await tx.provider.update({
        where: { id: providerId },
        data: { defaultCancellationPolicyId: policyId },
      });
      await recordAudit(tx, ctx, {
        action: "provider.cancellation_policy.default",
        entityType: "provider",
        entityId: providerId,
        before: { defaultCancellationPolicyId: provider.defaultCancellationPolicyId },
        after: { defaultCancellationPolicyId: policyId },
      });
      return { changed: true };
    }, TX_OPTIONS);
  }

  /** ADMIN, read-only: a provider's policies and its default. */
  async function adminListForProvider(providerId: string) {
    const exists = await prisma.provider.count({ where: { id: providerId } });
    if (exists === 0) throw new AppError(404, "PROVIDER_NOT_FOUND", "Provider not found.");
    return listOwn(providerId);
  }

  return { listOwn, getOwn, create, update, setProviderDefault, adminListForProvider };
}

/**
 * 422 unless the policy can be attached for this provider: its own (or a platform template) and
 * active. Used for the provider default and for listings; the database checks the same.
 */
export async function assertAttachable(
  db: Prisma.TransactionClient | PrismaClient,
  providerId: string,
  policyId: string,
): Promise<void> {
  const policy = await db.cancellationPolicy.findFirst({
    where: { id: policyId, OR: [{ providerId }, { providerId: null }] },
    select: { isActive: true },
  });
  if (!policy) {
    throw new AppError(422, "UNKNOWN_CANCELLATION_POLICY", "Cancellation policy not found.");
  }
  if (!policy.isActive) {
    throw new AppError(
      422,
      "CANCELLATION_POLICY_INACTIVE",
      "This cancellation policy is switched off. Switch it on first, or choose another.",
    );
  }
}

export type CancellationPoliciesService = ReturnType<typeof createCancellationPoliciesService>;
