import { describe, expect, it } from "vitest";
import type { ListingType } from "./api-types";
import {
  addIsoDays,
  calendarWindow,
  filtersFromSearchParams,
  searchPageHref,
  selectableListingTypes,
  toApiQuery,
  usesDateRange,
} from "./search";

const types: ListingType[] = [
  { code: "bus_ticket", name: "Bus ticket", unitLabel: "seat", isBookable: true, isActive: true },
  {
    code: "flight_ticket",
    name: "Flight ticket",
    unitLabel: "seat",
    isBookable: true,
    isActive: false,
  },
  {
    code: "hotel",
    name: "Hotel / property",
    unitLabel: "property",
    isBookable: false,
    isActive: true,
  },
  { code: "hotel_room", name: "Hotel room", unitLabel: "night", isBookable: true, isActive: true },
];

describe("search filters", () => {
  it("offers only active, bookable listing types (no flights, no hotel containers)", () => {
    expect(selectableListingTypes(types).map((t) => t.code)).toEqual(["bus_ticket", "hotel_room"]);
  });

  it("reads the page's search params (first value wins, blanks ignored)", () => {
    expect(
      filtersFromSearchParams({
        type: ["hotel_room", "bus_ticket"],
        location: " pokhara ",
        startDate: "",
        extra: "x",
      }),
    ).toEqual({ type: "hotel_room", location: "pokhara" });
  });

  it("builds the API query: prices in minor units as strings", () => {
    const { query, problems } = toApiQuery({
      type: "hotel_room",
      location: "Shree Antu",
      startDate: "2027-01-10",
      endDate: "2027-01-12",
      quantity: "2",
      minPrice: "1,500",
      maxPrice: "4500.50",
      currency: "NPR",
      sort: "price_asc",
      page: "2",
    });
    expect(problems).toEqual([]);
    expect(Object.fromEntries(query)).toEqual({
      type: "hotel_room",
      location: "shree-antu",
      startDate: "2027-01-10",
      endDate: "2027-01-12",
      quantity: "2",
      minPrice: "150000",
      maxPrice: "450050",
      currency: "NPR",
      sort: "price_asc",
      page: "2",
    });
  });

  it("drops and reports invalid filters instead of sending them", () => {
    const { query, problems } = toApiQuery({
      startDate: "2027-01-12",
      endDate: "2027-01-10",
      quantity: "0",
      minPrice: "-5",
      currency: "rupees",
      sort: "cheapest",
    });
    expect(Object.fromEntries(query)).toEqual({ startDate: "2027-01-12" });
    expect(problems).toHaveLength(5);
  });

  it("keeps filters across pages", () => {
    expect(searchPageHref({ type: "bus_ticket", page: "3" }, 2)).toBe(
      "/search?type=bus_ticket&page=2",
    );
    expect(searchPageHref({ type: "bus_ticket" }, 1)).toBe("/search?type=bus_ticket");
    expect(searchPageHref({}, 1)).toBe("/search");
  });

  it("date ranges for nights and days, a single date for seats and persons", () => {
    expect(usesDateRange("night")).toBe(true);
    expect(usesDateRange("day")).toBe(true);
    expect(usesDateRange("seat")).toBe(false);
    expect(usesDateRange("person")).toBe(false);
  });
});

describe("listing calendar window", () => {
  it("adds calendar days across month and year ends", () => {
    expect(addIsoDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addIsoDays("2028-02-28", 1)).toBe("2028-02-29");
  });

  it("a single date shows that day; a range shows its nights; invalid or too long → API default", () => {
    expect(calendarWindow("2027-01-10", undefined)).toEqual({
      from: "2027-01-10",
      to: "2027-01-11",
    });
    expect(calendarWindow("2027-01-10", "2027-01-12")).toEqual({
      from: "2027-01-10",
      to: "2027-01-12",
    });
    expect(calendarWindow("2027-01-10", "2027-01-10")).toEqual({
      from: "2027-01-10",
      to: "2027-01-11",
    });
    expect(calendarWindow("2027-01-10", "2027-06-01")).toBeNull();
    expect(calendarWindow(undefined, "2027-01-12")).toBeNull();
    expect(calendarWindow("10/01/2027", undefined)).toBeNull();
  });
});
