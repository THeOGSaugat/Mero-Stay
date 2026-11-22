import type { NextFunction, Request, Response } from "express";
import { describe, expect, it } from "vitest";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { maskAccountNumber, maskEmail, maskPhone } from "../../domain/masking.js";
import type { AppError } from "../../lib/errors.js";
import { idempotencyKeyOf, requestFingerprint } from "../../lib/idempotency.js";
import { testAuthConfig } from "../../testing/auth-config.js";
import { countMoneyFields, moneyBoundaryViolations } from "../../testing/json-safety.js";
import { redactForAudit } from "../audit/audit.js";
import { createAuthMiddleware } from "../auth/auth.middleware.js";
import type { AuthService } from "../auth/auth.service.js";
import { serializeProviderBooking } from "../bookings/provider-bookings.serializers.js";
import type { ProviderBooking } from "../bookings/provider-bookings.service.js";
import { serializePayoutSummary } from "../finance/finance.serializers.js";
import { slotDates } from "../inventory/inventory.service.js";
import { detailSpecFor } from "../listings/listing-details.js";
import { canPartnerMoveListing } from "../listings/listing-management.service.js";
import { serializeProfile } from "../providers/providers.serializers.js";
import type { ProviderProfile } from "../providers/providers.service.js";
import { createPartnerContext } from "./partner-context.js";

/** Runs a middleware and returns the error it passed on (or undefined). */
async function run(mw: (req: Request, res: Response, next: NextFunction) => unknown, req: Request) {
  let passed: unknown;
  try {
    await mw(req, {} as Response, (err?: unknown) => {
      passed = err;
    });
  } catch (err) {
    passed = err;
  }
  return passed as AppError | undefined;
}

const user = (role: "CUSTOMER" | "PARTNER" | "ADMIN", id = "u1") =>
  ({ user: { id, role }, session: { id: "s", tokenHash: "h", expiresAt: new Date() } }) as never;

describe("masking", () => {
  it("bank account numbers: only the last 4 characters", () => {
    expect(maskAccountNumber("0123456789012")).toBe("••••9012");
    expect(maskAccountNumber("01 2345 6789")).toBe("••••6789");
    expect(maskAccountNumber("1234")).toBe("••••");
  });

  it("customer email and phone for partners", () => {
    expect(maskEmail("sita.sharma@example.com")).toBe("s•••@e•••.com");
    expect(maskEmail(null)).toBeNull();
    expect(maskPhone("+9779812345678")).toBe("+977••••••5678");
    expect(maskPhone(null)).toBeNull();
    expect(maskEmail("sita.sharma@example.com")).not.toContain("sharma");
  });
});

describe("audit payload redaction", () => {
  it("drops secrets at any depth and masks bank account numbers", () => {
    const safe = redactForAudit({
      passwordHash: "$argon2id$v=19$...",
      password_hash: "x",
      token: "t",
      tokenHash: "h",
      csrfToken: "c",
      sessionSecret: "s",
      nested: { session_token: "abc", keep: 1, accountNumber: "0123456789012" },
      list: [{ account_number: "99887766" }],
      amountMinor: 115_500n,
      when: new Date("2026-11-22T00:00:00Z"),
    });
    expect(safe).toEqual({
      nested: { keep: 1, accountNumberMasked: "••••9012" },
      list: [{ accountNumberMasked: "••••7766" }],
      amountMinor: "115500",
      when: "2026-11-22T00:00:00.000Z",
    });
    expect(JSON.stringify(safe)).not.toMatch(/argon2id|0123456789012|99887766|"token"/);
  });
});

describe("idempotency keys", () => {
  const req = (key?: string) => ({ get: () => key }) as unknown as Request;

  it("validates the header; required only where asked", () => {
    expect(idempotencyKeyOf(req(), false)).toBeNull();
    expect(idempotencyKeyOf(req("settle-2026-11-22-a"), true)).toBe("settle-2026-11-22-a");
    expect(() => idempotencyKeyOf(req(), true)).toThrow(/Idempotency-Key/);
    expect(() => idempotencyKeyOf(req("short"), false)).toThrow(/8–128/);
    expect(() => idempotencyKeyOf(req("has space in it"), false)).toThrow(/8–128/);
  });

  it("fingerprint: stable under key order, different for another request or scope", () => {
    const a = requestFingerprint("partner.settle_at_property", { itemId: "i1", providerId: "p1" });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(
      requestFingerprint("partner.settle_at_property", { providerId: "p1", itemId: "i1" }),
    ).toBe(a);
    expect(
      requestFingerprint("partner.settle_at_property", { itemId: "i2", providerId: "p1" }),
    ).not.toBe(a);
    expect(
      requestFingerprint("partner.listing.create", { itemId: "i1", providerId: "p1" }),
    ).not.toBe(a);
  });
});

