import { randomBytes } from "node:crypto";
import {
  cancellationSnapshot,
  resolveCancellationPolicy,
} from "../../domain/cancellation-policy.js";
import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import type { BookingItemStatus } from "../../generated/prisma/enums.js";
import {
  InvalidDateRangeError,
  enumerateServiceDates,
  fromDbDate,
  toDbDate,
  todayInKathmandu,
} from "../../domain/dates.js";
import {
  assertCommissionTransition,
  assertItemTransition,
} from "../../domain/booking-item-status.js";
import { serviceStartFields } from "../../domain/refunds.js";
import { mapDatabaseError } from "../../lib/database-errors.js";
import { listingStartTime } from "../listings/listing-details.js";
import { issueCommissionInvoices } from "../finance/invoices.service.js";
import { AppError } from "../../lib/errors.js";
import { assertNotInPast, invalidDateRange } from "../listings/listings.service.js";
import {
  CurrencyMismatchError,
  paymentMethodOf,
  priceItem,
  statusesForPaymentMethod,
  summarizeQuote,
  type PaymentMethod,
  type PricedItem,
  type TripQuoteTotals,
} from "./trip-pricing.js";
import {
  ACTIVE_ITEM_STATUSES,
  adjustBookedUnits,
  findActiveItems,
  findItemInTrip,
  findListingForBooking,
  findSlotsForDates,
  findTrip,
  findTripsOfCustomer,
  lockTrip,
  type BookingListing,
  type TripWithItems,
  recalculateTripTotals,
} from "./trips.repository.js";
import type { AddItemInput, ListTripsQuery, UpdateItemInput } from "./trips.schemas.js";

/** How long a draft (or an awaiting-payment trip) holds its inventory. Refreshed on every edit. */
export const DEFAULT_HOLD_MINUTES = 30;

/** Interactive transactions run several sequential queries; give hosted databases room. */
const TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 } as const;

export interface TripsServiceDeps {
  prisma: PrismaClient;
  now: () => Date;
  holdMinutes?: number;
}

interface ItemRequest {
  listingId: string;
  startDate: string;
  endDate?: string | null;
  quantity: number;
  travellerCount?: number;
  paymentMethod: PaymentMethod;
  attributes?: Record<string, unknown>;
}

interface ResolvedItem {
  listing: BookingListing;
  request: ItemRequest;
  dates: string[];
  /** Inventory row per date, in date order; null where the listing has no row for that date. */
  slots: ({ id: string; status: string; capacityTotal: number; capacityBooked: number } | null)[];
  priced: PricedItem;
}

export type QuoteLine = {
  itemId: string | null;
  candidateIndex: number | null;
  listing: { id: string; title: string; listingType: string };
  paymentMethod: PaymentMethod;
  startDate: string;
  endDate: string | null;
  quantity: number;
  available: boolean;
  unavailableDates: string[];
  priced: PricedItem;
  held: PricedItem | null;
  priceChanged: boolean;
};

export interface TripQuote {
  trip: TripWithItems;
  lines: QuoteLine[];
  totals: TripQuoteTotals;
}

function isBookable(listing: BookingListing): boolean {
  return (
    listing.status === "APPROVED" &&
    listing.provider.status === "VERIFIED" &&
    listing.listingType.isActive &&
    listing.listingType.isBookable
  );
}

function generateReference(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L confusion
  const bytes = randomBytes(8);
  let code = "";
  for (const byte of bytes) code += alphabet[byte % alphabet.length];
  return `MS-${code}`;
}

