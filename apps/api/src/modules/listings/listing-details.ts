import { z } from "zod";
import { uuidSchema } from "../../lib/validation.js";

/**
 * Type-specific listing fields for partner writes (ADR 0004 / 0008).
 *
 * The endpoints are vertical-agnostic: a listing type is DATA (`listing_types`). A type whose
 * fields search or a rule must read has a detail table, validated here (since Phase 14 `activity`
 * too, for its start time); every other type uses the generic `attributes` JSON and needs no entry.
 * Adding a vertical = a `listing_types` row (+ optionally a detail table and an entry below).
 */

const time = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, { error: "must be HH:MM (24h)" });

export const DETAIL_SCHEMAS = {
  hotel: {
    relation: "hotelDetail",
    schema: z
      .object({
        accommodationKind: z.enum([
          "HOTEL",
          "GUESTHOUSE",
          "HOMESTAY",
          "RESORT",
          "TEAHOUSE",
          "LODGE",
        ]),
        starRating: z.number().int().min(1).max(5).nullable().optional(),
        checkInTime: time,
        checkOutTime: time,
      })
      .strict(),
  },
  hotel_room: {
    relation: "hotelRoomDetail",
    schema: z
      .object({
        maxAdults: z.number().int().min(1).max(50),
        maxChildren: z.number().int().min(0).max(50).default(0),
        bedType: z.string().trim().min(1).max(60).nullable().optional(),
        bedCount: z.number().int().min(1).max(50).default(1),
        sizeSqm: z.number().int().min(1).max(10_000).nullable().optional(),
      })
      .strict(),
  },
  bus_ticket: {
    relation: "busRouteDetail",
    schema: z
      .object({
        originLocationId: uuidSchema,
        destinationLocationId: uuidSchema,
        departureTime: time,
        durationMinutes: z.number().int().min(1).max(10_000),
        busType: z.string().trim().min(1).max(60),
        seatCapacity: z.number().int().min(1).max(200),
        boardingPoint: z.string().trim().min(1).max(200).nullable().optional(),
      })
      .strict()
      .refine((d) => d.originLocationId !== d.destinationLocationId, {
        error: "origin and destination must differ",
        path: ["destinationLocationId"],
      }),
  },
  guide_service: {
    relation: "guideServiceDetail",
    schema: z
      .object({
        languages: z.array(z.string().trim().min(2).max(20)).min(1).max(20),
        regions: z.array(z.string().trim().min(1).max(80)).max(50).default([]),
        licenseNumber: z.string().trim().min(1).max(60).nullable().optional(),
        maxGroupSize: z.number().int().min(1).max(100),
        /** When each guide day starts (Nepal time): the refund clock counts from it (ADR 0020). */
        startTime: time,
      })
      .strict(),
  },
  tour: {
    relation: "tourDetail",
    schema: z
      .object({
        durationDays: z.number().int().min(1).max(60),
        difficulty: z.enum(["EASY", "MODERATE", "CHALLENGING", "STRENUOUS"]),
        startLocationId: uuidSchema.nullable().optional(),
        maxAltitudeMeters: z.number().int().min(1).max(9000).nullable().optional(),
        maxGroupSize: z.number().int().min(1).max(200),
        /** When the tour starts on its departure date (Nepal time; ADR 0020). */
        startTime: time,
      })
      .strict(),
  },
  activity: {
    relation: "activityDetail",
    schema: z
      .object({
        /** When the activity starts (Nepal time; ADR 0020). Other fields stay in attributes. */
        startTime: time,
      })
      .strict(),
  },
} as const;

export type DetailRelation = (typeof DETAIL_SCHEMAS)[keyof typeof DETAIL_SCHEMAS]["relation"];

/** Location ids a detail record points to (checked to exist before writing). */
export function detailLocationIds(details: Record<string, unknown>): string[] {
  return ["originLocationId", "destinationLocationId", "startLocationId"]
    .map((key) => details[key])
    .filter((v): v is string => typeof v === "string");
}

export function detailSpecFor(listingTypeCode: string) {
  return (DETAIL_SCHEMAS as Record<string, (typeof DETAIL_SCHEMAS)[keyof typeof DETAIL_SCHEMAS]>)[
    listingTypeCode
  ];
}

/**
 * The time of day a listing's service starts (Nepal time, "HH:MM"), for the refund clock
 * (ADR 0020): a stay's check-in (a room uses its parent's), a bus's departure, a guide day's, tour's
 * or activity's start. A listing has at most one detail row, so the first one present answers;
 * null = no start time recorded (older guide/tour listings), and the booking falls back to midnight.
 */
export interface StartTimeDetails {
  hotelDetail?: { checkInTime: string } | null;
  busRouteDetail?: { departureTime: string } | null;
  guideServiceDetail?: { startTime: string | null } | null;
  tourDetail?: { startTime: string | null } | null;
  activityDetail?: { startTime: string } | null;
  parent?: { hotelDetail?: { checkInTime: string } | null } | null;
}

export function listingStartTime(listing: StartTimeDetails): string | null {
  return (
    listing.hotelDetail?.checkInTime ??
    listing.parent?.hotelDetail?.checkInTime ??
    listing.busRouteDetail?.departureTime ??
    listing.guideServiceDetail?.startTime ??
    listing.tourDetail?.startTime ??
    listing.activityDetail?.startTime ??
    null
  );
}

/** The select that brings every start-time field `listingStartTime` reads. */
export const START_TIME_SELECT = {
  hotelDetail: { select: { checkInTime: true } },
  busRouteDetail: { select: { departureTime: true } },
  guideServiceDetail: { select: { startTime: true } },
  tourDetail: { select: { startTime: true } },
  activityDetail: { select: { startTime: true } },
  parent: { select: { hotelDetail: { select: { checkInTime: true } } } },
} as const;
