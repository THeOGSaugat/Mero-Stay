import { randomBytes } from "node:crypto";
import type { z } from "zod";
import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import type { ListingStatus } from "../../generated/prisma/enums.js";
import { decideListingType, type ProviderTypeRules } from "../../domain/listing-rules.js";
import { AppError } from "../../lib/errors.js";
import { withIdempotency, type IdempotentResult } from "../../lib/idempotency.js";
import { skipTake } from "../../lib/pagination.js";
import { assertProviderWritable, type PartnerContext } from "../partner/partner-context.js";
import { detailLocationIds, detailSpecFor } from "./listing-details.js";
import type {
  createListingBodySchema,
  listListingsQuerySchema,
  updateListingBodySchema,
} from "./listing-management.schemas.js";
import { DETAIL_INCLUDE } from "./listings.repository.js";

/**
 * Partner listing management (ADR 0008). Every query filters by the partner's provider: another
 * provider's listing is a 404. New listings start as DRAFT; a partner may submit one for review
 * (PENDING_REVIEW), archive it, or reopen an archived one as DRAFT. Approval is an admin action.
 * Money and rates are validated by the same CHECK constraints as everything else (Phase 2).
 */

const TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 } as const;

export const MANAGED_LISTING_INCLUDE = {
  ...DETAIL_INCLUDE,
  listingType: { select: { code: true, name: true, unitLabel: true, isBookable: true } },
  location: { select: { id: true, name: true, slug: true } },
  parent: { select: { id: true, title: true } },
} satisfies Prisma.ListingInclude;

export type ManagedListing = Prisma.ListingGetPayload<{ include: typeof MANAGED_LISTING_INCLUDE }>;

/** Allowed partner status moves: from → to. */
const PARTNER_TRANSITIONS: Record<ListingStatus, readonly ListingStatus[]> = {
  DRAFT: ["PENDING_REVIEW", "ARCHIVED"],
  REJECTED: ["PENDING_REVIEW", "DRAFT", "ARCHIVED"],
  PENDING_REVIEW: ["DRAFT", "ARCHIVED"],
  APPROVED: ["ARCHIVED"],
  ARCHIVED: ["DRAFT"],
  SUSPENDED: [],
};

export function canPartnerMoveListing(from: ListingStatus, to: ListingStatus): boolean {
  return from === to || PARTNER_TRANSITIONS[from].includes(to);
}

const listingNotFound = () => new AppError(404, "LISTING_NOT_FOUND", "Listing not found.");

/** The provider's type with its mapped listing types and both sets of active flags (ADR 0013). */
export async function providerTypeRules(
  db: Prisma.TransactionClient | PrismaClient,
  providerId: string,
): Promise<ProviderTypeRules> {
  const provider = await db.provider.findUniqueOrThrow({
    where: { id: providerId },
    select: {
      providerType: {
        select: {
          code: true,
          isActive: true,
          allowedListingTypes: {
            select: { listingType: { select: { code: true, isActive: true } } },
          },
        },
      },
    },
  });
  const { code, isActive, allowedListingTypes } = provider.providerType;
  return { code, isActive, allowedListingTypes: allowedListingTypes.map((m) => m.listingType) };
}

/**
 * Gap 22: a provider may only create (or change) listings of a type its provider type is mapped
 * to, while both types are active. 422: the request is well-formed but breaks a business rule
 * (like LISTING_TYPE_NOT_OFFERED); nothing is written.
 */
function assertListingTypeAllowed(
  rules: ProviderTypeRules,
  listingType: { code: string; isActive: boolean } | null,
  requestedCode: string,
): void {
  const decision = decideListingType(rules, listingType);
  if (decision.ok) return;
  if (decision.code === "LISTING_TYPE_NOT_OFFERED") {
    throw new AppError(422, "LISTING_TYPE_NOT_OFFERED", "This listing type is not offered.", {
      listingTypeCode: requestedCode,
    });
  }
  throw new AppError(
    422,
    "LISTING_TYPE_NOT_ALLOWED",
    decision.reason === "provider_type_not_offered"
      ? "Your kind of business is not offered yet, so it cannot list this type."
      : "Your kind of business cannot list this type.",
    {
      listingTypeCode: requestedCode,
      providerTypeCode: rules.code,
      reason: decision.reason,
      allowedListingTypes: decision.usable,
    },
  );
}

