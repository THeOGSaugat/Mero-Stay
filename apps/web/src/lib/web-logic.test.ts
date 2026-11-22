import { describe, expect, it, vi } from "vitest";
import { ApiError, apiRequest, describeApiError } from "./api-client";
import type { Quote, SessionPayload, TripItem } from "./api-types";
import { authReducer, INITIAL_AUTH_STATE, loginHref, safeNextPath } from "./auth-state";
import {
  confirmOutcome,
  describeCancellationRule,
  detailValueText,
  formatDateRange,
  humanizeKey,
  quoteRows,
  totalsRows,
} from "./trip-display";

const session: SessionPayload = {
  user: {
    id: "u1",
    email: "sita@example.com",
    phone: null,
    fullName: "Sita",
    role: "CUSTOMER",
    status: "ACTIVE",
    createdAt: "2026-11-23T00:00:00Z",
  },
  csrfToken: "csrf-123",
  sessionExpiresAt: "2026-11-30T00:00:00Z",
};

describe("auth state (session cookie is httpOnly; only the user and CSRF token live in memory)", () => {
  it("loading → authenticated → anonymous", () => {
    expect(INITIAL_AUTH_STATE.status).toBe("loading");
    const signedIn = authReducer(INITIAL_AUTH_STATE, { type: "session", session });
    expect(signedIn).toEqual({
      status: "authenticated",
      user: session.user,
      csrfToken: "csrf-123",
    });
    expect(authReducer(signedIn, { type: "anonymous" })).toEqual({
      status: "anonymous",
      user: null,
      csrfToken: null,
    });
  });

  it("only same-site paths are accepted after login (no open redirect)", () => {
    expect(safeNextPath("/trips/abc")).toBe("/trips/abc");
    expect(safeNextPath("/listings/x?startDate=2027-01-10")).toBe(
      "/listings/x?startDate=2027-01-10",
    );
    for (const bad of [
      "https://evil.example",
      "//evil.example",
      "/\\evil.example",
      "trips",
      "/a\nb",
      "",
    ]) {
      expect(safeNextPath(bad)).toBe("/search");
    }
    expect(loginHref("/trip")).toBe("/login?next=%2Ftrip");
  });
});

describe("API client", () => {
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...headers },
    });

  it("calls the same-origin proxy with credentials, and the CSRF header only on writes", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(json(200, { data: 1 })));
    await apiRequest("/trips", { fetchImpl, csrfToken: "t" });
    await apiRequest("/trips", {
      method: "POST",
      body: { currency: "NPR" },
      csrfToken: "t",
      fetchImpl,
    });
    const [getCall, postCall] = fetchImpl.mock.calls as unknown as [
      [string, RequestInit],
      [string, RequestInit],
    ];
    expect(getCall[0]).toBe("/api/v1/trips");
    expect(getCall[1]).toMatchObject({ method: "GET", credentials: "include" });
    expect((getCall[1].headers as Record<string, string>)["X-CSRF-Token"]).toBeUndefined();
    expect(postCall[1]).toMatchObject({
      method: "POST",
      credentials: "include",
      body: '{"currency":"NPR"}',
    });
    expect((postCall[1].headers as Record<string, string>)["X-CSRF-Token"]).toBe("t");
  });

  it("turns error bodies into ApiError (with Retry-After) and messages people can act on", async () => {
    const fetchImpl = () =>
      Promise.resolve(
        json(
          429,
          { error: { code: "RATE_LIMITED", message: "Too many" } },
          { "Retry-After": "600" },
        ),
      );
    const err = await apiRequest("/auth/login", { method: "POST", body: {}, fetchImpl }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 429, code: "RATE_LIMITED", retryAfterSeconds: 600 });
    expect(describeApiError(err)).toBe("Too many attempts. Try again in 10 minutes.");

    expect(describeApiError(new ApiError(401, "INVALID_CREDENTIALS", "x"))).toBe(
      "Email or password is incorrect.",
    );
    expect(describeApiError(new ApiError(409, "EMAIL_TAKEN", "x"))).toMatch(/already exists/);
    expect(describeApiError(new ApiError(409, "INSUFFICIENT_AVAILABILITY", "x"))).toMatch(
      /availability/,
    );
    expect(describeApiError(new ApiError(422, "CURRENCY_MISMATCH", "x"))).toMatch(
      /different currency/,
    );
    expect(describeApiError(new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "x"))).toMatch(
      /wrong format/,
    );
    expect(
      describeApiError(
        new ApiError(400, "VALIDATION_ERROR", "x", [
          { path: "password", message: "must be at least 12 characters" },
        ]),
      ),
    ).toBe("Please check: password: must be at least 12 characters");
  });

  it("reports a network failure without throwing anything else", async () => {
    const err = await apiRequest("/auth/me", {
      fetchImpl: () => Promise.reject(new Error("offline")),
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "NETWORK_ERROR" });
  });
});

