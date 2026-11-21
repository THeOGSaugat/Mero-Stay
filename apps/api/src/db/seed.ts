import type { Prisma, PrismaClient } from "../generated/prisma/client.js";
import {
  calculateItemCharges,
  resolveCommissionRateBps,
  summarizeTrip,
  type ItemCharges,
} from "../domain/money.js";
import { issueCommissionInvoices } from "../modules/finance/invoices.service.js";

/**
 * SAMPLE data for local development and tests. All names are fictional ("Sample").
 * Reference data (provider_types, listing_types) comes from the migration, not from here.
 *
 * Models the two journeys from the product brief:
 *  1. Inaruwa → Shree Antu: bus (paid online) + homestay (pay at property), one trip.
 *  2. Annapurna Base Camp: a guide for 5 days, completed, with a verified review.
 */

export const SEED_MARKER_EMAIL = "seed-admin@merostay.test";

const SEED_TRANSACTION_OPTIONS = { maxWait: 15_000, timeout: 120_000 } as const;

export interface SeedSummary {
  users: number;
  providers: number;
  listings: number;
  trips: number;
  bookingItems: number;
}

const date = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

/**
 * A succeeded online payment of one whole item, recorded in the order the database requires
 * (ADR 0007): payment captured → allocation → item PAID. The guard triggers reject any shortcut.
 */
async function recordSamplePayment(
  tx: Prisma.TransactionClient,
  input: {
    tripId: string;
    itemId: string;
    gateway: string;
    amountMinor: bigint;
    gatewayTransactionId: string;
  },
): Promise<void> {
  await tx.payment.create({
    data: {
      tripId: input.tripId,
      gateway: input.gateway,
      status: "SUCCEEDED",
      amountMinor: input.amountMinor,
      capturedMinor: input.amountMinor,
      gatewayTransactionId: input.gatewayTransactionId,
      completedAt: new Date(),
      allocations: { create: [{ bookingItemId: input.itemId, amountMinor: input.amountMinor }] },
    },
  });
  await tx.bookingItem.update({ where: { id: input.itemId }, data: { paymentStatus: "PAID" } });
}

function itemMoney(charges: ItemCharges) {
  return {
    quantity: charges.quantity,
    subtotalMinor: charges.subtotalMinor,
    serviceChargeRateBps: charges.serviceChargeRateBps,
    serviceChargeMinor: charges.serviceChargeMinor,
    taxRateBps: charges.taxRateBps,
    taxMinor: charges.taxMinor,
    totalMinor: charges.totalMinor,
    commissionRateBps: charges.commissionRateBps,
    commissionMinor: charges.commissionMinor,
    providerPayoutMinor: charges.providerPayoutMinor,
  };
}

