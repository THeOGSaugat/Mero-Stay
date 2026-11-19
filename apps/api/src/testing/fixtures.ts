import { randomInt, randomUUID } from "node:crypto";
import type { PrismaClient } from "../generated/prisma/client.js";
import { addDays, toDbDate, todayInKathmandu } from "../domain/dates.js";

/**
 * A self-contained marketplace for API integration tests. Every name/slug carries a unique suffix,
 * so several worlds (and the Phase 2 seed) can live in one test database; search tests scope
 * results to `world.locations.province.slug`.
 *
 * Dates are relative to today (Nepal time) + 30 days, so the tests never age into the past.
 */
export async function createWorld(prisma: PrismaClient) {
  const s = randomUUID().slice(0, 8);
  const d0 = addDays(todayInKathmandu(), 30);
  const day = (n: number) => addDays(d0, n);

  const province = await prisma.location.create({
    data: { kind: "PROVINCE", name: `Test Province ${s}`, slug: `test-province-${s}` },
  });
  const town = await prisma.location.create({
    data: {
      kind: "MUNICIPALITY",
      name: `Test Town ${s}`,
      slug: `test-town-${s}`,
      parentId: province.id,
    },
  });
  const village = await prisma.location.create({
    data: { kind: "AREA", name: `Test Village ${s}`, slug: `test-village-${s}`, parentId: town.id },
  });

  const owner = await prisma.user.create({
    data: { email: `owner-${s}@test.local`, fullName: "Test Owner", role: "PARTNER" },
  });
  const customer = await prisma.user.create({
    data: {
      email: `traveller-${s}@test.local`,
      phone: `+97798${randomInt(10_000_000, 99_999_999)}`, // unique per world
      fullName: "Test Traveller",
    },
  });

  const provider = (
    providerTypeCode: string,
    status: "VERIFIED" | "PENDING_VERIFICATION" = "VERIFIED",
  ) =>
    prisma.provider.create({
      data: {
        providerTypeCode,
        ownerUserId: owner.id,
        legalName: `${providerTypeCode} ${s}`,
        displayName: `${providerTypeCode} ${s}`,
        status,
      },
    });
  const hotelProvider = await provider("hotel");
  const busProvider = await provider("bus_operator");
  const guideProvider = await provider("guide");
  const unverifiedProvider = await provider("hotel", "PENDING_VERIFICATION");
  const airline = await provider("airline");

  const policy = await prisma.cancellationPolicy.create({
    data: {
      providerId: hotelProvider.id,
      name: `Moderate ${s}`,
      description: "Full refund up to 72 hours before; 50% up to 24 hours before.",
      rules: [
        { minHoursBeforeStart: 72, refundBps: 10000 },
        { minHoursBeforeStart: 24, refundBps: 5000 },
      ],
    },
  });

  const listing = (data: {
    providerId: string;
    listingTypeCode: string;
    title: string;
    basePriceMinor: bigint;
    locationId?: string;
    parentId?: string;
    status?: "APPROVED" | "DRAFT";
    currency?: string;
    serviceChargeRateBps?: number;
    taxRateBps?: number;
    defaultCancellationPolicyId?: string;
  }) =>
    prisma.listing.create({
      data: {
        status: "APPROVED",
        locationId: town.id,
        ...data,
        slug: `${data.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${s}`,
      },
    });

  const hotel = await listing({
    providerId: hotelProvider.id,
    listingTypeCode: "hotel",
    title: "Test Hotel",
    basePriceMinor: 0n,
  });
  await prisma.hotelDetail.create({
    data: {
      listingId: hotel.id,
      accommodationKind: "HOMESTAY",
      checkInTime: "13:00",
      checkOutTime: "11:00",
    },
  });
  const room = await listing({
    providerId: hotelProvider.id,
    listingTypeCode: "hotel_room",
    title: "Test Double Room",
    basePriceMinor: 350_000n, // Rs 3,500 / night
    parentId: hotel.id,
    locationId: village.id, // inside town, inside province
    serviceChargeRateBps: 1000,
    taxRateBps: 1300,
    defaultCancellationPolicyId: policy.id,
  });
  await prisma.hotelRoomDetail.create({
    data: { listingId: room.id, maxAdults: 2, bedType: "double" },
  });

  const bus = await listing({
    providerId: busProvider.id,
    listingTypeCode: "bus_ticket",
    title: "Test Morning Bus",
    basePriceMinor: 180_000n,
  });
  await prisma.busRouteDetail.create({
    data: {
      listingId: bus.id,
      originLocationId: town.id,
      destinationLocationId: village.id,
      departureTime: "06:30",
      durationMinutes: 300,
      busType: "Deluxe",
      seatCapacity: 35,
    },
  });

  const guide = await listing({
    providerId: guideProvider.id,
    listingTypeCode: "guide_service",
    title: "Test Guide",
    basePriceMinor: 300_000n,
  });
  await prisma.guideServiceDetail.create({
    data: { listingId: guide.id, languages: ["en", "ne"], regions: ["Test"], maxGroupSize: 8 },
  });

  // Not visible / not bookable for different reasons:
  const draftRoom = await listing({
    providerId: hotelProvider.id,
    listingTypeCode: "hotel_room",
    title: "Test Draft Room",
    basePriceMinor: 100_000n,
    status: "DRAFT",
  });
  const unverifiedRoom = await listing({
    providerId: unverifiedProvider.id,
    listingTypeCode: "hotel_room",
    title: "Test Unverified Room",
    basePriceMinor: 100_000n,
  });
  const flight = await listing({
    providerId: airline.id,
    listingTypeCode: "flight_ticket",
    title: "Test Flight",
    basePriceMinor: 450_000n,
  });
  const usdRoom = await listing({
    providerId: hotelProvider.id,
    listingTypeCode: "hotel_room",
    title: "Test USD Room",
    basePriceMinor: 5_000n,
    currency: "USD",
  });

  const slot = (listingId: string, n: number, capacityTotal: number, priceOverrideMinor?: bigint) =>
    prisma.inventorySlot.create({
      data: {
        listingId,
        serviceDate: toDbDate(day(n)),
        capacityTotal,
        priceOverrideMinor: priceOverrideMinor ?? null,
      },
    });
  for (let n = 0; n < 5; n++) await slot(room.id, n, 3, n === 1 ? 420_000n : undefined); // day 1 = festival price
  await slot(bus.id, 0, 2); // only 2 seats on day 0: overbooking tests
  await slot(bus.id, 1, 35);
  for (let n = 0; n < 6; n++) await slot(guide.id, n, 1);
  for (const id of [draftRoom.id, unverifiedRoom.id, flight.id, usdRoom.id]) await slot(id, 0, 5);
  await prisma.inventorySlot.update({
    where: { listingId_serviceDate: { listingId: room.id, serviceDate: toDbDate(day(4)) } },
    data: { status: "CLOSED" },
  });

  return {
    suffix: s,
    day,
    locations: { province, town, village },
    users: { owner, customer },
    providers: { hotelProvider, busProvider, guideProvider, unverifiedProvider, airline },
    policy,
    listings: { hotel, room, bus, guide, draftRoom, unverifiedRoom, flight, usdRoom },
  };
}

export type World = Awaited<ReturnType<typeof createWorld>>;
