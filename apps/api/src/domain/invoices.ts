/**
 * Pure rules for commission invoices (ADR 0007, requirements §6): a provider whose customer paid at
 * the property collected the money, so MeroStay invoices the provider for the commission.
 *
 * One invoice per trip and provider; its amount is exactly the sum of the items' commission (which
 * is 15% of each item's subtotal, rounded per item, Phase 2). The database re-checks the sum when
 * an invoice is issued.
 */

export interface InvoiceableItem {
  id: string;
  providerId: string;
  currency: string;
  commissionMinor: bigint;
}

export interface InvoiceDraft {
  providerId: string;
  currency: string;
  amountMinor: bigint;
  itemIds: string[];
}

/** Groups items by provider (in first-seen order) and totals each group's commission. */
export function draftInvoices(items: readonly InvoiceableItem[]): InvoiceDraft[] {
  const byProvider = new Map<string, InvoiceDraft>();
  for (const item of items) {
    if (typeof item.commissionMinor !== "bigint" || item.commissionMinor < 0n) {
      throw new RangeError(`item ${item.id} has an invalid commission`);
    }
    const draft = byProvider.get(item.providerId);
    if (!draft) {
      byProvider.set(item.providerId, {
        providerId: item.providerId,
        currency: item.currency,
        amountMinor: item.commissionMinor,
        itemIds: [item.id],
      });
      continue;
    }
    if (draft.currency !== item.currency) {
      throw new RangeError(`provider ${item.providerId} has items in two currencies`);
    }
    draft.amountMinor += item.commissionMinor;
    draft.itemIds.push(item.id);
  }
  return [...byProvider.values()];
}

const NUMBER_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L confusion

/**
 * Invoice number "INV-YYYYMMDD-XXXXXXXX" (issue date in Nepal + random suffix; unique in the DB).
 * Provisional format: whether Nepal's tax rules require strictly sequential numbers is an open
 * question for the finance phase.
 */
export function invoiceNumber(issueDateKathmandu: string, randomBytes: Uint8Array): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issueDateKathmandu)) {
    throw new RangeError("issue date must be YYYY-MM-DD");
  }
  if (randomBytes.length < 8) throw new RangeError("need at least 8 random bytes");
  let suffix = "";
  for (const byte of randomBytes.slice(0, 8))
    suffix += NUMBER_ALPHABET[byte % NUMBER_ALPHABET.length];
  return `INV-${issueDateKathmandu.replaceAll("-", "")}-${suffix}`;
}