describe("quote and trip display", () => {
  const quote: Quote = {
    tripId: "t",
    dryRun: true,
    currency: "NPR",
    currencyExponent: 2,
    allAvailable: true,
    totals: {
      subtotalMinor: "2030000",
      serviceChargeMinor: "77000",
      taxMinor: "110110",
      totalMinor: "2217110",
      payOnlineMinor: "1260000",
      payAtPropertyMinor: "957110",
    },
    lines: [
      {
        itemId: "i1",
        candidateIndex: null,
        listing: { id: "l1", title: "Lake View Double", listingType: "hotel_room" },
        paymentMethod: "pay_at_property",
        startDate: "2027-01-10",
        endDate: "2027-01-12",
        quantity: 1,
        available: true,
        unavailableDates: [],
        priceChanged: true,
        lines: [],
        money: {
          subtotalMinor: "770000",
          serviceChargeRateBps: 1000,
          serviceChargeMinor: "77000",
          taxRateBps: 1300,
          taxMinor: "110110",
          totalMinor: "957110",
        },
        heldMoney: {
          subtotalMinor: "700000",
          serviceChargeRateBps: 1000,
          serviceChargeMinor: "70000",
          taxRateBps: 1300,
          taxMinor: "100100",
          totalMinor: "870100",
        },
      },
    ],
  };

  it("formats every quote amount from the API's strings", () => {
    expect(quoteRows(quote)).toEqual([
      {
        key: "i1",
        title: "Lake View Double",
        dates: "10 Jan 2027 → 12 Jan 2027",
        quantity: 1,
        payment: "Pay at the property",
        subtotal: "Rs 7,700.00",
        serviceCharge: "Rs 770.00",
        tax: "Rs 1,101.10",
        total: "Rs 9,571.10",
        available: true,
        unavailableDates: [],
        priceChanged: true,
        heldTotal: "Rs 8,701.00",
      },
    ]);
    expect(totalsRows(quote.totals, quote)).toEqual([
      { label: "Subtotal", value: "Rs 20,300.00" },
      { label: "Service charge", value: "Rs 770.00" },
      { label: "VAT", value: "Rs 1,101.10" },
      { label: "Total", value: "Rs 22,171.10", emphasis: true },
      { label: "Pay online", value: "Rs 12,600.00" },
      { label: "Pay at the property", value: "Rs 9,571.10" },
    ]);
  });

  it("explains the result of confirming", () => {
    const item = (paymentMethod: "online" | "pay_at_property", status: string) =>
      ({ paymentMethod, status }) as TripItem;
    expect(
      confirmOutcome({ status: "CONFIRMED", items: [item("pay_at_property", "CONFIRMED")] }),
    ).toBe("Your trip is confirmed.");
    expect(
      confirmOutcome({
        status: "PENDING",
        items: [
          item("pay_at_property", "CONFIRMED"),
          item("online", "PENDING"),
          item("online", "PENDING"),
        ],
      }),
    ).toBe(
      "Submitted: 1 pay-at-property item is confirmed; 2 online items are reserved and waiting for online payment.",
    );
  });

  it("formats service dates as calendar dates", () => {
    expect(formatDateRange("2027-01-10", null)).toBe("10 Jan 2027");
    expect(formatDateRange("2026-12-31", "2027-01-01")).toBe("31 Dec 2026 → 1 Jan 2027");
  });
});

describe("listing details and policies in plain words", () => {
  it("describes cancellation rules", () => {
    expect(describeCancellationRule({ minHoursBeforeStart: 72, refundBps: 10000 })).toBe(
      "Cancel 72+ hours before the start: 100% refund",
    );
    expect(describeCancellationRule({ minHoursBeforeStart: 24, refundBps: 5000 })).toBe(
      "Cancel 24+ hours before the start: 50% refund",
    );
    expect(describeCancellationRule({ minHoursBeforeStart: 0, refundBps: 0 })).toBe(
      "Cancel any time before the start: 0% refund",
    );
  });

  it("shows generic detail fields", () => {
    expect(humanizeKey("durationMinutes")).toBe("Duration minutes");
    expect(humanizeKey("max_group_size")).toBe("Max group size");
    expect(detailValueText({ id: "x", name: "Pokhara", slug: "pokhara" })).toBe("Pokhara");
    expect(detailValueText(["en", "ne"])).toBe("en, ne");
    expect(detailValueText(true)).toBe("Yes");
    expect(detailValueText(null)).toBe("—");
  });
});