/** Inserts the sample data. Refuses to run twice (checks for the seed marker user). */
export async function seedDatabase(prisma: PrismaClient): Promise<SeedSummary> {
  const existing = await prisma.user.findUnique({ where: { email: SEED_MARKER_EMAIL } });
  if (existing) {
    throw new Error(
      "Sample data is already present (seed marker user exists). Nothing was changed.",
    );
  }

  return prisma.$transaction(async (tx) => {
    // ---------------------------------------------------------------- locations
    const nepal = await tx.location.create({
      data: { kind: "COUNTRY", name: "Nepal", slug: "nepal" },
    });
    const koshi = await tx.location.create({
      data: { kind: "PROVINCE", name: "Koshi Province", slug: "koshi", parentId: nepal.id },
    });
    const sunsari = await tx.location.create({
      data: { kind: "DISTRICT", name: "Sunsari", slug: "sunsari", parentId: koshi.id },
    });
    const inaruwa = await tx.location.create({
      data: { kind: "MUNICIPALITY", name: "Inaruwa", slug: "inaruwa", parentId: sunsari.id },
    });
    const ilam = await tx.location.create({
      data: { kind: "DISTRICT", name: "Ilam", slug: "ilam", parentId: koshi.id },
    });
    const shreeAntu = await tx.location.create({
      data: { kind: "AREA", name: "Shree Antu", slug: "shree-antu", parentId: ilam.id },
    });
    const gandaki = await tx.location.create({
      data: { kind: "PROVINCE", name: "Gandaki Province", slug: "gandaki", parentId: nepal.id },
    });
    const kaski = await tx.location.create({
      data: { kind: "DISTRICT", name: "Kaski", slug: "kaski", parentId: gandaki.id },
    });
    const pokhara = await tx.location.create({
      data: { kind: "MUNICIPALITY", name: "Pokhara", slug: "pokhara", parentId: kaski.id },
    });
    await tx.location.create({
      data: {
        kind: "POINT_OF_INTEREST",
        name: "Annapurna Base Camp",
        slug: "annapurna-base-camp",
        parentId: kaski.id,
      },
    });

    // -------------------------------------------------------------------- users
    await tx.user.create({
      data: { email: SEED_MARKER_EMAIL, fullName: "Sample Admin", role: "ADMIN" },
    });
    const homestayOwner = await tx.user.create({
      data: {
        email: "homestay@merostay.test",
        phone: "+9779800000001",
        fullName: "Sample Homestay Owner",
        role: "PARTNER",
      },
    });
    const busOwner = await tx.user.create({
      data: {
        email: "bus@merostay.test",
        phone: "+9779800000002",
        fullName: "Sample Bus Operator",
        role: "PARTNER",
      },
    });
    const guideUser = await tx.user.create({
      data: {
        email: "guide@merostay.test",
        phone: "+9779800000003",
        fullName: "Sample Guide",
        role: "PARTNER",
      },
    });
    const tourOwner = await tx.user.create({
      data: { email: "tours@merostay.test", fullName: "Sample Tour Operator", role: "PARTNER" },
    });
    const customer = await tx.user.create({
      data: {
        email: "traveller@merostay.test",
        phone: "+9779800000009",
        fullName: "Sample Traveller",
      },
    });

    // ---------------------------------------- cancellation policies (SAMPLE templates)
    const flexible = await tx.cancellationPolicy.create({
      data: {
        name: "Flexible (sample)",
        description: "Full refund up to 24 hours before the service starts.",
        rules: [{ minHoursBeforeStart: 24, refundBps: 10000 }],
      },
    });
    const moderate = await tx.cancellationPolicy.create({
      data: {
        name: "Moderate (sample)",
        description: "Full refund up to 72 hours before; 50% up to 24 hours before.",
        rules: [
          { minHoursBeforeStart: 72, refundBps: 10000 },
          { minHoursBeforeStart: 24, refundBps: 5000 },
        ],
      },
    });
    await tx.cancellationPolicy.create({
      data: { name: "Non-refundable (sample)", description: "No refund after booking.", rules: [] },
    });

    // ---------------------------------------------------------------- providers
    const homestay = await tx.provider.create({
      data: {
        providerTypeCode: "hotel",
        ownerUserId: homestayOwner.id,
        legalName: "Sample Hillside Homestay",
        displayName: "Hillside Homestay (sample)",
        status: "VERIFIED",
        contactPhone: "+9779800000001",
        verifiedAt: new Date(),
      },
    });
    const busOperator = await tx.provider.create({
      data: {
        providerTypeCode: "bus_operator",
        ownerUserId: busOwner.id,
        legalName: "Sample Mechi Hills Yatayat Pvt. Ltd.",
        displayName: "Mechi Hills Bus (sample)",
        status: "VERIFIED",
        panNumber: "000000000",
        verifiedAt: new Date(),
      },
    });
    const guide = await tx.provider.create({
      data: {
        providerTypeCode: "guide",
        ownerUserId: guideUser.id,
        legalName: "Sample Guide",
        displayName: "Sample Annapurna Guide",
        status: "VERIFIED",
        verifiedAt: new Date(),
      },
    });
    const tourOperator = await tx.provider.create({
      data: {
        providerTypeCode: "tour_operator",
        ownerUserId: tourOwner.id,
        legalName: "Sample Annapurna Trails Pvt. Ltd.",
        displayName: "Annapurna Trails (sample)",
        status: "PENDING_VERIFICATION",
        // Shows a per-provider commission override (10%).
        commissionRateBps: 1000,
      },
    });
    await tx.providerDocument.create({
      data: {
        providerId: busOperator.id,
        documentType: "PAN_CERTIFICATE",
        storageKey: "sample/provider-documents/pan.pdf",
        mimeType: "application/pdf",
        sizeBytes: 120_000,
        status: "APPROVED",
      },
    });
    await tx.providerPayoutAccount.create({
      data: {
        providerId: busOperator.id,
        bankName: "Sample Bank",
        accountName: "Sample Mechi Hills Yatayat",
        accountNumber: "0000000000000",
        isDefault: true,
      },
    });

    // ----------------------------------------------------------------- listings
    const hotel = await tx.listing.create({
      data: {
        providerId: homestay.id,
        listingTypeCode: "hotel",
        locationId: shreeAntu.id,
        title: "Hillside Homestay, Shree Antu (sample)",
        slug: "sample-hillside-homestay-shree-antu",
        status: "APPROVED",
        basePriceMinor: 0,
        hotelDetail: {
          create: { accommodationKind: "HOMESTAY", checkInTime: "13:00", checkOutTime: "11:00" },
        },
      },
    });
    const room = await tx.listing.create({
      data: {
        providerId: homestay.id,
        listingTypeCode: "hotel_room",
        parentId: hotel.id,
        locationId: shreeAntu.id,
        title: "Double room with tea-garden view (sample)",
        slug: "sample-hillside-homestay-double-room",
        status: "APPROVED",
        basePriceMinor: 350_000, // Rs 3,500 per night
        serviceChargeRateBps: 1000, // 10% service charge
        taxRateBps: 1300, // 13% VAT
        defaultCancellationPolicyId: moderate.id,
        hotelRoomDetail: { create: { maxAdults: 2, maxChildren: 1, bedType: "double" } },
      },
    });
    const bus = await tx.listing.create({
      data: {
        providerId: busOperator.id,
        listingTypeCode: "bus_ticket",
        locationId: inaruwa.id,
        title: "Inaruwa → Shree Antu morning bus (sample)",
        slug: "sample-inaruwa-shree-antu-morning-bus",
        status: "APPROVED",
        basePriceMinor: 180_000, // Rs 1,800 per seat
        defaultCancellationPolicyId: flexible.id,
        busRouteDetail: {
          create: {
            originLocationId: inaruwa.id,
            destinationLocationId: shreeAntu.id,
            departureTime: "06:30",
            durationMinutes: 300,
            busType: "Deluxe",
            seatCapacity: 35,
            boardingPoint: "Inaruwa bus park",
          },
        },
      },
    });
    const guideService = await tx.listing.create({
      data: {
        providerId: guide.id,
        listingTypeCode: "guide_service",
        locationId: pokhara.id,
        title: "Licensed Annapurna trekking guide (sample)",
        slug: "sample-annapurna-trekking-guide",
        status: "APPROVED",
        basePriceMinor: 300_000, // Rs 3,000 per day
        defaultCancellationPolicyId: flexible.id,
        guideServiceDetail: {
          create: { languages: ["en", "ne"], regions: ["Annapurna"], maxGroupSize: 8 },
        },
      },
    });
    await tx.listing.create({
      data: {
        providerId: tourOperator.id,
        listingTypeCode: "tour",
        locationId: pokhara.id,
        title: "Annapurna Base Camp trek, 7 days (sample)",
        slug: "sample-abc-trek-7-days",
        status: "PENDING_REVIEW",
        basePriceMinor: 6_500_000,
        tourDetail: {
          create: {
            durationDays: 7,
            difficulty: "CHALLENGING",
            startLocationId: pokhara.id,
            maxAltitudeMeters: 4130,
            maxGroupSize: 12,
          },
        },
      },
    });
    // Activities use the generic `attributes` JSON instead of a detail table.
    await tx.listing.create({
      data: {
        providerId: tourOperator.id,
        listingTypeCode: "activity",
        locationId: pokhara.id,
        title: "Paragliding over Phewa Lake (sample)",
        slug: "sample-pokhara-paragliding",
        status: "DRAFT",
        basePriceMinor: 1_000_000,
        attributes: { durationMinutes: 30, minAge: 12 },
      },
    });

    // ------------------------------------------------------------- inventory
    const busSlot = await tx.inventorySlot.create({
      data: { listingId: bus.id, serviceDate: date("2026-12-20"), capacityTotal: 35 },
    });
    const roomNight1 = await tx.inventorySlot.create({
      data: { listingId: room.id, serviceDate: date("2026-12-20"), capacityTotal: 3 },
    });
    const roomNight2 = await tx.inventorySlot.create({
      data: {
        listingId: room.id,
        serviceDate: date("2026-12-21"),
        capacityTotal: 3,
        priceOverrideMinor: 420_000, // weekend price
      },
    });

    // ---------------------------------------- trip 1: Inaruwa → Shree Antu (bus + homestay)
    const busCharges = calculateItemCharges({
      lines: [{ units: 2, unitPriceMinor: bus.basePriceMinor }],
      commissionRateBps: resolveCommissionRateBps({
        listingRateBps: bus.commissionRateBps,
        providerRateBps: busOperator.commissionRateBps,
      }),
    });
    const roomCharges = calculateItemCharges({
      lines: [
        { units: 1, unitPriceMinor: roomNight1.priceOverrideMinor ?? room.basePriceMinor },
        { units: 1, unitPriceMinor: roomNight2.priceOverrideMinor ?? room.basePriceMinor },
      ],
      serviceChargeRateBps: room.serviceChargeRateBps,
      taxRateBps: room.taxRateBps,
      commissionRateBps: resolveCommissionRateBps({
        listingRateBps: room.commissionRateBps,
        providerRateBps: homestay.commissionRateBps,
      }),
    });
    const trip1Totals = summarizeTrip("NPR", [
      { ...busCharges, currency: "NPR" },
      { ...roomCharges, currency: "NPR" },
    ]);

    const trip1 = await tx.trip.create({
      data: {
        reference: "MS-SAMPLE1",
        customerId: customer.id,
        status: "CONFIRMED",
        currency: trip1Totals.currency,
        subtotalMinor: trip1Totals.subtotalMinor,
        serviceChargeMinor: trip1Totals.serviceChargeMinor,
        taxMinor: trip1Totals.taxMinor,
        totalMinor: trip1Totals.totalMinor,
        commissionTotalMinor: trip1Totals.commissionTotalMinor,
        contactName: customer.fullName,
        contactPhone: customer.phone,
        confirmedAt: new Date(),
      },
    });

    const busItem = await tx.bookingItem.create({
      data: {
        tripId: trip1.id,
        listingId: bus.id,
        providerId: busOperator.id,
        listingTypeCode: "bus_ticket",
        status: "CONFIRMED",
        startDate: date("2026-12-20"),
        travellerCount: 2,
        ...itemMoney(busCharges),
        // Becomes PAID below, once the payment is allocated (the database checks they agree).
        paymentStatus: "UNPAID",
        cancellationPolicyId: flexible.id,
        cancellationPolicySnapshot: { name: flexible.name, rules: flexible.rules ?? [] },
        attributes: { seatNumbers: ["A1", "A2"] },
        confirmedAt: new Date(),
        slots: {
          create: busCharges.lines.map((line) => ({
            inventorySlotId: busSlot.id,
            serviceDate: date("2026-12-20"),
            units: line.units,
            unitPriceMinor: line.unitPriceMinor,
            amountMinor: line.amountMinor,
          })),
        },
      },
    });
    await tx.inventorySlot.update({
      where: { id: busSlot.id },
      data: { capacityBooked: { increment: 2 } },
    });

    await tx.bookingItem.create({
      data: {
        tripId: trip1.id,
        listingId: room.id,
        providerId: homestay.id,
        listingTypeCode: "hotel_room",
        status: "CONFIRMED",
        startDate: date("2026-12-20"),
        endDate: date("2026-12-22"),
        travellerCount: 2,
        ...itemMoney(roomCharges),
        paymentStatus: "PAY_AT_PROPERTY",
        // Provider collects the money; MeroStay invoices the commission later.
        payoutStatus: "NOT_APPLICABLE",
        cancellationPolicyId: moderate.id,
        cancellationPolicySnapshot: { name: moderate.name, rules: moderate.rules ?? [] },
        confirmedAt: new Date(),
        slots: {
          create: [
            { slot: roomNight1, iso: "2026-12-20", line: roomCharges.lines[0] },
            { slot: roomNight2, iso: "2026-12-21", line: roomCharges.lines[1] },
          ].map(({ slot, iso, line }) => ({
            inventorySlotId: slot.id,
            serviceDate: date(iso),
            units: line?.units ?? 0,
            unitPriceMinor: line?.unitPriceMinor ?? 0,
            amountMinor: line?.amountMinor ?? 0,
          })),
        },
      },
    });
    await tx.inventorySlot.updateMany({
      where: { id: { in: [roomNight1.id, roomNight2.id] } },
      data: { capacityBooked: { increment: 1 } },
    });

    // The bus was prepaid with eSewa: one payment allocated to that item only.
    await recordSamplePayment(tx, {
      tripId: trip1.id,
      itemId: busItem.id,
      gateway: "esewa",
      amountMinor: busCharges.totalMinor,
      gatewayTransactionId: "SAMPLE-ESEWA-0001",
    });
    // The homestay is paid at the property, so its commission is invoiced to the provider
    // (same function the trip-confirm flow uses, ADR 0007).
    await issueCommissionInvoices(tx, trip1.id, new Date());
    await tx.notification.create({
      data: {
        userId: customer.id,
        tripId: trip1.id,
        channel: "SMS",
        provider: "sparrow_sms",
        recipient: "+9779800000009",
        template: "trip_confirmed",
        payload: { reference: trip1.reference },
      },
    });

    // ------------------------------------- trip 2: ABC guide, completed, with a review
    const guideCharges = calculateItemCharges({
      lines: [1, 2, 3, 4, 5].map(() => ({ units: 1, unitPriceMinor: guideService.basePriceMinor })),
      commissionRateBps: resolveCommissionRateBps({ providerRateBps: guide.commissionRateBps }),
    });
    const trip2Totals = summarizeTrip("NPR", [{ ...guideCharges, currency: "NPR" }]);
    const trip2 = await tx.trip.create({
      data: {
        reference: "MS-SAMPLE2",
        customerId: customer.id,
        status: "COMPLETED",
        currency: "NPR",
        subtotalMinor: trip2Totals.subtotalMinor,
        serviceChargeMinor: trip2Totals.serviceChargeMinor,
        taxMinor: trip2Totals.taxMinor,
        totalMinor: trip2Totals.totalMinor,
        commissionTotalMinor: trip2Totals.commissionTotalMinor,
      },
    });
    const guideItem = await tx.bookingItem.create({
      data: {
        tripId: trip2.id,
        listingId: guideService.id,
        providerId: guide.id,
        listingTypeCode: "guide_service",
        status: "COMPLETED",
        startDate: date("2026-10-01"),
        endDate: date("2026-10-06"),
        ...itemMoney(guideCharges),
        paymentStatus: "UNPAID", // PAID below, once the payment is allocated
        commissionStatus: "PAID",
        payoutStatus: "PAID",
        completedAt: new Date(),
        slots: {
          create: guideCharges.lines.map((line, i) => ({
            serviceDate: date(`2026-10-0${i + 1}`),
            units: line.units,
            unitPriceMinor: line.unitPriceMinor,
            amountMinor: line.amountMinor,
          })),
        },
      },
    });
    await recordSamplePayment(tx, {
      tripId: trip2.id,
      itemId: guideItem.id,
      gateway: "khalti",
      amountMinor: guideCharges.totalMinor,
      gatewayTransactionId: "SAMPLE-KHALTI-0001",
    });
    await tx.review.create({
      data: {
        bookingItemId: guideItem.id,
        authorId: customer.id,
        listingId: guideService.id,
        providerId: guide.id,
        rating: 5,
        title: "Sample review",
        body: "Sample text for a completed guide booking.",
      },
    });

    // Flights are modelled but not offered: one DRAFT listing shows the shape.
    const airline = await tx.provider.create({
      data: {
        providerTypeCode: "airline",
        ownerUserId: tourOwner.id,
        legalName: "Sample Air Agent",
        displayName: "Sample flight agent (not offered in MVP)",
      },
    });
    await tx.listing.create({
      data: {
        providerId: airline.id,
        listingTypeCode: "flight_ticket",
        title: "Kathmandu → Pokhara (sample, not bookable in MVP)",
        slug: "sample-ktm-pkr-flight",
        basePriceMinor: 450_000,
        flightRouteDetail: {
          create: {
            airlineCode: "XX",
            flightNumber: "XX101",
            originAirportCode: "KTM",
            destinationAirportCode: "PKR",
            departureTime: "07:00",
            durationMinutes: 25,
            cabinClass: "economy",
          },
        },
      },
    });

    return {
      users: await tx.user.count(),
      providers: await tx.provider.count(),
      listings: await tx.listing.count(),
      trips: await tx.trip.count(),
      bookingItems: await tx.bookingItem.count(),
    };
    // The seed runs ~60 queries one after another inside ONE transaction (all or nothing).
    // Prisma's default 5 s limit is enough on a local database but not over a hosted one
    // such as Neon (found when the tests first ran on a Neon branch), so allow more time.
  }, SEED_TRANSACTION_OPTIONS);
}
