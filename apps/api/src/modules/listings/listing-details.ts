import { z } from "zod";
import { uuidSchema } from "../../lib/validation.js";

/**
 * Type-specific listing fields for partner writes (ADR 0004 / 0008).
 *
 * The endpoints are vertical-agnostic: a listing type is DATA (`listing_types`). A type whose
 * fields search must query has a detail table, validated here; every other type (e.g. `activity`,
 * or a new vertical with no table) uses the generic `attributes` JSON and needs no entry here.
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