describe("partner context (which provider a request acts for)", () => {
  const P1 = "11111111-1111-4111-8111-111111111111";
  const P2 = "22222222-2222-4222-8222-222222222222";
  const OTHER = "33333333-3333-4333-8333-333333333333";
  const prismaWith = (owned: { id: string; status: string }[]) =>
    ({ provider: { findMany: () => Promise.resolve(owned) } }) as unknown as PrismaClient;
  const request = (header?: string) =>
    ({ auth: user("PARTNER"), get: () => header }) as unknown as Request;

  it("one provider: used implicitly", async () => {
    const req = request();
    expect(
      await run(createPartnerContext(prismaWith([{ id: P1, status: "VERIFIED" }])), req),
    ).toBeUndefined();
    expect(req.partner).toEqual({ providerId: P1, providerStatus: "VERIFIED" });
  });

  it("several providers: X-Provider-Id picks one; without it 400", async () => {
    const owned = [
      { id: P1, status: "VERIFIED" },
      { id: P2, status: "DRAFT" },
    ];
    const req = request(P2);
    expect(await run(createPartnerContext(prismaWith(owned)), req)).toBeUndefined();
    expect(req.partner?.providerId).toBe(P2);
    const err = await run(createPartnerContext(prismaWith(owned)), request());
    expect([err?.statusCode, err?.code]).toEqual([400, "PROVIDER_ID_REQUIRED"]);
  });

  it("someone else's provider is a 404 (same as a missing one); no provider yet is 409", async () => {
    const err = await run(
      createPartnerContext(prismaWith([{ id: P1, status: "VERIFIED" }])),
      request(OTHER),
    );
    expect([err?.statusCode, err?.code]).toEqual([404, "PROVIDER_NOT_FOUND"]);
    const none = await run(createPartnerContext(prismaWith([])), request());
    expect([none?.statusCode, none?.code]).toEqual([409, "PARTNER_NOT_ONBOARDED"]);
    const bad = await run(createPartnerContext(prismaWith([])), request("not-a-uuid"));
    expect(bad?.statusCode).toBe(400);
  });
});

describe("role guard with several roles", () => {
  const mw = createAuthMiddleware({} as AuthService, testAuthConfig());
  it("onboarding accepts customers and partners, never admins or anonymous users", async () => {
    const guard = mw.requireRole("CUSTOMER", "PARTNER");
    expect(await run(guard, { auth: user("CUSTOMER") } as unknown as Request)).toBeUndefined();
    expect(await run(guard, { auth: user("PARTNER") } as unknown as Request)).toBeUndefined();
    expect((await run(guard, { auth: user("ADMIN") } as unknown as Request))?.code).toBe(
      "FORBIDDEN",
    );
    expect((await run(guard, {} as unknown as Request))?.code).toBe("FORBIDDEN");
  });
});

describe("partner listing rules", () => {
  it("partners can submit, archive and reopen, but never approve or unsuspend", () => {
    expect(canPartnerMoveListing("DRAFT", "PENDING_REVIEW")).toBe(true);
    expect(canPartnerMoveListing("APPROVED", "ARCHIVED")).toBe(true);
    expect(canPartnerMoveListing("ARCHIVED", "DRAFT")).toBe(true);
    expect(canPartnerMoveListing("DRAFT", "APPROVED")).toBe(false);
    expect(canPartnerMoveListing("PENDING_REVIEW", "APPROVED")).toBe(false);
    expect(canPartnerMoveListing("SUSPENDED", "DRAFT")).toBe(false);
    expect(canPartnerMoveListing("APPROVED", "DRAFT")).toBe(false);
  });

  it("detail fields are validated per listing type; other types use attributes only", () => {
    const room = detailSpecFor("hotel_room");
    expect(room?.relation).toBe("hotelRoomDetail");
    expect(room?.schema.parse({ maxAdults: 2 })).toEqual({
      maxAdults: 2,
      maxChildren: 0,
      bedCount: 1,
    });
    expect(room?.schema.safeParse({ maxAdults: 0 }).success).toBe(false);
    expect(room?.schema.safeParse({ maxAdults: 2, extra: true }).success).toBe(false);
    const bus = detailSpecFor("bus_ticket");
    const same = "44444444-4444-4444-8444-444444444444";
    expect(
      bus?.schema.safeParse({
        originLocationId: same,
        destinationLocationId: same,
        departureTime: "06:30",
        durationMinutes: 300,
        busType: "Deluxe",
        seatCapacity: 35,
      }).success,
    ).toBe(false);
    expect(detailSpecFor("activity")).toBeUndefined(); // generic: attributes JSON
    expect(detailSpecFor("a_future_vertical")).toBeUndefined();
  });

  it("slot ranges are [start, end), at most 366 days", () => {
    expect(slotDates("2026-12-30", "2027-01-02")).toEqual([
      "2026-12-30",
      "2026-12-31",
      "2027-01-01",
    ]);
    expect(() => slotDates("2027-01-02", "2027-01-02")).toThrow(/after/);
    expect(slotDates("2027-01-01", "2028-01-02")).toHaveLength(366);
    expect(() => slotDates("2027-01-01", "2028-01-03")).toThrow(/366/);
  });
});

