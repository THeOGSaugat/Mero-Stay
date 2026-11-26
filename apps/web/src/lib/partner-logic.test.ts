import { describe, expect, it, vi } from "vitest";
import { ApiError, apiRequest } from "./api-client";
import type { PublicUser } from "./api-types";
import type { AuthState } from "./auth-state";
import { buildDetails, buildListingFields, detailValuesFrom } from "./listing-forms";
import { formatMoney } from "./money";
import {
  describePartnerError,
  partnerAccess,
  partnerErrorView,
  providerHeaders,
} from "./partner-access";
import {
  bpsToPercentText,
  kathmanduToday,
  partnerListingMoves,
  payoutAccountSummary,
  percentInputToBps,
  requirementChecklist,
  safeMaskedAccountNumber,
} from "./partner-display";
import type { PayoutAccount, VerificationDocument } from "./partner-types";
import {
  canSettleAtProperty,
  INITIAL_SETTLE_STATE,
  newSettleKey,
  settleOutcomeText,
  settleReducer,
  type SettleState,
} from "./settle-state";

const user = (role: PublicUser["role"]): AuthState => ({
  status: "authenticated",
  csrfToken: "csrf-1",
  user: {
    id: "u1",
    email: null,
    phone: null,
    fullName: "Ram",
    role,
    status: "ACTIVE",
    createdAt: "2026-11-23T00:00:00Z",
  },
});

describe("money in the partner area reuses the Track A formatter (strings only)", () => {
  it("formats the API's booking, invoice and payout strings exactly", () => {
    expect(formatMoney("765100", "NPR", 2)).toBe("Rs 7,651.00"); // provider share
    expect(formatMoney("105000", "NPR", 2)).toBe("Rs 1,050.00"); // commission
    expect(formatMoney("38255000", "NPR", 2)).toBe("Rs 3,82,550.00"); // Nepali grouping
    expect(formatMoney("9007199254740993", "NPR", 2)).toBe("Rs 9,00,71,99,25,47,409.93");
  });

  it("prices typed in rupees become minor-unit strings; rates become basis points", () => {
    const built = buildListingFields({
      title: "Lakeside Double",
      description: "",
      price: "3500.50",
      serviceChargePercent: "10",
      taxPercent: "13",
      addressLine: "",
      locationId: "",
      parentId: "",
    });
    expect(built.problems).toEqual([]);
    expect(built.value).toMatchObject({
      basePriceMinor: "350050",
      serviceChargeRateBps: 1000,
      taxRateBps: 1300,
      description: null,
      locationId: null,
    });
    const bad = buildListingFields({
      title: "No",
      description: "",
      price: "35.555",
      serviceChargePercent: "101",
      taxPercent: "abc",
      addressLine: "",
      locationId: "",
      parentId: "",
    });
    expect(bad.value).toBeNull();
    expect(bad.problems).toHaveLength(4);
  });

  it("percentages ⇄ basis points with string operations", () => {
    expect(percentInputToBps("13")).toBe(1300);
    expect(percentInputToBps("12.5")).toBe(1250);
    expect(percentInputToBps("0.05")).toBe(5);
    expect(percentInputToBps("")).toBe(0);
    expect(percentInputToBps("100")).toBe(10_000);
    for (const bad of ["100.01", "-1", "1e2", "12.345", "abc"]) {
      expect(percentInputToBps(bad)).toBeNull();
    }
    expect(bpsToPercentText(1500)).toBe("15%");
    expect(bpsToPercentText(1250)).toBe("12.5%");
    expect(bpsToPercentText(5)).toBe("0.05%");
    expect(bpsToPercentText(null)).toBe("—");
  });
});

describe("bank details are only ever shown masked", () => {
  const account: PayoutAccount = {
    id: "a1",
    bankName: "Nabil Bank",
    branch: null,
    accountName: "Lakeside Homestay",
    accountNumberMasked: "••••9012",
    verified: false,
    verifiedAt: null,
  };

  it("shows the API's masked value (last 4) as it is", () => {
    expect(safeMaskedAccountNumber("••••9012")).toBe("••••9012");
    expect(payoutAccountSummary(account)).toBe("Nabil Bank · ••••9012");
    expect(payoutAccountSummary(null)).toBe("No payout account yet");
  });

  it("never shows more than four characters, whatever arrives", () => {
    for (const leaked of ["0123456789012", "••••56789012", "9012", "", "•• 9012", 123456]) {
      expect(safeMaskedAccountNumber(leaked)).toBe("••••");
    }
    expect(payoutAccountSummary({ ...account, accountNumberMasked: "0123456789012" })).toBe(
      "Nabil Bank · ••••",
    );
  });
});