export function createTripsService({
  prisma,
  now,
  holdMinutes = DEFAULT_HOLD_MINUTES,
}: TripsServiceDeps) {
  const holdUntil = () => new Date(now().getTime() + holdMinutes * 60_000);

  /** The caller's own trip, or 404 (also for trips that exist but belong to someone else). */
  async function getTrip(id: string, ownerId: string): Promise<TripWithItems> {
    const trip = await findTrip(prisma, id, ownerId);
    if (!trip) throw new AppError(404, "TRIP_NOT_FOUND", "Trip not found.");
    return trip;
  }

  function assertEditable(trip: { status: string; expiresAt: Date | null }): void {
    if (trip.status !== "DRAFT") {
      throw new AppError(
        409,
        "TRIP_NOT_EDITABLE",
        `Trip is ${trip.status}; only DRAFT trips can change.`,
        {
          status: trip.status,
        },
      );
    }
    if (trip.expiresAt && trip.expiresAt.getTime() <= now().getTime()) {
      throw new AppError(409, "TRIP_EXPIRED", "This trip's hold has expired. Start a new trip.");
    }
  }

  async function lockEditableTrip(tx: Prisma.TransactionClient, tripId: string, ownerId: string) {
    if (!(await lockTrip(tx, tripId, ownerId))) {
      throw new AppError(404, "TRIP_NOT_FOUND", "Trip not found.");
    }
    const trip = await tx.trip.findUniqueOrThrow({ where: { id: tripId } });
    assertEditable(trip);
    return trip;
  }

  /**
   * Validates a requested item and prices it from CURRENT data. Does not write anything.
   * Throws for problems the client must fix; unavailable dates are reported, not thrown, so the
   * quote can show them. Writers call `assertAvailableSlots` afterwards.
   */
  async function resolveItem(
    db: PrismaClient | Prisma.TransactionClient,
    tripCurrency: string,
    request: ItemRequest,
  ): Promise<ResolvedItem> {
    const listing = await findListingForBooking(db, request.listingId);
    if (!listing) throw new AppError(422, "UNKNOWN_LISTING", "listingId does not match a listing.");
    if (!isBookable(listing)) {
      throw new AppError(422, "LISTING_NOT_BOOKABLE", "This listing cannot be booked.");
    }
    if (listing.currency !== tripCurrency) {
      throw new AppError(
        422,
        "CURRENCY_MISMATCH",
        `Listing is priced in ${listing.currency} but the trip uses ${tripCurrency}. One currency per trip.`,
        { tripCurrency, listingCurrency: listing.currency },
      );
    }

    let dates: string[];
    try {
      dates = enumerateServiceDates(request.startDate, request.endDate);
    } catch (err) {
      if (err instanceof InvalidDateRangeError) throw invalidDateRange(err);
      throw err;
    }
    assertNotInPast(request.startDate, todayInKathmandu(now()));

    const rows = await findSlotsForDates(db, listing.id, dates);
    const byDate = new Map(rows.map((row) => [fromDbDate(row.serviceDate), row]));
    const slots = dates.map((date) => byDate.get(date) ?? null);

    const priced = priceItem(
      {
        currency: listing.currency,
        basePriceMinor: listing.basePriceMinor,
        serviceChargeRateBps: listing.serviceChargeRateBps,
        taxRateBps: listing.taxRateBps,
        commissionRateBps: listing.commissionRateBps,
        providerCommissionRateBps: listing.provider.commissionRateBps,
      },
      dates.map((date) => ({
        date,
        priceOverrideMinor: byDate.get(date)?.priceOverrideMinor ?? null,
      })),
      request.quantity,
    );

    return { listing, request, dates, slots, priced };
  }

  /** Dates with no inventory row or a CLOSED row: never sellable. */
  function closedDates(resolved: ResolvedItem): string[] {
    return resolved.dates.filter((_date, i) => {
      const slot = resolved.slots[i];
      return !slot || slot.status !== "OPEN";
    });
  }

  /**
   * Reserves the units on every date. Relies on the database CHECK constraint for capacity
   * (no application-side capacity arithmetic), mapping a violation to a clean 409.
   */
  async function reserve(tx: Prisma.TransactionClient, resolved: ResolvedItem): Promise<void> {
    const unavailable = closedDates(resolved);
    if (unavailable.length > 0) {
      throw new AppError(
        409,
        "NOT_AVAILABLE",
        "The listing is not on sale for some of the requested dates.",
        {
          unavailableDates: unavailable,
        },
      );
    }
    for (const [i, slot] of resolved.slots.entries()) {
      if (!slot) continue;
      try {
        await adjustBookedUnits(tx, slot.id, resolved.request.quantity);
      } catch (err) {
        const mapped = mapDatabaseError(err);
        if (mapped?.code === "INSUFFICIENT_AVAILABILITY") {
          throw new AppError(409, mapped.code, mapped.message, {
            date: resolved.dates[i],
            requested: resolved.request.quantity,
          });
        }
        throw err;
      }
    }
  }

  async function release(
    tx: Prisma.TransactionClient,
    slots: { inventorySlotId: string | null; units: number }[],
  ): Promise<void> {
    for (const slot of slots) {
      if (slot.inventorySlotId) await adjustBookedUnits(tx, slot.inventorySlotId, -slot.units);
    }
  }

  function itemWriteData(tripId: string, resolved: ResolvedItem) {
    const { listing, request, priced } = resolved;
    // Listing's policy → provider's default → none (ADR 0015), frozen onto the item now.
    const policy = resolveCancellationPolicy(
      listing.defaultCancellationPolicy,
      listing.provider.defaultCancellationPolicy,
    );
    return {
      listingTypeCode: listing.listingTypeCode,
      startDate: toDbDate(request.startDate),
      endDate: request.endDate ? toDbDate(request.endDate) : null,
      // When the service starts, frozen now (the refund clock, owner decision 2026-11-27).
      ...serviceStartFields(request.startDate, listingStartTime(listing)),
      travellerCount: request.travellerCount ?? request.quantity,
      quantity: priced.quantity,
      currency: priced.currency,
      subtotalMinor: priced.subtotalMinor,
      serviceChargeRateBps: priced.serviceChargeRateBps,
      serviceChargeMinor: priced.serviceChargeMinor,
      taxRateBps: priced.taxRateBps,
      taxMinor: priced.taxMinor,
      totalMinor: priced.totalMinor,
      commissionRateBps: priced.commissionRateBps,
      commissionMinor: priced.commissionMinor,
      providerPayoutMinor: priced.providerPayoutMinor,
      ...statusesForPaymentMethod(request.paymentMethod),
      cancellationPolicyId: policy?.policy.id ?? null,
      // Frozen copy: later policy edits never change this booking.
      cancellationPolicySnapshot: policy
        ? (cancellationSnapshot(policy, now()) as unknown as Prisma.InputJsonValue)
        : Prisma.DbNull,
      attributes: (request.attributes ?? {}) as Prisma.InputJsonValue,
      slots: {
        create: priced.lines.map((line, i) => ({
          inventorySlotId: resolved.slots[i]?.id ?? null,
          serviceDate: toDbDate(line.date),
          units: line.units,
          unitPriceMinor: line.unitPriceMinor,
          amountMinor: line.amountMinor,
        })),
      },
      tripId,
    };
  }

  /** Trip totals = sum of its active items (CANCELLED/EXPIRED items no longer count). */
  const recalculateTrip = recalculateTripTotals;

  async function createTrip(
    ownerId: string,
    input: { currency: string; contact?: { name?: string; phone?: string; email?: string } },
  ): Promise<TripWithItems> {
    // The owner comes from the authenticated session (never from the request body).
    const user = await prisma.user.findUnique({
      where: { id: ownerId },
      select: { id: true, fullName: true, phone: true, email: true },
    });
    if (!user) throw new AppError(401, "UNAUTHENTICATED", "Log in to continue.");

    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const trip = await prisma.trip.create({
          data: {
            reference: generateReference(),
            customerId: user.id,
            currency: input.currency,
            contactName: input.contact?.name ?? user.fullName,
            contactPhone: input.contact?.phone ?? user.phone,
            contactEmail: input.contact?.email ?? user.email,
            expiresAt: holdUntil(),
          },
        });
        return getTrip(trip.id, user.id);
      } catch (err) {
        if (mapDatabaseError(err)?.code === "CONFLICT" && attempt < 4) continue; // reference collision
        throw err;
      }
    }
    throw new AppError(500, "INTERNAL_ERROR", "Could not allocate a trip reference.");
  }

  async function addItem(
    tripId: string,
    ownerId: string,
    input: AddItemInput,
  ): Promise<{ trip: TripWithItems; itemId: string }> {
    const itemId = await prisma.$transaction(async (tx) => {
      const trip = await lockEditableTrip(tx, tripId, ownerId);
      const resolved = await resolveItem(tx, trip.currency, input);
      await reserve(tx, resolved);
      const item = await tx.bookingItem.create({
        data: {
          ...itemWriteData(trip.id, resolved),
          providerId: resolved.listing.providerId,
          listingId: resolved.listing.id,
        },
      });
      await recalculateTrip(tx, trip, { expiresAt: holdUntil() });
      return item.id;
    }, TX_OPTIONS);
    return { trip: await getTrip(tripId, ownerId), itemId };
  }

  async function updateItem(
    tripId: string,
    ownerId: string,
    itemId: string,
    patch: UpdateItemInput,
  ): Promise<TripWithItems> {
    await prisma.$transaction(async (tx) => {
      const trip = await lockEditableTrip(tx, tripId, ownerId);
      const item = await findItemInTrip(tx, tripId, itemId);
      if (!item) throw new AppError(404, "ITEM_NOT_FOUND", "Booking item not found in this trip.");

      const request: ItemRequest = {
        listingId: item.listingId,
        startDate: patch.startDate ?? fromDbDate(item.startDate),
        endDate:
          "endDate" in patch ? patch.endDate : item.endDate ? fromDbDate(item.endDate) : null,
        quantity: patch.quantity ?? item.slots[0]?.units ?? item.quantity,
        travellerCount: patch.travellerCount ?? item.travellerCount,
        paymentMethod: patch.paymentMethod ?? paymentMethodOf(item.paymentStatus),
        attributes: patch.attributes ?? (item.attributes as Record<string, unknown>),
      };

      // Give back the old holds first, then reserve the new ones. If anything fails, the whole
      // transaction rolls back and the item is exactly as it was.
      await release(tx, item.slots);
      await tx.bookingItemSlot.deleteMany({ where: { bookingItemId: item.id } });
      const resolved = await resolveItem(tx, trip.currency, request);
      await reserve(tx, resolved);
      const { tripId: _tripId, ...data } = itemWriteData(trip.id, resolved);
      await tx.bookingItem.update({ where: { id: item.id }, data });
      await recalculateTrip(tx, trip, { expiresAt: holdUntil() });
    }, TX_OPTIONS);
    return getTrip(tripId, ownerId);
  }

  async function removeItem(
    tripId: string,
    ownerId: string,
    itemId: string,
  ): Promise<TripWithItems> {
    await prisma.$transaction(async (tx) => {
      const trip = await lockEditableTrip(tx, tripId, ownerId);
      const item = await findItemInTrip(tx, tripId, itemId);
      if (!item) throw new AppError(404, "ITEM_NOT_FOUND", "Booking item not found in this trip.");
      await release(tx, item.slots);
      await tx.bookingItemSlot.deleteMany({ where: { bookingItemId: item.id } });
      await tx.bookingItem.delete({ where: { id: item.id } });
      await recalculateTrip(tx, trip, { expiresAt: holdUntil() });
    }, TX_OPTIONS);
    return getTrip(tripId, ownerId);
  }

  /**
   * Dry run: re-prices every item of the trip from CURRENT listing/inventory data, plus optional
   * candidate items, without writing anything. Availability here is advisory (it can change a
   * moment later); the authoritative check is the database constraint when an item is added.
   */
  async function quote(
    tripId: string,
    ownerId: string,
    candidates: AddItemInput[],
  ): Promise<TripQuote> {
    const trip = await getTrip(tripId, ownerId);
    assertEditable(trip);

    const lines: QuoteLine[] = [];
    const activeItems = trip.items.filter((item) =>
      (ACTIVE_ITEM_STATUSES as readonly BookingItemStatus[]).includes(item.status),
    );

    for (const item of activeItems) {
      const unitsPerDate = item.slots[0]?.units ?? item.quantity;
      const request: ItemRequest = {
        listingId: item.listingId,
        startDate: fromDbDate(item.startDate),
        endDate: item.endDate ? fromDbDate(item.endDate) : null,
        quantity: unitsPerDate,
        paymentMethod: paymentMethodOf(item.paymentStatus),
      };
      const resolved = await resolveItem(prisma, trip.currency, request);
      // This item already holds `unitsPerDate` on each of its own dates, so count those as free.
      const ownHeld = new Map(item.slots.map((slot) => [slot.inventorySlotId, slot.units]));
      lines.push(
        toQuoteLine(resolved, {
          itemId: item.id,
          candidateIndex: null,
          ownHeld,
          held: heldPricing(item),
        }),
      );
    }

    for (const [index, candidate] of candidates.entries()) {
      const resolved = await resolveItem(prisma, trip.currency, candidate);
      lines.push(
        toQuoteLine(resolved, {
          itemId: null,
          candidateIndex: index,
          ownHeld: new Map(),
          held: null,
        }),
      );
    }

    let totals: TripQuoteTotals;
    try {
      totals = summarizeQuote(
        trip.currency,
        lines.map((line) => ({ ...line.priced, paymentMethod: line.paymentMethod })),
      );
    } catch (err) {
      if (err instanceof CurrencyMismatchError) {
        throw new AppError(422, "CURRENCY_MISMATCH", err.message);
      }
      throw err;
    }
    return { trip, lines, totals };
  }

  function heldPricing(item: TripWithItems["items"][number]): PricedItem {
    return {
      currency: item.currency,
      quantity: item.quantity,
      lines: item.slots.map((slot) => ({
        date: fromDbDate(slot.serviceDate),
        units: slot.units,
        unitPriceMinor: slot.unitPriceMinor,
        amountMinor: slot.amountMinor,
      })),
      subtotalMinor: item.subtotalMinor,
      serviceChargeRateBps: item.serviceChargeRateBps,
      serviceChargeMinor: item.serviceChargeMinor,
      taxRateBps: item.taxRateBps,
      taxMinor: item.taxMinor,
      totalMinor: item.totalMinor,
      commissionRateBps: item.commissionRateBps,
      commissionMinor: item.commissionMinor,
      providerPayoutMinor: item.providerPayoutMinor,
    };
  }

  function toQuoteLine(
    resolved: ResolvedItem,
    ctx: {
      itemId: string | null;
      candidateIndex: number | null;
      ownHeld: Map<string | null, number>;
      held: PricedItem | null;
    },
  ): QuoteLine {
    const unavailableDates = resolved.dates.filter((_date, i) => {
      const slot = resolved.slots[i];
      if (!slot || slot.status !== "OPEN") return true;
      const free = slot.capacityTotal - slot.capacityBooked + (ctx.ownHeld.get(slot.id) ?? 0);
      return free < resolved.request.quantity;
    });
    return {
      itemId: ctx.itemId,
      candidateIndex: ctx.candidateIndex,
      listing: {
        id: resolved.listing.id,
        title: resolved.listing.title,
        listingType: resolved.listing.listingTypeCode,
      },
      paymentMethod: resolved.request.paymentMethod,
      startDate: resolved.request.startDate,
      endDate: resolved.request.endDate ?? null,
      quantity: resolved.request.quantity,
      available: unavailableDates.length === 0,
      unavailableDates,
      priced: resolved.priced,
      held: ctx.held,
      priceChanged: ctx.held !== null && ctx.held.totalMinor !== resolved.priced.totalMinor,
    };
  }

  /**
   * Submits the trip. No payment is taken here (see the payments module, ADR 0007):
   * - pay-at-property items → CONFIRMED, commission INVOICED with an issued commission invoice per
   *   provider (owed by the provider, §6.1);
   * - online items stay PENDING / UNPAID until they are paid online; their commission will be
   *   deducted from the provider payout.
   * Trip → CONFIRMED when every item is confirmed, otherwise PENDING (awaiting payment) with a
   * fresh hold window. Money snapshots were frozen when items were added; nothing is re-priced.
   */
  async function confirm(tripId: string, ownerId: string): Promise<TripWithItems> {
    await prisma.$transaction(async (tx) => {
      const trip = await lockEditableTrip(tx, tripId, ownerId);
      const items = await findActiveItems(tx, tripId);
      if (items.length === 0)
        throw new AppError(409, "TRIP_EMPTY", "Add at least one item before confirming.");

      for (const item of items) {
        const { listing } = item;
        const stillBookable =
          listing.status === "APPROVED" &&
          listing.provider.status === "VERIFIED" &&
          listing.listingType.isActive &&
          listing.listingType.isBookable;
        if (!stillBookable) {
          throw new AppError(
            409,
            "ITEM_NO_LONGER_BOOKABLE",
            "An item's listing can no longer be booked.",
            {
              itemId: item.id,
            },
          );
        }
      }

      const confirmedAt = now();
      let awaitingPayment = false;
      for (const item of items) {
        if (paymentMethodOf(item.paymentStatus) === "pay_at_property") {
          assertItemTransition(item.status, "CONFIRMED");
          assertCommissionTransition(item.commissionStatus, "INVOICED", item.paymentStatus);
          await tx.bookingItem.update({
            where: { id: item.id },
            data: { status: "CONFIRMED", confirmedAt },
          });
        } else {
          awaitingPayment = true; // stays PENDING / UNPAID until it is paid online (ADR 0007)
        }
      }
      // Commission of the pay-at-property items → INVOICED, backed by one issued invoice per
      // provider (same transaction, so an invoice exists exactly when the commission is INVOICED).
      await issueCommissionInvoices(tx, trip.id, confirmedAt);

      await recalculateTrip(tx, trip, {
        status: awaitingPayment ? "PENDING" : "CONFIRMED",
        confirmedAt: awaitingPayment ? null : confirmedAt,
        expiresAt: awaitingPayment ? holdUntil() : null,
      });
    }, TX_OPTIONS);
    return getTrip(tripId, ownerId);
  }

  /**
   * Releases inventory held by trips whose hold window has passed: their PENDING items that hold
   * no customer money become EXPIRED; confirmed items (pay-at-property, or paid online) are kept.
   * Items with part of their price already paid online (PARTIALLY_PAID) are never expired: the
   * customer's money is attached to them (a CHECK enforces it). Open payment intents of a swept
   * trip are cancelled. The trip then becomes PENDING (partly paid items left), CONFIRMED (only
   * confirmed items left) or EXPIRED (nothing left).
   *
   * One transaction per batch: one locking SELECT and four set-based updates, regardless of how
   * many trips are stale (a per-trip loop took ~4 s per trip over Neon's network latency).
   *
   * Idempotent and safe to run concurrently (scheduled by src/jobs/hold-release.ts, ADR 0007):
   * `FOR UPDATE SKIP LOCKED` gives each concurrent run a disjoint set of trips (and skips trips a
   * live request is editing), and a swept trip no longer matches the WHERE clause, so its holds
   * can only ever be released once.
   */
  async function expireStaleTrips(limit = 500): Promise<number> {
    // The only item change made here is PENDING → EXPIRED; check it against the domain rules once.
    assertItemTransition("PENDING", "EXPIRED");
    const at = now();

    return prisma.$transaction(async (tx) => {
      const stale = await tx.$queryRaw<{ id: string }[]>`
        SELECT id::text AS id FROM trips
        WHERE status IN ('DRAFT', 'PENDING') AND expires_at <= ${at}
        ORDER BY expires_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED`;
      if (stale.length === 0) return 0;
      const ids = stale.map((row) => row.id);

      // 1. Give back every unit held by those trips' PENDING items.
      await tx.$executeRaw`
        UPDATE inventory_slots s
        SET capacity_booked = s.capacity_booked - held.units, updated_at = ${at}
        FROM (
          SELECT bis.inventory_slot_id, SUM(bis.units)::int AS units
          FROM booking_item_slots bis
          JOIN booking_items bi ON bi.id = bis.booking_item_id
          WHERE bi.trip_id = ANY(${ids}::uuid[])
            AND bi.status = 'PENDING'
            AND bi.payment_status IN ('UNPAID', 'PAY_AT_PROPERTY')
            AND bis.inventory_slot_id IS NOT NULL
          GROUP BY bis.inventory_slot_id
        ) held
        WHERE s.id = held.inventory_slot_id`;

      // 2. Expire those items.
      await tx.$executeRaw`
        UPDATE booking_items SET status = 'EXPIRED', updated_at = ${at}
        WHERE trip_id = ANY(${ids}::uuid[])
          AND status = 'PENDING'
          AND payment_status IN ('UNPAID', 'PAY_AT_PROPERTY')`;

      // 3. Trip totals = sums of remaining active items; status from what is left.
      await tx.$executeRaw`
        UPDATE trips t SET
          subtotal_minor         = agg.subtotal,
          service_charge_minor   = agg.service_charge,
          tax_minor              = agg.tax,
          total_minor            = agg.total,
          commission_total_minor = agg.commission,
          status = CASE
            WHEN agg.pending > 0 THEN 'PENDING'::trip_status
            WHEN agg.confirmed > 0 THEN 'CONFIRMED'::trip_status
            ELSE 'EXPIRED'::trip_status END,
          confirmed_at = CASE
            WHEN agg.pending = 0 AND agg.confirmed > 0 THEN COALESCE(t.confirmed_at, ${at})
            ELSE t.confirmed_at END,
          expires_at = NULL,
          updated_at = ${at}
        FROM (
          SELECT t2.id,
            COALESCE(SUM(bi.subtotal_minor)       FILTER (WHERE bi.status NOT IN ('CANCELLED', 'EXPIRED')), 0) AS subtotal,
            COALESCE(SUM(bi.service_charge_minor) FILTER (WHERE bi.status NOT IN ('CANCELLED', 'EXPIRED')), 0) AS service_charge,
            COALESCE(SUM(bi.tax_minor)            FILTER (WHERE bi.status NOT IN ('CANCELLED', 'EXPIRED')), 0) AS tax,
            COALESCE(SUM(bi.total_minor)          FILTER (WHERE bi.status NOT IN ('CANCELLED', 'EXPIRED')), 0) AS total,
            COALESCE(SUM(bi.commission_minor)     FILTER (WHERE bi.status NOT IN ('CANCELLED', 'EXPIRED')), 0) AS commission,
            COUNT(*) FILTER (WHERE bi.status = 'CONFIRMED') AS confirmed,
            COUNT(*) FILTER (WHERE bi.status = 'PENDING') AS pending
          FROM trips t2
          LEFT JOIN booking_items bi ON bi.trip_id = t2.id
          WHERE t2.id = ANY(${ids}::uuid[])
          GROUP BY t2.id
        ) agg
        WHERE t.id = agg.id`;

      // 4. Cancel their open payment intents (they covered items that no longer exist as due).
      await tx.$executeRaw`
        UPDATE payments SET status = 'CANCELLED', completed_at = ${at}, updated_at = ${at}
        WHERE trip_id = ANY(${ids}::uuid[])
          AND kind = 'CHARGE'
          AND status IN ('INITIATED', 'PENDING')`;

      return ids.length;
    }, TX_OPTIONS);
  }

  /** The caller's own trips (owner-scoped in the query), newest first. */
  async function listTrips(ownerId: string, query: ListTripsQuery) {
    const { trips, total } = await findTripsOfCustomer(prisma, ownerId, {
      status: query.status,
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    });
    return { trips, total, page: query.page, pageSize: query.pageSize };
  }

  return {
    createTrip,
    getTrip,
    listTrips,
    addItem,
    updateItem,
    removeItem,
    quote,
    confirm,
    expireStaleTrips,
  };
}

export type TripsService = ReturnType<typeof createTripsService>;
