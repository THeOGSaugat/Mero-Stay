import { describe, expect, it } from "vitest";
import { ApiError, describeApiError } from "./api-client";
import {
  callbackBody,
  canPayOnline,
  checkoutStep,
  gatewayLabel,
  isOnlineGateway,
  outcomeView,
} from "./payment-flow";

describe("Phase 11: paying online with eSewa or Khalti (ADR 0017)", () => {
  it("offers only eSewa and Khalti to customers", () => {
    expect(isOnlineGateway("esewa")).toBe(true);
    expect(isOnlineGateway("khalti")).toBe(true);
    expect(isOnlineGateway("simulated")).toBe(false);
    expect(gatewayLabel("esewa")).toBe("eSewa");
    expect(gatewayLabel("khalti")).toBe("Khalti");
  });

  it("follows an eSewa form or a Khalti redirect, never a script or odd URL", () => {
    expect(
      checkoutStep({
        type: "form",
        method: "POST",
        url: "https://rc-epay.esewa.com.np/api/epay/main/v2/form",
        fields: { total_amount: "3600", signature: "abc=" },
      }),
    ).toEqual({
      kind: "form",
      url: "https://rc-epay.esewa.com.np/api/epay/main/v2/form",
      fields: [
        ["total_amount", "3600"],
        ["signature", "abc="],
      ],
    });
    expect(checkoutStep({ type: "redirect", url: "https://test-pay.khalti.com/?pidx=x" })).toEqual({
      kind: "redirect",
      url: "https://test-pay.khalti.com/?pidx=x",
    });
    expect(checkoutStep({ type: "redirect", url: "javascript:alert(1)" })).toBeNull();
    expect(checkoutStep({ type: "redirect", url: "not a url" })).toBeNull();
    expect(
      checkoutStep({ type: "form", method: "POST", url: "data:text/html,x", fields: {} }),
    ).toBeNull();
    expect(checkoutStep({ type: "simulated" })).toBeNull();
    expect(checkoutStep(null)).toBeNull();
  });

  it("offers online payment only while a confirmed trip's hold lasts and money is due", () => {
    const now = new Date("2026-11-27T10:00:00Z");
    const trip = {
      status: "PENDING",
      expiresAt: "2026-11-27T10:20:00Z",
      onlinePayment: { dueMinor: "360000" },
    };
    expect(canPayOnline(trip, now)).toBe(true);
    expect(canPayOnline({ ...trip, status: "CONFIRMED" }, now)).toBe(false);
    expect(canPayOnline({ ...trip, onlinePayment: { dueMinor: "0" } }, now)).toBe(false);
    expect(canPayOnline({ ...trip, expiresAt: "2026-11-27T09:59:59Z" }, now)).toBe(false);
  });

  it("sends the API only what it verifies: eSewa's data or Khalti's pidx", () => {
    const esewa = new URLSearchParams("data=eyJhIjoxfQ%3D%3D&extra=1");
    expect(callbackBody("esewa", "p1", esewa)).toEqual({ paymentId: "p1", data: "eyJhIjoxfQ==" });
    const khalti = new URLSearchParams("pidx=abc&status=Completed&amount=360000");
    expect(callbackBody("khalti", "p2", khalti)).toEqual({ paymentId: "p2", pidx: "abc" });
    expect(callbackBody("esewa", "p3", new URLSearchParams())).toEqual({ paymentId: "p3" });
  });

  it("explains every outcome", () => {
    expect(outcomeView("paid").tone).toBe("success");
    expect(outcomeView("replayed").title).toBe("Payment received");
    expect(outcomeView("pending").tone).toBe("info");
    expect(outcomeView("reconciliation").text).toMatch(/nothing is lost/);
    expect(outcomeView("failed").tone).toBe("error");
    expect(outcomeView("expired").tone).toBe("error");
    expect(outcomeView("something-new").tone).toBe("error");
  });

  it("has customer messages for the payment errors", () => {
    for (const code of [
      "PAYMENT_GATEWAY_UNAVAILABLE",
      "PAYMENT_CALLBACK_INVALID",
      "PAYMENT_IN_PROGRESS",
      "PAYMENTS_UNAVAILABLE",
    ]) {
      const message = describeApiError(new ApiError(502, code, "raw server text"));
      expect(message).not.toBe("raw server text");
    }
  });
});