describe("partner route guards (navigation only; the API's 403/404 is the real check)", () => {
  it("only partner accounts enter the dashboard", () => {
    expect(partnerAccess({ status: "loading", user: null, csrfToken: null })).toBe("loading");
    expect(partnerAccess({ status: "anonymous", user: null, csrfToken: null })).toBe("login");
    expect(partnerAccess(user("CUSTOMER"))).toBe("become-partner");
    expect(partnerAccess(user("ADMIN"))).toBe("not-for-admins");
    expect(partnerAccess(user("PARTNER"))).toBe("partner");
  });

  it("another business's data (a 404) is shown as not found, never as 'access denied'", () => {
    for (const code of [
      "BOOKING_NOT_FOUND",
      "LISTING_NOT_FOUND",
      "NOT_FOUND",
      "PROVIDER_NOT_FOUND",
    ]) {
      expect(partnerErrorView(new ApiError(404, code, "x"))).toEqual({ kind: "not-found" });
    }
    expect(partnerErrorView(new ApiError(403, "FORBIDDEN", "x"))).toEqual({ kind: "forbidden" });
    expect(partnerErrorView(new ApiError(409, "PARTNER_NOT_ONBOARDED", "x"))).toEqual({
      kind: "onboard",
    });
    expect(
      partnerErrorView(
        new ApiError(400, "PROVIDER_ID_REQUIRED", "x", { providerIds: ["p1", "p2", 3] }),
      ),
    ).toEqual({ kind: "choose-provider", providerIds: ["p1", "p2"] });
  });

  it("the chosen business travels as X-Provider-Id, next to the CSRF token on writes", async () => {
    expect(providerHeaders(null)).toEqual({});
    expect(providerHeaders("p1")).toEqual({ "X-Provider-Id": "p1" });
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(JSON.stringify({ data: {} }), { status: 200 })),
    );
    await apiRequest("/partner/profile", {
      method: "PATCH",
      body: { displayName: "X" },
      csrfToken: "csrf-1",
      headers: { ...providerHeaders("p1"), "X-CSRF-Token": "forged" },
      fetchImpl,
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("/api/v1/partner/profile");
    expect(init?.credentials).toBe("include");
    expect(init?.headers).toMatchObject({ "X-Provider-Id": "p1", "X-CSRF-Token": "csrf-1" });
  });

  it("listing status buttons match what the API allows (no self-approval)", () => {
    expect(partnerListingMoves("DRAFT").map((m) => m.to)).toEqual(["PENDING_REVIEW", "ARCHIVED"]);
    expect(partnerListingMoves("APPROVED").map((m) => m.to)).toEqual(["ARCHIVED"]);
    expect(partnerListingMoves("SUSPENDED")).toEqual([]);
    for (const status of ["DRAFT", "REJECTED", "PENDING_REVIEW", "ARCHIVED"]) {
      expect(partnerListingMoves(status).map((m) => m.to)).not.toContain("APPROVED");
    }
  });
});

describe("settle at the property: idempotent in the UI state", () => {
  const keys = (() => {
    let n = 0;
    return () => `key-${++n}`;
  })();

  it("a retry after a failure re-sends the SAME key; success is shown once", () => {
    let state: SettleState = settleReducer(INITIAL_SETTLE_STATE, { type: "start", newKey: keys });
    expect(state).toEqual({ phase: "sending", key: "key-1" });
    // A second click while in flight sends nothing new.
    expect(settleReducer(state, { type: "start", newKey: keys })).toBe(state);

    state = settleReducer(state, { type: "failed", message: "Could not reach MeroStay." });
    expect(state).toEqual({ phase: "failed", key: "key-1", message: "Could not reach MeroStay." });

    state = settleReducer(state, { type: "start", newKey: keys });
    expect(state).toEqual({ phase: "sending", key: "key-1" }); // same key: applied once by the API

    state = settleReducer(state, { type: "succeeded", replayed: true });
    expect(state).toEqual({ phase: "done", key: null, replayed: true });
    expect(settleOutcomeText(state)).toMatch(/recorded once/);
    // Done is final: no further sends from this view.
    expect(settleReducer(state, { type: "start", newKey: keys })).toBe(state);
    expect(settleReducer(state, { type: "failed", message: "late" })).toBe(state);
  });

  it("a first-time success reads as a plain success", () => {
    const sending = settleReducer(INITIAL_SETTLE_STATE, { type: "start", newKey: () => "k" });
    const done = settleReducer(sending, { type: "succeeded", replayed: false });
    expect(settleOutcomeText(done)).toBe("Payment received at the property is recorded.");
    expect(settleOutcomeText(INITIAL_SETTLE_STATE)).toBeNull();
  });

  it("keys fit the API's Idempotency-Key format", () => {
    const key = newSettleKey("3f1c2b4a-0000-4000-8000-000000000000", () => "abc-123");
    expect(key).toBe("settle-3f1c2b4a-abc-123");
    expect(newSettleKey("x".repeat(36))).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
  });

  it("the action is offered only for confirmed pay-at-property bookings", () => {
    expect(canSettleAtProperty({ status: "CONFIRMED", paymentStatus: "PAY_AT_PROPERTY" })).toBe(
      true,
    );
    expect(canSettleAtProperty({ status: "CONFIRMED", paymentStatus: "PAID_AT_PROPERTY" })).toBe(
      false,
    );
    expect(canSettleAtProperty({ status: "PENDING", paymentStatus: "PAY_AT_PROPERTY" })).toBe(
      false,
    );
    expect(canSettleAtProperty({ status: "CONFIRMED", paymentStatus: "PAID" })).toBe(false);
  });
});