describe("partner responses: money as strings, bank numbers masked", () => {
  const booking = {
    id: "i",
    tripId: "t",
    status: "CONFIRMED",
    startDate: new Date("2027-01-10T00:00:00Z"),
    endDate: new Date("2027-01-12T00:00:00Z"),
    quantity: 2,
    travellerCount: 2,
    currency: "NPR",
    subtotalMinor: 770_000n,
    serviceChargeMinor: 77_000n,
    taxMinor: 110_110n,
    totalMinor: 957_110n,
    commissionRateBps: 1500,
    commissionMinor: 115_500n,
    providerPayoutMinor: 841_610n,
    refundedMinor: 0n,
    paymentStatus: "PAY_AT_PROPERTY",
    commissionStatus: "INVOICED",
    payoutStatus: "NOT_APPLICABLE",
    paymentSettledAt: null,
    confirmedAt: null,
    createdAt: new Date("2026-11-22T00:00:00Z"),
    trip: {
      reference: "MS-ABCDEFGH",
      status: "CONFIRMED",
      contactName: "Sita Sharma",
      contactEmail: "sita.sharma@example.com",
      contactPhone: "+9779812345678",
      customer: { fullName: "Sita Sharma", email: "sita.sharma@example.com", phone: null },
    },
    listing: { id: "l", title: "Room", listingTypeCode: "hotel_room" },
    allocations: [],
    commissionInvoice: { id: "inv", number: "INV-20261122-ABCDEFGH", status: "ISSUED" },
  } as unknown as ProviderBooking;

  it("a booking shows the customer by name only and every amount as a digit string", () => {
    const body: unknown = JSON.parse(JSON.stringify({ data: serializeProviderBooking(booking) }));
    expect(moneyBoundaryViolations(body)).toEqual([]);
    expect(countMoneyFields(body)).toBe(8);
    const text = JSON.stringify(body);
    expect(text).toContain("Sita Sharma");
    expect(text).not.toContain("sita.sharma@example.com");
    expect(text).not.toContain("9812345678");
  });

  it("MUTATION: a payout amount serialized as a number is caught", () => {
    const out = serializePayoutSummary(
      [
        {
          providerId: "p",
          providerName: "P",
          period: "2027-01",
          currency: "NPR",
          items: 1,
          subtotalMinor: 360_000n,
          serviceChargeMinor: 0n,
          taxMinor: 0n,
          totalMinor: 360_000n,
          commissionMinor: 54_000n,
          providerPayoutMinor: 306_000n,
        },
      ],
      1,
      { page: 1, pageSize: 20 },
    );
    expect(moneyBoundaryViolations(JSON.parse(JSON.stringify(out)))).toEqual([]);
    const mutated = { ...out, data: [{ ...out.data[0]!, providerPayoutMinor: 306000 }] };
    expect(moneyBoundaryViolations(JSON.parse(JSON.stringify(mutated)))).toEqual([
      "$.data[0].providerPayoutMinor is 306000 (must be a digit string)",
    ]);
  });

  it("the profile never contains the full bank account number", () => {
    const profile = {
      id: "p",
      providerType: { code: "hotel", name: "Hotel" },
      legalName: "L",
      displayName: "D",
      description: null,
      status: "VERIFIED",
      verifiedAt: null,
      rejectionReason: null,
      contactEmail: null,
      contactPhone: null,
      addressLine: null,
      panNumber: null,
      vatNumber: null,
      businessRegistrationNo: null,
      commissionRateBps: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      documents: [],
      payoutAccounts: [
        {
          id: "a",
          bankName: "Nabil Bank",
          branch: null,
          accountName: "D",
          accountNumber: "0123456789012",
          verifiedAt: null,
        },
      ],
    } as unknown as ProviderProfile;
    const text = JSON.stringify(serializeProfile(profile));
    expect(text).toContain('"accountNumberMasked":"••••9012"');
    expect(text).not.toContain("0123456789012");
    expect(text).not.toContain('"accountNumber"');
  });
});
