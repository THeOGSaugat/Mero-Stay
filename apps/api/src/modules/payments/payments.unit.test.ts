import type { NextFunction, Request, Response } from "express";
import { describe, expect, it } from "vitest";
import { parseEnv, paymentsConfigFromEnv } from "../../config/env.js";
import type { AppError } from "../../lib/errors.js";
import { testAuthConfig } from "../../testing/auth-config.js";
import { countMoneyFields, moneyBoundaryViolations } from "../../testing/json-safety.js";
import { createAuthMiddleware } from "../auth/auth.middleware.js";
import type { AuthService } from "../auth/auth.service.js";
import type { PaymentWithAllocations } from "./payments.repository.js";
import { confirmPaymentBodySchema, settleAtPropertyBodySchema } from "./payments.schemas.js";
import { serializeIntent, serializeInvoices, serializePayment } from "./payments.serializers.js";

const payment: PaymentWithAllocations = {
  id: "11111111-1111-4111-8111-111111111111",
  tripId: "22222222-2222-4222-8222-222222222222",
  kind: "CHARGE",
  gateway: "simulated",
  status: "SUCCEEDED",
  currency: "NPR",
  // 2^53 + 1 paisa: would silently become ...992 as a JS number.
  amountMinor: 9_007_199_254_740_993n,
  capturedMinor: 9_007_199_254_740_993n,
  intentFingerprint: "a".repeat(64),
  gatewayTransactionId: "SIM-1",
  gatewayResponse: null,
  completedAt: new Date("2026-11-21T06:00:00Z"),
  createdAt: new Date("2026-11-21T05:59:00Z"),
  updatedAt: new Date("2026-11-21T06:00:00Z"),
  allocations: [
    { bookingItemId: "33333333-3333-4333-8333-333333333333", amountMinor: 9_007_199_254_740_993n },
  ],
};

describe("payment responses: money is a string at the boundary (BIGINT inside)", () => {
  it("every money field is an exact digit string with its currency", () => {
    const body = JSON.parse(
      JSON.stringify(
        serializeIntent({
          payment,
          created: true,
          lines: [
            { itemId: "33333333-3333-4333-8333-333333333333", dueMinor: 9_007_199_254_740_993n },
          ],
        }),
      ),
    ) as { data: { payment: { amountMinor: string } } };
    expect(moneyBoundaryViolations(body)).toEqual([]);
    expect(countMoneyFields(body)).toBe(5); // amount, captured, allocation, due line, total due
    expect(body.data.payment.amountMinor).toBe("9007199254740993");
  });

  it("MUTATION: a money field serialized as a number is caught", () => {
    const mutated = { ...serializePayment(payment), capturedMinor: Number(payment.capturedMinor) };
    const body: unknown = JSON.parse(JSON.stringify(mutated));
    expect(moneyBoundaryViolations(body)).toEqual([
      "$.capturedMinor is 9007199254740992 (must be a digit string)",
    ]);
  });

  it("MUTATION: a raw bigint cannot reach JSON (no global BigInt patch)", () => {
    expect(() => JSON.stringify({ amountMinor: payment.amountMinor })).toThrow(TypeError);
  });

  it("the admin invoice view keeps commission amounts as strings too", () => {
    const body: unknown = JSON.parse(
      JSON.stringify(
        serializeInvoices([
          {
            id: "44444444-4444-4444-8444-444444444444",
            number: "INV-20261121-ABCDEFGH",
            providerId: "p",
            tripId: payment.tripId,
            status: "ISSUED",
            currency: "NPR",
            amountMinor: 115_500n,
            issuedAt: new Date("2026-11-21T06:00:00Z"),
            dueOn: null,
            paidAt: null,
            createdAt: new Date("2026-11-21T06:00:00Z"),
            provider: { id: "p", displayName: "Homestay" },
            bookingItems: [
              {
                id: "i",
                listingId: "l",
                listingTypeCode: "hotel_room",
                subtotalMinor: 770_000n,
                commissionRateBps: 1500,
                commissionMinor: 115_500n,
                commissionStatus: "INVOICED",
                paymentStatus: "PAY_AT_PROPERTY",
              },
            ],
          },
        ]),
      ),
    );
    expect(moneyBoundaryViolations(body)).toEqual([]);
    expect(countMoneyFields(body)).toBe(3);
  });
});

