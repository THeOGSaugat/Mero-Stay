import { describe, expect, it } from "vitest";
import type { ListingType } from "./api-types";
import {
  CATEGORIES,
  categoryById,
  categoryHref,
  categoryOfType,
  DESTINATIONS,
  illustrationFor,
  placeName,
  resolveCategories,
  searchTitle,
} from "./categories";
import { formatMoney } from "./money";
import { stepStates, tripStep, TRIP_STEPS } from "./trip-steps";

// The listing types as GET /listing-types returns them (ordered by code), flights inactive.
const t = (code: string, name: string, unitLabel: string, isBookable = true, isActive = true) =>
  ({ code, name, unitLabel, isBookable, isActive }) satisfies ListingType;
const TYPES: ListingType[] = [
  t("activity", "Activity", "person"),
  t("bus_ticket", "Bus ticket", "seat"),
  t("flight_ticket", "Flight ticket", "seat", true, false),
  t("guide_service", "Guide service", "day"),
  t("hotel", "Hotel / property", "property", false),
  t("hotel_room", "Hotel room", "night"),
  t("tour", "Tour / trek", "person"),
];

describe("Phase 13 design system: categories, titles, steps", () => {
  it("groups offered types into Stays, Buses, Guides and Experiences: never flights", () => {
    expect(CATEGORIES.map((c) => c.label)).toEqual(["Stays", "Buses", "Guides", "Experiences"]);
    const resolved = resolveCategories(TYPES);
    expect(resolved.map((c) => [c.id, c.types.map((x) => x.code)])).toEqual([
      ["stays", ["hotel_room"]],
      ["buses", ["bus_ticket"]], // the inactive flight type (also per seat) is not offered
      ["guides", ["guide_service"]],
      ["experiences", ["activity", "tour"]],
    ]);
    // A category with no offered type is left out entirely.
    expect(resolveCategories(TYPES.filter((x) => x.unitLabel !== "day")).map((c) => c.id)).toEqual([
      "stays",
      "buses",
      "experiences",
    ]);
    expect(categoryOfType({ unitLabel: "seat" })?.label).toBe("Buses");
    expect(categoryOfType({ unitLabel: "property" })).toBeUndefined();
    expect(categoryById("guides")?.label).toBe("Guides");
    expect(categoryById("flights")).toBeUndefined();
    expect(categoryHref("stays")).toBe("/search?category=stays");
  });

  it("titles the search page from the filters only", () => {
    expect(searchTitle({ unitLabel: "night" }, "pokhara")).toBe("Stays in Pokhara");
    expect(searchTitle({ unitLabel: "seat" }, undefined)).toBe("Buses");
    expect(searchTitle(undefined, "kaski")).toBe("Explore Kaski");
    expect(searchTitle(undefined, undefined)).toBe("Explore Nepal");
    expect(placeName("shree-antu")).toBe("Shree Antu");
    expect(placeName(undefined)).toBe("");
  });

  it("marks every listing image as illustrative and has one for every type", () => {
    for (const type of TYPES) {
      const { image, imageAlt } = illustrationFor(type);
      expect(image).toMatch(/^\/images\/[a-z-]+\.jpg$/);
      expect(imageAlt).toMatch(/^Illustrative photo: /);
    }
    for (const d of DESTINATIONS) expect(d.image).toMatch(/^\/images\/destination-[a-z]+\.jpg$/);
  });

  it("shows the trip's step from its state (presentation only)", () => {
    expect(TRIP_STEPS).toHaveLength(4);
    expect(tripStep({ status: "DRAFT" })).toBe(0);
    expect(tripStep({ status: "DRAFT", hasQuote: true })).toBe(1);
    expect(tripStep({ status: "PENDING", dueOnline: false })).toBe(2);
    expect(tripStep({ status: "PENDING", dueOnline: true })).toBe(3);
    expect(tripStep({ status: "CONFIRMED" })).toBe(3);
    expect(stepStates(1)).toEqual(["done", "current", "upcoming", "upcoming"]);
    expect(stepStates(3, true)).toEqual(["done", "done", "done", "done"]);
  });

  it("renders NPR as 'Rs.' through the one formatter (no other formatting in the UI)", () => {
    expect(formatMoney("750000", "NPR", 2)).toBe("Rs. 7,500.00");
    expect(formatMoney("123456700", "NPR", 2)).toBe("Rs. 12,34,567.00");
    expect(formatMoney("12345", "USD", 2)).toBe("USD 123.45");
  });
});
