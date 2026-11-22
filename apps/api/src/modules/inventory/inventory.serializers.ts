import { fromDbDate } from "../../domain/dates.js";
import { currencyInfo, minorToString, nullableMinorToString } from "../../lib/money-json.js";
import type { SlotRow } from "./inventory.service.js";

/** A listing's slots for the partner: capacity, booked, free and the date price (money as strings). */
export function serializeSlots(
  listing: { id: string; currency: string; basePriceMinor: bigint },
  slots: SlotRow[],
) {
  return {
    data: {
      listingId: listing.id,
      ...currencyInfo(listing.currency),
      basePriceMinor: minorToString(listing.basePriceMinor),
      slots: slots.map((slot) => ({
        id: slot.id,
        date: fromDbDate(slot.serviceDate),
        status: slot.status,
        capacityTotal: slot.capacityTotal,
        capacityBooked: slot.capacityBooked,
        available: Math.max(slot.capacityTotal - slot.capacityBooked, 0),
        priceOverrideMinor: nullableMinorToString(slot.priceOverrideMinor),
        effectivePriceMinor: minorToString(slot.priceOverrideMinor ?? listing.basePriceMinor),
      })),
    },
  };
}