describe("payment input contracts", () => {
  it("confirm: defaults to a full successful capture; rejects unknown fields and bad amounts", () => {
    expect(confirmPaymentBodySchema.parse({})).toEqual({ outcome: "succeeded" });
    expect(confirmPaymentBodySchema.parse({ capturedAmountMinor: "500000" })).toMatchObject({
      capturedAmountMinor: "500000",
    });
    for (const bad of [
      { capturedAmountMinor: 500000 }, // a number: money is never a JSON number
      { capturedAmountMinor: "0" },
      { capturedAmountMinor: "-1" },
      { capturedAmountMinor: "1.5" },
      { capturedAmountMinor: "12345678901234567890" }, // above BIGINT
      { amountMinor: "100" }, // unknown field: the client never sets the amount
      { outcome: "maybe" },
      { gatewayTransactionId: "has spaces" },
    ]) {
      expect(confirmPaymentBodySchema.safeParse(bad).success).toBe(false);
    }
  });

  it("settle: 1–50 distinct item UUIDs", () => {
    const id = "33333333-3333-4333-8333-333333333333";
    expect(settleAtPropertyBodySchema.safeParse({ itemIds: [id] }).success).toBe(true);
    expect(settleAtPropertyBodySchema.safeParse({ itemIds: [] }).success).toBe(false);
    expect(settleAtPropertyBodySchema.safeParse({ itemIds: [id, id] }).success).toBe(false);
    expect(settleAtPropertyBodySchema.safeParse({ itemIds: ["x"] }).success).toBe(false);
    expect(settleAtPropertyBodySchema.safeParse({ itemIds: [id], extra: 1 }).success).toBe(false);
  });
});

describe("payment gateway configuration", () => {
  const url = "postgresql://u:p@ep-x-pooler.eu-central-1.aws.neon.tech/db?sslmode=require";

  it("is off unless explicitly set (payment endpoints then return 503)", () => {
    expect(paymentsConfigFromEnv(parseEnv({ DATABASE_URL: url }))).toEqual({ gateway: null });
    expect(
      paymentsConfigFromEnv(parseEnv({ DATABASE_URL: url, PAYMENT_GATEWAY: "simulated" })),
    ).toEqual({ gateway: "simulated" });
  });

  it("the simulated gateway is refused in production", () => {
    expect(() =>
      parseEnv({ DATABASE_URL: url, NODE_ENV: "production", PAYMENT_GATEWAY: "simulated" }),
    ).toThrow(/PAYMENT_GATEWAY: cannot be simulated in production/);
  });

  it("rejects unknown gateways and out-of-range job intervals", () => {
    expect(() => parseEnv({ DATABASE_URL: url, PAYMENT_GATEWAY: "esewa" })).toThrow(
      /PAYMENT_GATEWAY/,
    );
    expect(() => parseEnv({ DATABASE_URL: url, HOLD_RELEASE_INTERVAL_SECONDS: "1" })).toThrow(
      /HOLD_RELEASE_INTERVAL_SECONDS/,
    );
  });
});

describe("requireRole (admin guard)", () => {
  const middleware = createAuthMiddleware({} as AuthService, testAuthConfig());

  function run(role?: "CUSTOMER" | "PARTNER" | "ADMIN"): AppError | undefined {
    const req = (
      role
        ? {
            auth: {
              user: { role },
              session: { id: "s", tokenHash: "h", expiresAt: new Date() },
            },
          }
        : {}
    ) as Request;
    let result: unknown;
    const next: NextFunction = (err?: unknown) => {
      result = err;
    };
    void middleware.requireRole("ADMIN")(req, {} as Response, next);
    return result as AppError | undefined;
  }

  it("lets an ADMIN through", () => {
    expect(run("ADMIN")).toBeUndefined();
  });

  it("refuses customers, partners and anonymous requests with 403 FORBIDDEN", () => {
    for (const role of ["CUSTOMER", "PARTNER", undefined] as const) {
      const err = run(role);
      expect([err?.statusCode, err?.code]).toEqual([403, "FORBIDDEN"]);
    }
  });
});