function slugFor(title: string): string {
  const base = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${base || "listing"}-${randomBytes(4).toString("hex")}`;
}

export function createListingManagementService({ prisma }: { prisma: PrismaClient }) {
  async function get(providerId: string, listingId: string): Promise<ManagedListing> {
    const listing = await prisma.listing.findFirst({
      where: { id: listingId, providerId },
      include: MANAGED_LISTING_INCLUDE,
    });
    if (!listing) throw listingNotFound();
    return listing;
  }

  async function list(providerId: string, query: z.infer<typeof listListingsQuerySchema>) {
    const where: Prisma.ListingWhereInput = {
      providerId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.listingType ? { listingTypeCode: query.listingType } : {}),
    };
    const [listings, total] = await Promise.all([
      prisma.listing.findMany({
        where,
        include: MANAGED_LISTING_INCLUDE,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        ...skipTake(query),
      }),
      prisma.listing.count({ where }),
    ]);
    return { listings, total };
  }

  /** Validates references that must exist / belong to the provider. */
  async function checkReferences(
    tx: Prisma.TransactionClient,
    providerId: string,
    refs: {
      parentId?: string | null;
      locationId?: string | null;
      policyId?: string | null;
      detailLocations?: string[];
    },
  ): Promise<void> {
    if (refs.parentId) {
      const parent = await tx.listing.findFirst({ where: { id: refs.parentId, providerId } });
      if (!parent) throw new AppError(422, "UNKNOWN_PARENT_LISTING", "Parent listing not found.");
    }
    const locationIds = [
      ...(refs.locationId ? [refs.locationId] : []),
      ...(refs.detailLocations ?? []),
    ];
    if (locationIds.length > 0) {
      const found = await tx.location.count({ where: { id: { in: locationIds } } });
      if (found !== new Set(locationIds).size) {
        throw new AppError(422, "UNKNOWN_LOCATION", "Location not found.");
      }
    }
    if (refs.policyId) {
      // The provider's own policies, or platform-wide templates (provider_id NULL).
      const policy = await tx.cancellationPolicy.findFirst({
        where: { id: refs.policyId, OR: [{ providerId }, { providerId: null }] },
      });
      if (!policy) {
        throw new AppError(422, "UNKNOWN_CANCELLATION_POLICY", "Cancellation policy not found.");
      }
    }
  }

  function parseDetails(listingTypeCode: string, details: Record<string, unknown> | undefined) {
    const spec = detailSpecFor(listingTypeCode);
    if (!spec) {
      if (details !== undefined) {
        throw new AppError(
          422,
          "DETAILS_NOT_SUPPORTED",
          `Listing type ${listingTypeCode} has no detail fields; use attributes.`,
        );
      }
      return null;
    }
    if (details === undefined) return null;
    return { relation: spec.relation, data: spec.schema.parse(details) as Record<string, unknown> };
  }

  async function create(
    partner: PartnerContext,
    userId: string,
    input: z.infer<typeof createListingBodySchema>,
    idempotencyKey: string | null,
  ): Promise<IdempotentResult> {
    assertProviderWritable(partner.providerStatus);
    const providerId = partner.providerId;
    const type = await prisma.listingType.findUnique({ where: { code: input.listingTypeCode } });
    assertListingTypeAllowed(
      await providerTypeRules(prisma, providerId),
      type,
      input.listingTypeCode,
    );
    if (!type)
      throw new AppError(422, "LISTING_TYPE_NOT_OFFERED", "This listing type is not offered.");
    const parsed = parseDetails(type.code, input.details);
    if (detailSpecFor(type.code) && !parsed) {
      throw new AppError(422, "DETAILS_REQUIRED", `Listing type ${type.code} needs details.`);
    }

    return withIdempotency(
      prisma,
      idempotencyKey && {
        userId,
        key: idempotencyKey,
        scope: "partner.listing.create",
        request: { providerId, ...input, basePriceMinor: input.basePriceMinor.toString() },
      },
      async (tx) => {
        await checkReferences(tx, providerId, {
          parentId: input.parentId,
          locationId: input.locationId,
          policyId: input.defaultCancellationPolicyId,
          detailLocations: parsed ? detailLocationIds(parsed.data) : [],
        });
        const { details: _details, ...fields } = input;
        const listing = await tx.listing.create({
          data: {
            ...fields,
            attributes: fields.attributes as Prisma.InputJsonObject,
            providerId,
            status: "DRAFT",
            slug: slugFor(input.title),
            ...(parsed ? { [parsed.relation]: { create: parsed.data } } : {}),
          },
        });
        return { resourceId: listing.id, status: 201 };
      },
    );
  }

  async function update(
    partner: PartnerContext,
    listingId: string,
    patch: z.infer<typeof updateListingBodySchema>,
  ): Promise<ManagedListing> {
    assertProviderWritable(partner.providerStatus);
    const providerId = partner.providerId;
    await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id::text AS id FROM listings
        WHERE id = ${listingId}::uuid AND provider_id = ${providerId}::uuid FOR UPDATE`;
      if (rows.length !== 1) throw listingNotFound();
      const listing = await tx.listing.findUniqueOrThrow({
        where: { id: listingId },
        include: { listingType: { select: { code: true, isActive: true } } },
      });
      // Gap 22: changes need the listing's type to be allowed for the provider now. Archiving is
      // always possible, so a listing that no longer fits (an older listing, a type switched
      // off) can still be taken down.
      const archiveOnly = Object.keys(patch).length === 1 && patch.status === "ARCHIVED";
      if (!archiveOnly) {
        assertListingTypeAllowed(
          await providerTypeRules(tx, providerId),
          listing.listingType,
          listing.listingTypeCode,
        );
      }

      if (patch.status && !canPartnerMoveListing(listing.status, patch.status)) {
        throw new AppError(
          409,
          "LISTING_STATUS_NOT_ALLOWED",
          `A partner cannot move a listing from ${listing.status} to ${patch.status}.`,
          { from: listing.status, to: patch.status },
        );
      }
      if (listing.status === "SUSPENDED") {
        throw new AppError(409, "LISTING_SUSPENDED", "This listing is suspended by MeroStay.");
      }
      const parsed = parseDetails(listing.listingTypeCode, patch.details);
      await checkReferences(tx, providerId, {
        locationId: patch.locationId,
        policyId: patch.defaultCancellationPolicyId,
        detailLocations: parsed ? detailLocationIds(parsed.data) : [],
      });
      const { details: _details, ...fields } = patch;
      await tx.listing.update({
        where: { id: listingId },
        data: {
          ...fields,
          ...(fields.attributes ? { attributes: fields.attributes as Prisma.InputJsonObject } : {}),
          ...(parsed
            ? { [parsed.relation]: { upsert: { create: parsed.data, update: parsed.data } } }
            : {}),
        } as Prisma.ListingUncheckedUpdateInput,
      });
    }, TX_OPTIONS);
    return get(providerId, listingId);
  }

  return { get, list, create, update };
}

export type ListingManagementService = ReturnType<typeof createListingManagementService>;
