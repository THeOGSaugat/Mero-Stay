import { describe, expect, it } from "vitest";
import { ApiError } from "./api-client";
import { describeAdminError } from "./admin-access";
import {
  adminAccountLabel,
  gatewayName,
  isMonth,
  payoutActions,
  payoutBatchStatusLabel,
  payoutBatchTone,
  previousMonth,
  reconciliationReasonLabel,
  refundStatusLabel,
  setupTokenFromHash,
  setupUrl,
  typeRuleText,
} from "./admin-ops";

describe("Phase 12 admin operations (ADR 0018)", () => {
  it("payout batches: labels, tones and the next actions per status", () => {
    expect(payoutBatchStatusLabel("PENDING")).toBe("Ready to schedule");
    expect(payoutBatchStatusLabel("SCHEDULED")).toBe("Scheduled for transfer");
    expect(payoutBatchStatusLabel("PAID")).toBe("Paid");
    expect(payoutBatchStatusLabel("FAILED")).toBe("Transfer failed");
    expect(payoutBatchTone("PAID")).toBe("good");
    expect(payoutBatchTone("FAILED")).toBe("bad");
    expect(payoutActions("PENDING")).toEqual(["schedule"]);
    expect(payoutActions("SCHEDULED")).toEqual(["mark-paid", "mark-failed"]);
    expect(payoutActions("PAID")).toEqual([]);
    expect(payoutActions("FAILED")).toEqual([]);
  });

  it("defaults to last month and accepts only real months", () => {
    expect(previousMonth("2026-11-26")).toBe("2026-10");
    expect(previousMonth("2027-01-03")).toBe("2026-12");
    expect(previousMonth("garbage")).toBe("");
    expect(isMonth("2026-11")).toBe(true);
    expect(isMonth("2026-13")).toBe(false);
    expect(isMonth("2026-1")).toBe(false);
  });

  it("reads the setup token only from a well-formed fragment", () => {
    const token = "a".repeat(43);
    expect(setupTokenFromHash(`#token=${token}`)).toBe(token);
    expect(setupTokenFromHash("#token=short")).toBeNull();
    expect(setupTokenFromHash(`#token=${token}&x=1`)).toBeNull();
    expect(setupTokenFromHash("")).toBeNull();
    expect(
      setupUrl("https://merostay.example/", {
        setupPath: `/admin-setup#token=${token}`,
        expiresAt: "",
      }),
    ).toBe(`https://merostay.example/admin-setup#token=${token}`);
  });

  it("explains admin states, the type rule, late payments and refunds in words", () => {
    expect(adminAccountLabel({ status: "ACTIVE", setupPending: true })).toBe(
      "Invited (no password yet)",
    );
    expect(adminAccountLabel({ status: "ACTIVE", setupPending: false })).toBe("Active");
    expect(adminAccountLabel({ status: "SUSPENDED", setupPending: false })).toBe("Suspended");
    expect(typeRuleText({ allowed: true, reason: null, allowedListingTypes: [] })).toBe(
      "Allowed for this kind of business",
    );
    expect(
      typeRuleText({ allowed: false, reason: "not_mapped", allowedListingTypes: ["bus_ticket"] }),
    ).toBe("Not allowed for this kind of business. Allowed: bus ticket.");
    expect(
      typeRuleText({
        allowed: false,
        reason: "provider_type_not_offered",
        allowedListingTypes: [],
      }),
    ).toMatch(/switched off\. This kind of business can list nothing/);
    expect(reconciliationReasonLabel("PAYMENT_NOT_OPEN")).toBe("Paid after the booking hold ended");
    expect(reconciliationReasonLabel("NEW_REASON")).toBe("NEW_REASON");
    expect(refundStatusLabel("REQUESTED")).toBe("Requested (not executed)");
    expect(gatewayName("esewa")).toBe("eSewa");
    expect(gatewayName("khalti")).toBe("Khalti");
  });

  it("has admin messages for the new errors (never the raw server text)", () => {
    for (const code of [
      "PAYOUT_ACCOUNT_NOT_VERIFIED",
      "PAYOUT_ALREADY_PAID",
      "PAYOUT_EMPTY",
      "LISTING_TYPE_NOT_ALLOWED",
      "LISTING_NOT_IN_REVIEW",
      "LAST_ADMIN",
      "ADMIN_SELF_LOCKOUT",
      "RECONCILIATION_ALREADY_RESOLVED",
    ]) {
      expect(describeAdminError(new ApiError(409, code, "raw server text"))).not.toBe(
        "raw server text",
      );
    }
  });
});
