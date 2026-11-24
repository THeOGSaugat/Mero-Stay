import { fromDbDate } from "../../domain/dates.js";
import { maskAccountNumber } from "../../domain/masking.js";
import { pageInfo, type Page } from "../../lib/pagination.js";
import {
  usableListingTypesOf,
  type AdminProvider,
  type ProviderProfile,
} from "./providers.service.js";

/**
 * Provider responses. Bank account numbers are ONLY ever returned masked (`accountNumberMasked`,
 * last 4): neither the partner nor an admin gets the full number through the API (ADR 0008).
 */

type Doc = ProviderProfile["documents"][number];
type Account = ProviderProfile["payoutAccounts"][number];

export function serializeDocument(doc: Doc) {
  return {
    id: doc.id,
    documentType: doc.documentType,
    status: doc.status,
    mimeType: doc.mimeType,
    sizeBytes: doc.sizeBytes,
    storageKey: doc.storageKey,
    documentNumber: doc.documentNumber,
    expiresOn: doc.expiresOn ? fromDbDate(doc.expiresOn) : null,
    reviewedAt: doc.reviewedAt?.toISOString() ?? null,
    rejectionReason: doc.rejectionReason,
    createdAt: doc.createdAt.toISOString(),
  };
}

export function serializePayoutAccount(account: Account | undefined) {
  if (!account) return null;
  return {
    id: account.id,
    bankName: account.bankName,
    branch: account.branch,
    accountName: account.accountName,
    accountNumberMasked: maskAccountNumber(account.accountNumber),
    verified: account.verifiedAt !== null,
    verifiedAt: account.verifiedAt?.toISOString() ?? null,
  };
}

function documentCounts(docs: readonly Doc[]) {
  const counts = { PENDING: 0, APPROVED: 0, REJECTED: 0 };
  for (const doc of docs) counts[doc.status] += 1;
  return counts;
}

function profileFields(provider: ProviderProfile) {
  return {
    id: provider.id,
    providerType: {
      code: provider.providerType.code,
      name: provider.providerType.name,
      isActive: provider.providerType.isActive,
      /** What this provider may list now (mapped and active, ADR 0013). */
      allowedListingTypes: usableListingTypesOf(provider.providerType),
    },
    legalName: provider.legalName,
    displayName: provider.displayName,
    description: provider.description,
    status: provider.status,
    verifiedAt: provider.verifiedAt?.toISOString() ?? null,
    rejectionReason: provider.rejectionReason,
    contact: {
      email: provider.contactEmail,
      phone: provider.contactPhone,
      addressLine: provider.addressLine,
    },
    tax: {
      panNumber: provider.panNumber,
      vatNumber: provider.vatNumber,
      businessRegistrationNo: provider.businessRegistrationNo,
    },
    payoutAccount: serializePayoutAccount(provider.payoutAccounts[0]),
    documents: documentCounts(provider.documents),
    createdAt: provider.createdAt.toISOString(),
    updatedAt: provider.updatedAt.toISOString(),
  };
}

/** The partner's own provider. Commission rate is MeroStay's setting and shown read-only. */
export function serializeProfile(provider: ProviderProfile) {
  return {
    data: {
      ...profileFields(provider),
      commissionRateBps: provider.commissionRateBps,
    },
  };
}

export function serializeAdminProvider(provider: AdminProvider) {
  return {
    ...profileFields(provider),
    commissionRateBps: provider.commissionRateBps,
    owner: {
      id: provider.owner.id,
      fullName: provider.owner.fullName,
      email: provider.owner.email,
      phone: provider.owner.phone,
    },
    documentList: provider.documents.map(serializeDocument),
  };
}

export function serializeAdminProviderList(providers: AdminProvider[], total: number, page: Page) {
  return {
    data: providers.map((p) => {
      const { documentList: _omitted, ...summary } = serializeAdminProvider(p);
      return summary;
    }),
    page: pageInfo(page, total),
  };
}
