import { describe, expect, it } from "vitest";
import { missingRequirements, requirementGroups } from "./verification.js";

// Rows as seeded for the `hotel` provider type (hotels and homestays share it).
const hotel = [
  { requirement: "identity", documentType: "OWNER_ID" },
  { requirement: "registration", documentType: "BUSINESS_REGISTRATION" },
  { requirement: "registration", documentType: "LOCAL_GOVERNMENT_REGISTRATION" },
];

describe("required verification documents", () => {
  it("groups rows: any one type in a group satisfies it", () => {
    expect(requirementGroups(hotel)).toEqual([
      { requirement: "identity", acceptedDocumentTypes: ["OWNER_ID"] },
      {
        requirement: "registration",
        acceptedDocumentTypes: ["BUSINESS_REGISTRATION", "LOCAL_GOVERNMENT_REGISTRATION"],
      },
    ]);
  });

  it("an owner ID alone is incomplete for a hotel", () => {
    expect(missingRequirements(hotel, [{ documentType: "OWNER_ID", status: "PENDING" }])).toEqual([
      {
        requirement: "registration",
        acceptedDocumentTypes: ["BUSINESS_REGISTRATION", "LOCAL_GOVERNMENT_REGISTRATION"],
      },
    ]);
  });

  it("a homestay registration satisfies the registration group as well as a business one", () => {
    for (const registration of ["BUSINESS_REGISTRATION", "LOCAL_GOVERNMENT_REGISTRATION"]) {
      expect(
        missingRequirements(hotel, [
          { documentType: "OWNER_ID", status: "APPROVED" },
          { documentType: registration, status: "PENDING" },
        ]),
      ).toEqual([]);
    }
  });

  it("a document counts only once its file is uploaded and confirmed (ADR 0016)", () => {
    for (const status of ["AWAITING_UPLOAD", "UPLOADED"] as const) {
      expect(
        missingRequirements(hotel, [
          { documentType: "OWNER_ID", status },
          { documentType: "BUSINESS_REGISTRATION", status: "PENDING" },
        ]).map((g) => g.requirement),
      ).toEqual(["identity"]);
    }
  });

  it("a rejected document never counts", () => {
    expect(
      missingRequirements(hotel, [
        { documentType: "OWNER_ID", status: "REJECTED" },
        { documentType: "BUSINESS_REGISTRATION", status: "PENDING" },
      ]).map((g) => g.requirement),
    ).toEqual(["identity"]);
  });

  it("a type with no requirements is always complete; extra documents are fine", () => {
    expect(missingRequirements([], [])).toEqual([]);
    expect(
      missingRequirements(hotel, [
        { documentType: "OWNER_ID", status: "PENDING" },
        { documentType: "BUSINESS_REGISTRATION", status: "PENDING" },
        { documentType: "OTHER", status: "PENDING" },
      ]),
    ).toEqual([]);
  });
});
