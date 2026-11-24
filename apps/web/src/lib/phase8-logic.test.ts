import { describe, expect, it } from "vitest";
import { listHref, PROVIDER_LIST_KEYS, readListQuery } from "./admin-lists";
import { ApiError } from "./api-client";
import { auditActorLabel } from "./audit-display";
import { listingTypeChoices, parentTypeCodes } from "./listing-forms";
import { describePartnerError } from "./partner-access";
import type { AllowedListingType } from "./partner-types";

const room: AllowedListingType = {
  code: "hotel_room",
  name: "Hotel room",
  unitLabel: "night",
  isBookable: true,
};
const property: AllowedListingType = {
  code: "hotel",
  name: "Hotel / property",
  unitLabel: "property",
  isBookable: false,
};

describe("gap 22: partner listing-type choices come from the API", () => {
  it("offers exactly the allowed, active types the profile carries", () => {
    const profile = {
      providerType: { code: "x", name: "X", allowedListingTypes: [property, room] },
    };
    expect(listingTypeChoices(profile).map((t) => t.code)).toEqual(["hotel", "hotel_room"]);
    expect(parentTypeCodes(listingTypeChoices(profile))).toEqual(["hotel"]);
  });

  it("an inactive kind of business gets no choices (the form says so)", () => {
    expect(
      listingTypeChoices({ providerType: { code: "y", name: "Y", allowedListingTypes: [] } }),
    ).toEqual([]);
  });

  it("the API's refusal names what the business may list", () => {
    const err = new ApiError(422, "LISTING_TYPE_NOT_ALLOWED", "x", {
      allowedListingTypes: ["bus_ticket"],
      reason: "not_mapped",
    });
    expect(describePartnerError(err)).toBe(
      "Your kind of business can't list this type. You can list: Bus ticket.",
    );
    expect(
      describePartnerError(
        new ApiError(422, "LISTING_TYPE_NOT_ALLOWED", "x", { allowedListingTypes: [] }),
      ),
    ).toBe("Your kind of business can't create listings yet. Contact MeroStay.");
  });
});

describe("gap 25: admin list filters, URLs and paging", () => {
  it("URL filters become the API query; empty values are dropped; page and size are bounded", () => {
    const search = new URLSearchParams("q=%20Fewa%20&status=&sort=name&page=3");
    expect(readListQuery(search, PROVIDER_LIST_KEYS)).toEqual({
      values: { q: "Fewa", status: "", providerType: "", sort: "name" },
      page: 3,
      apiQuery: "q=Fewa&sort=name&page=3&pageSize=20",
    });
    expect(readListQuery(new URLSearchParams("page=-2"), PROVIDER_LIST_KEYS).page).toBe(1);
    expect(readListQuery(new URLSearchParams("page=abc"), PROVIDER_LIST_KEYS).page).toBe(1);
    expect(readListQuery(new URLSearchParams("page=99999"), PROVIDER_LIST_KEYS).page).toBe(10_000);
  });

  it("page links keep the filters; page 1 stays implicit", () => {
    const values = { q: "Fewa", status: "", providerType: "hotel", sort: "newest" };
    expect(listHref("/admin/providers", values, 1)).toBe(
      "/admin/providers?q=Fewa&providerType=hotel&sort=newest",
    );
    expect(listHref("/admin/providers", values, 6)).toBe(
      "/admin/providers?q=Fewa&providerType=hotel&sort=newest&page=6",
    );
    expect(listHref("/admin/invoices", {}, 1)).toBe("/admin/invoices");
  });

  it("audit actors show a name, never an id alone; no user = MeroStay system", () => {
    expect(auditActorLabel({ userId: "u1", role: "ADMIN", name: "Anita Admin" })).toBe(
      "Anita Admin (admin)",
    );
    expect(auditActorLabel({ userId: "u1", role: null, name: "  " })).toBe("Unknown user (user)");
    expect(auditActorLabel(null)).toBe("MeroStay system");
  });
});