describe("verification checklist (ADR 0009 groups)", () => {
  const doc = (
    documentType: string,
    status: VerificationDocument["status"],
  ): VerificationDocument => ({
    id: `${documentType}-${status}`,
    documentType,
    status,
    fileName: "doc.pdf",
    mimeType: "application/pdf",
    sizeBytes: 1000,
    hasFile: true,
    uploadedAt: "2026-11-23T00:00:00Z",
    documentNumber: null,
    expiresOn: null,
    reviewedAt: null,
    rejectionReason: null,
    createdAt: "2026-11-23T00:00:00Z",
  });
  const hotel = [
    { requirement: "identity", acceptedDocumentTypes: ["OWNER_ID"] },
    {
      requirement: "registration",
      acceptedDocumentTypes: ["BUSINESS_REGISTRATION", "LOCAL_GOVERNMENT_REGISTRATION"],
    },
  ];

  it("any accepted type satisfies a group; rejected documents never count", () => {
    const rows = requirementChecklist(hotel, [
      doc("OWNER_ID", "REJECTED"),
      doc("LOCAL_GOVERNMENT_REGISTRATION", "PENDING"),
    ]);
    expect(rows.map((r) => [r.requirement, r.state])).toEqual([
      ["identity", "missing"],
      ["registration", "pending"],
    ]);
    const approved = requirementChecklist(hotel, [
      doc("OWNER_ID", "PENDING"),
      doc("OWNER_ID", "APPROVED"),
    ]);
    expect(approved[0]?.state).toBe("approved");
    expect(approved[0]?.satisfiedBy?.status).toBe("APPROVED");
  });

  it("the API's missing groups become a readable message", () => {
    const err = new ApiError(409, "REQUIRED_DOCUMENTS_MISSING", "x", {
      missing: [{ requirement: "registration" }, { requirement: "tax" }],
    });
    expect(describePartnerError(err)).toBe(
      "Add a document for: Business registration and Tax registration. Then submit again.",
    );
  });
});

describe("listing forms follow the listing type's detail fields", () => {
  it("builds typed details; required fields are checked; types without a table send none", () => {
    expect(
      buildDetails("hotel_room", { maxAdults: "2", bedType: "double", sizeSqm: "" }, "create"),
    ).toEqual({ value: { maxAdults: 2, bedType: "double" }, problems: [] });
    expect(buildDetails("hotel_room", { maxAdults: "" }, "create").problems).toEqual([
      "Adults (max) is required.",
    ]);
    expect(buildDetails("hotel_room", { maxAdults: "2", sizeSqm: "" }, "edit").value).toEqual({
      maxAdults: 2,
      bedType: null,
      sizeSqm: null,
    });
    expect(
      buildDetails("guide_service", { languages: "en, ne,", maxGroupSize: "8" }, "create").value,
    ).toEqual({
      languages: ["en", "ne"],
      maxGroupSize: 8,
    });
    expect(buildDetails("activity", {}, "create")).toEqual({ value: undefined, problems: [] });
    expect(
      buildDetails(
        "hotel",
        { accommodationKind: "CASTLE", checkInTime: "1pm", checkOutTime: "11:00" },
        "create",
      ).problems,
    ).toEqual(["Choose a kind of stay.", "Check-in from must be HH:MM."]);
  });

  it("edit forms are pre-filled from the API's details", () => {
    expect(
      detailValuesFrom({ languages: ["en", "ne"], maxGroupSize: 8, licenseNumber: null }),
    ).toEqual({
      languages: "en, ne",
      maxGroupSize: "8",
      licenseNumber: "",
    });
  });
});

describe("inventory and errors", () => {
  it("overbooking and slot conflicts are explained, with the dates the API names", () => {
    expect(
      describePartnerError(
        new ApiError(409, "CAPACITY_BELOW_BOOKED", "x", {
          dates: [{ date: "2027-01-10", booked: 2 }],
        }),
      ),
    ).toBe(
      "Capacity can't go below what is already booked (2027-01-10: 2 booked). Nothing was changed.",
    );
    expect(
      describePartnerError(
        new ApiError(409, "SLOT_EXISTS", "x", { dates: ["2027-01-10", "2027-01-11"] }),
      ),
    ).toContain("(2027-01-10 and 2027-01-11)");
    expect(describePartnerError(new ApiError(409, "INSUFFICIENT_AVAILABILITY", "x"))).toMatch(
      /overbook/,
    );
  });

  it("today is a Nepal calendar date (UTC+05:45)", () => {
    expect(kathmanduToday(new Date("2026-11-22T18:14:00Z"))).toBe("2026-11-22");
    expect(kathmanduToday(new Date("2026-11-22T18:15:00Z"))).toBe("2026-11-23");
  });
});
