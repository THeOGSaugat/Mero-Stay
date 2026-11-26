/* eslint-disable no-console -- CLI script: prints the seeded world as JSON for Playwright. */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { randomBytes } from "node:crypto";
import { toDbDate, todayInKathmandu } from "../domain/dates.js";
import { calculateItemCharges, resolveCommissionRateBps, summarizeTrip } from "../domain/money.js";
import type { PrismaClient } from "../generated/prisma/client.js";
import type { ProviderDocumentType } from "../generated/prisma/enums.js";
import { createPrismaClient } from "../lib/prisma.js";
import { hashPassword } from "../modules/auth/password.js";
import { seededFileFields } from "./documents.js";
import { createWorld, type World } from "./fixtures.js";
import { API_ROOT, databaseIdentity } from "./test-database.js";

/**
 * E2E seed (Playwright global setup, e2e/global-setup.ts). Prepares a DISPOSABLE database for the
 * booking journey: applies all migrations, then inserts a fresh test world (unique names, dates
 * relative to today) with the same fixture the integration tests use. Seeding directly is
 * deliberate: setting up providers and approved listings is not what the E2E test checks.
 *
 * Safety: reads only E2E_DATABASE_URL, and refuses when it points at the dev database in
 * apps/api/.env (same check as the integration-test guard). It never wipes anything.
 */
function devDatabaseIdentities(): string[] {
  const path = `${API_ROOT}.env`;
  if (!existsSync(path)) return [];
  const env = parseEnv(readFileSync(path, "utf8"));
  return [env.DATABASE_URL, env.DATABASE_URL_UNPOOLED]
    .filter((url): url is string => typeof url === "string" && url.length > 0)
    .map(databaseIdentity);
}

/**
 * The partner dashboard's world (Phase 7 Track B): a partner who can log in (a random password,
 * printed for Playwright; the database is disposable), one verified hotel business with approved
 * documents and a payout account, and an approved room with availability. It is a different
 * owner from the fixture's providers, so the fixture's listings are "another partner's data".
 */
async function createPartnerWorld(prisma: PrismaClient, world: World) {
  const s = world.suffix;
  const password = randomBytes(18).toString("base64url");
  const partner = await prisma.user.create({
    data: {
      email: `partner-${s}@test.local`,
      fullName: `Maya Gurung ${s}`,
      role: "PARTNER",
      passwordHash: await hashPassword(password),
    },
  });
  const provider = await prisma.provider.create({
    data: {
      providerTypeCode: "hotel",
      ownerUserId: partner.id,
      legalName: `Lakeside Homestay ${s} Pvt. Ltd.`,
      displayName: `Lakeside Homestay ${s}`,
      status: "VERIFIED",
      verifiedAt: new Date(),
    },
  });
  for (const documentType of ["OWNER_ID", "LOCAL_GOVERNMENT_REGISTRATION"] as const) {
    await prisma.providerDocument.create({
      data: {
        providerId: provider.id,
        documentType,
        status: "APPROVED",
        storageKey: `documents/e2e-${s}/${documentType.toLowerCase()}`,
        ...seededFileFields(`e2e-${s}-${documentType.toLowerCase()}`),
        mimeType: "application/pdf",
        sizeBytes: 120_000,
        reviewedAt: new Date(),
      },
    });
  }
  await prisma.providerPayoutAccount.create({
    data: {
      providerId: provider.id,
      bankName: "Nabil Bank",
      accountName: `Lakeside Homestay ${s}`,
      accountNumber: "00112233444321",
      isDefault: true,
    },
  });
  const hotel = await prisma.listing.create({
    data: {
      providerId: provider.id,
      listingTypeCode: "hotel",
      title: `Lakeside Homestay ${s}`,
      slug: `lakeside-homestay-${s}`,
      status: "APPROVED",
      locationId: world.locations.town.id,
      basePriceMinor: 0n,
    },
  });
  const room = await prisma.listing.create({
    data: {
      providerId: provider.id,
      listingTypeCode: "hotel_room",
      title: `Lakeside Garden Room ${s}`,
      slug: `lakeside-garden-room-${s}`,
      status: "APPROVED",
      parentId: hotel.id,
      locationId: world.locations.village.id,
      basePriceMinor: 250_000n, // Rs 2,500 / night, no service charge or VAT
    },
  });
  await prisma.hotelRoomDetail.create({ data: { listingId: room.id, maxAdults: 2 } });
  // Two units on days 0–3: each E2E project books one pay-at-property and one online night.
  for (let n = 0; n < 4; n++) {
    await prisma.inventorySlot.create({
      data: { listingId: room.id, serviceDate: toDbDate(world.day(n)), capacityTotal: 2 },
    });
  }
  return {
    partnerEmail: partner.email!,
    partnerPassword: password,
    partnerName: partner.fullName,
    businessName: provider.displayName,
    partnerRoomId: room.id,
    partnerRoomTitle: room.title,
    partnerHotelTitle: hotel.title,
  };
}

/**
 * The admin console's world (Phase 7 Track C): an admin and a customer who can log in (random
 * passwords; disposable database), and for EACH Playwright project (desktop, mobile) one hotel
 * provider waiting for verification with every required document, and one missing the
 * registration document. Each project decides on its own pair, so the projects never collide.
 */
async function createAdminWorld(prisma: PrismaClient, world: World) {
  const s = world.suffix;
  const adminPassword = randomBytes(18).toString("base64url");
  const customerPassword = randomBytes(18).toString("base64url");
  const admin = await prisma.user.create({
    data: {
      email: `admin-${s}@test.local`,
      fullName: `Anita Admin ${s}`,
      role: "ADMIN",
      passwordHash: await hashPassword(adminPassword),
    },
  });
  const customer = await prisma.user.create({
    data: {
      email: `customer-${s}@test.local`,
      fullName: `Hari Traveller ${s}`,
      passwordHash: await hashPassword(customerPassword),
    },
  });

  const pendingProvider = async (name: string, documentTypes: ProviderDocumentType[]) => {
    const owner = await prisma.user.create({
      data: {
        email: `${name.toLowerCase().replace(/\W+/g, "-")}@test.local`,
        fullName: `Owner of ${name}`,
        role: "PARTNER",
      },
    });
    const provider = await prisma.provider.create({
      data: {
        providerTypeCode: "hotel",
        ownerUserId: owner.id,
        legalName: `${name} Pvt. Ltd.`,
        displayName: name,
        status: "PENDING_VERIFICATION",
      },
    });
    for (const documentType of documentTypes) {
      await prisma.providerDocument.create({
        data: {
          providerId: provider.id,
          documentType,
          storageKey: `documents/${provider.id}/seeded/${documentType.toLowerCase()}`,
          mimeType: "application/pdf",
          sizeBytes: 90_000,
          status: "PENDING",
          ...seededFileFields(`e2e-${provider.id}-${documentType.toLowerCase()}`),
        },
      });
    }
    await prisma.providerPayoutAccount.create({
      data: {
        providerId: provider.id,
        bankName: "Global IME Bank",
        accountName: name,
        accountNumber: "99887766551234",
        isDefault: true,
      },
    });
    return { id: provider.id, name };
  };

  const pairs: Record<
    string,
    { complete: { id: string; name: string }; incomplete: { id: string; name: string } }
  > = {};
  for (const label of ["desktop", "mobile"]) {
    pairs[label] = {
      complete: await pendingProvider(`Complete Lodge ${label} ${s}`, [
        "OWNER_ID",
        "BUSINESS_REGISTRATION",
      ]),
      incomplete: await pendingProvider(`Incomplete Inn ${label} ${s}`, ["OWNER_ID"]),
    };
  }
  return {
    adminEmail: admin.email!,
    adminPassword,
    adminName: admin.fullName,
    customerEmail: customer.email!,
    customerPassword,
    hotelProviderId: world.providers.hotelProvider.id,
    adminProviders: pairs,
  };
}

/**
 * Phase 10's world (gaps 23 and 14), for EACH Playwright project so they never collide:
 * - a verified hotel partner with an approved, bookable room and no cancellation policy yet
 *   (the journey creates one, attaches it, and a customer sees and books it);
 * - a DRAFT hotel partner whose owner ID is already submitted (seeded: a file is recorded but no
 *   object is stored) and whose registration is missing: the journey uploads it, submits for
 *   verification, and an admin opens the file and approves.
 * One random password for these partners (disposable database).
 */
async function createPhase10World(prisma: PrismaClient, world: World) {
  const s = world.suffix;
  const password = randomBytes(18).toString("base64url");
  const passwordHash = await hashPassword(password);
  const perProject = async (label: "desktop" | "mobile") => {
    const policyOwner = await prisma.user.create({
      data: {
        email: `policy-${label}-${s}@test.local`,
        fullName: `Sita Policy ${label} ${s}`,
        role: "PARTNER",
        passwordHash,
      },
    });
    const policyProvider = await prisma.provider.create({
      data: {
        providerTypeCode: "hotel",
        ownerUserId: policyOwner.id,
        legalName: `Fewa Policy Lodge ${label} ${s} Pvt. Ltd.`,
        displayName: `Fewa Policy Lodge ${label} ${s}`,
        status: "VERIFIED",
        verifiedAt: new Date(),
      },
    });
    const hotel = await prisma.listing.create({
      data: {
        providerId: policyProvider.id,
        listingTypeCode: "hotel",
        title: `Fewa Policy Lodge ${label} ${s}`,
        slug: `fewa-policy-lodge-${label}-${s}`,
        status: "APPROVED",
        locationId: world.locations.town.id,
        basePriceMinor: 0n,
      },
    });
    const room = await prisma.listing.create({
      data: {
        providerId: policyProvider.id,
        listingTypeCode: "hotel_room",
        title: `Fewa Policy Room ${label} ${s}`,
        slug: `fewa-policy-room-${label}-${s}`,
        status: "APPROVED",
        parentId: hotel.id,
        locationId: world.locations.village.id,
        basePriceMinor: 300_000n,
      },
    });
    await prisma.hotelRoomDetail.create({ data: { listingId: room.id, maxAdults: 2 } });
    for (let n = 0; n < 4; n++) {
      await prisma.inventorySlot.create({
        data: { listingId: room.id, serviceDate: toDbDate(world.day(n)), capacityTotal: 5 },
      });
    }

    const docsOwner = await prisma.user.create({
      data: {
        email: `docs-${label}-${s}@test.local`,
        fullName: `Ram Documents ${label} ${s}`,
        role: "PARTNER",
        passwordHash,
      },
    });
    const docsProvider = await prisma.provider.create({
      data: {
        providerTypeCode: "hotel",
        ownerUserId: docsOwner.id,
        legalName: `Annapurna Docs Homestay ${label} ${s} Pvt. Ltd.`,
        displayName: `Annapurna Docs Homestay ${label} ${s}`,
        status: "DRAFT",
      },
    });
    await prisma.providerDocument.create({
      data: {
        providerId: docsProvider.id,
        documentType: "OWNER_ID",
        storageKey: `documents/${docsProvider.id}/seeded/owner_id`,
        mimeType: "application/pdf",
        sizeBytes: 90_000,
        status: "PENDING",
        ...seededFileFields(`e2e-docs-${label}-${s}-owner-id`),
      },
    });
    return {
      policyPartnerEmail: policyOwner.email!,
      policyRoomId: room.id,
      policyRoomTitle: room.title,
      docsPartnerEmail: docsOwner.email!,
      docsProviderId: docsProvider.id,
      docsProviderName: docsProvider.displayName,
    };
  };
  return {
    phase10Password: password,
    phase10: { desktop: await perProject("desktop"), mobile: await perProject("mobile") },
  };
}

/**
 * The online payment journeys' world (Phase 11, ADR 0017): one customer per Playwright project and
 * gateway, so parallel journeys never share a trip basket. One random password (disposable
 * database); logging in spends no registration quota.
 */
async function createPaymentsWorld(prisma: PrismaClient) {
  const password = randomBytes(18).toString("base64url");
  const passwordHash = await hashPassword(password);
  const s = randomBytes(4).toString("hex");
  const paymentCustomers: Record<string, Record<string, string>> = {};
  for (const project of ["desktop-chromium", "mobile-chromium"]) {
    paymentCustomers[project] = {};
    for (const gateway of ["esewa", "khalti"]) {
      const user = await prisma.user.create({
        data: {
          email: `pay-${gateway}-${project}-${s}@test.local`,
          fullName: `Payer ${gateway} ${project}`,
          passwordHash,
          role: "CUSTOMER",
        },
      });
      paymentCustomers[project][gateway] = user.email!;
    }
  }
  return { paymentCustomers, paymentPassword: password };
}

/**
 * Phase 12 journeys (ADR 0018), per Playwright project: an admin of its own (login limits are per
 * email), a partner (one provider, a VERIFIED bank account) with
 * - a listing waiting for review;
 * - a booking paid online whose service ended last month (eligible for that month's payout);
 * and a late payment (recorded by Phase 11's reconciliation) with a refund request on it.
 */
async function createPhase12World(prisma: PrismaClient, world: World) {
  const password = randomBytes(18).toString("base64url");
  const passwordHash = await hashPassword(password);
  const today = todayInKathmandu();
  // The 10th of last month: its service is over, and it is in last month's payout.
  const [y, m] = today.split("-").map(Number) as [number, number];
  const lastMonth = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
  const serviceDate = `${lastMonth}-10`;
  const out: Record<string, unknown> = {};
  for (const [project, lateAmount] of [
    ["desktop", 123_400n],
    ["mobile", 234_500n],
  ] as const) {
    const s = `${world.suffix}-${project}`;
    const admin = await prisma.user.create({
      data: {
        email: `p12-admin-${s}@test.local`,
        fullName: `Phase 12 Admin ${project}`,
        role: "ADMIN",
        passwordHash,
      },
    });
    const owner = await prisma.user.create({
      data: {
        email: `p12-partner-${s}@test.local`,
        fullName: `Guide owner ${project}`,
        role: "PARTNER",
        passwordHash,
      },
    });
    const provider = await prisma.provider.create({
      data: {
        providerTypeCode: "guide",
        ownerUserId: owner.id,
        legalName: `Phase 12 Guides ${s}`,
        displayName: `Phase 12 Guides ${project} ${world.suffix}`,
        status: "VERIFIED",
        verifiedAt: new Date(),
      },
    });
    await prisma.providerPayoutAccount.create({
      data: {
        providerId: provider.id,
        bankName: "Nabil Bank",
        accountName: `Phase 12 Guides ${project}`,
        accountNumber: project === "desktop" ? "0100000000001111" : "0100000000002222",
        isDefault: true,
        verifiedAt: new Date(),
      },
    });
    const guide = await prisma.listing.create({
      data: {
        providerId: provider.id,
        listingTypeCode: "guide_service",
        title: `Annapurna guide ${project} ${world.suffix}`,
        slug: `p12-guide-${s}`,
        basePriceMinor: 400_000n,
        status: "APPROVED",
        locationId: world.locations.town.id,
      },
    });
    const pending = await prisma.listing.create({
      data: {
        providerId: provider.id,
        listingTypeCode: "guide_service",
        title: `Langtang guide ${project} ${world.suffix}`,
        slug: `p12-pending-${s}`,
        basePriceMinor: 350_000n,
        status: "PENDING_REVIEW",
        locationId: world.locations.town.id,
      },
    });

    // A completed, online-paid booking last month (one guide day).
    const charges = calculateItemCharges({
      lines: [{ units: 1, unitPriceMinor: guide.basePriceMinor }],
      commissionRateBps: resolveCommissionRateBps({}),
    });
    const totals = summarizeTrip("NPR", [{ ...charges, currency: "NPR" }]);
    const trip = await prisma.trip.create({
      data: {
        reference: `MS-P12${randomBytes(4).toString("hex").toUpperCase()}`,
        customerId: world.users.customer.id,
        status: "COMPLETED",
        currency: "NPR",
        subtotalMinor: totals.subtotalMinor,
        serviceChargeMinor: totals.serviceChargeMinor,
        taxMinor: totals.taxMinor,
        totalMinor: totals.totalMinor,
        commissionTotalMinor: totals.commissionTotalMinor,
        confirmedAt: new Date(),
      },
    });
    const item = await prisma.bookingItem.create({
      data: {
        tripId: trip.id,
        listingId: guide.id,
        providerId: provider.id,
        listingTypeCode: "guide_service",
        status: "COMPLETED",
        startDate: toDbDate(serviceDate),
        quantity: charges.quantity,
        subtotalMinor: charges.subtotalMinor,
        serviceChargeRateBps: charges.serviceChargeRateBps,
        serviceChargeMinor: charges.serviceChargeMinor,
        taxRateBps: charges.taxRateBps,
        taxMinor: charges.taxMinor,
        totalMinor: charges.totalMinor,
        commissionRateBps: charges.commissionRateBps,
        commissionMinor: charges.commissionMinor,
        providerPayoutMinor: charges.providerPayoutMinor,
        confirmedAt: new Date(),
        completedAt: new Date(),
        slots: {
          create: charges.lines.map((line) => ({
            serviceDate: toDbDate(serviceDate),
            units: line.units,
            unitPriceMinor: line.unitPriceMinor,
            amountMinor: line.amountMinor,
          })),
        },
      },
    });
    await prisma.payment.create({
      data: {
        tripId: trip.id,
        gateway: "simulated",
        status: "SUCCEEDED",
        amountMinor: charges.totalMinor,
        capturedMinor: charges.totalMinor,
        gatewayTransactionId: `P12-SIM-${s}`,
        completedAt: new Date(),
        allocations: { create: [{ bookingItemId: item.id, amountMinor: charges.totalMinor }] },
      },
    });
    await prisma.bookingItem.update({ where: { id: item.id }, data: { paymentStatus: "PAID" } });

    // A late Khalti payment: the hold had expired; recorded for reconciliation, with a refund request.
    const lateTrip = await prisma.trip.create({
      data: {
        reference: `MS-P12${randomBytes(4).toString("hex").toUpperCase()}`,
        customerId: world.users.customer.id,
        status: "EXPIRED",
        currency: "NPR",
      },
    });
    const latePayment = await prisma.payment.create({
      data: {
        tripId: lateTrip.id,
        gateway: "khalti",
        status: "CANCELLED",
        amountMinor: lateAmount,
        gatewayReference: `p12pidx${randomBytes(6).toString("hex")}`,
        completedAt: new Date(),
      },
    });
    const reconciliation = await prisma.paymentReconciliation.create({
      data: {
        paymentId: latePayment.id,
        tripId: lateTrip.id,
        gateway: "khalti",
        gatewayTransactionId: `P12-KT-${s}`,
        amountMinor: lateAmount,
        currency: "NPR",
        reason: "PAYMENT_NOT_OPEN",
        gatewayResponse: { status: "Completed" },
      },
    });
    await prisma.refundRequest.create({
      data: {
        paymentId: latePayment.id,
        paymentReconciliationId: reconciliation.id,
        gateway: "khalti",
        amountMinor: lateAmount,
        currency: "NPR",
        reason: `Paid after the hold expired (${project} ${world.suffix})`,
        requestedById: admin.id,
      },
    });

    out[project] = {
      adminEmail: admin.email,
      partnerEmail: owner.email,
      providerId: provider.id,
      pendingListingId: pending.id,
      pendingListingTitle: pending.title,
      payoutPeriod: lastMonth,
      payoutNetMinor: charges.providerPayoutMinor.toString(),
      lateAmountMinor: lateAmount.toString(),
      lateTripReference: lateTrip.reference,
      lateRefundReason: `Paid after the hold expired (${project} ${world.suffix})`,
    };
  }
  return { phase12Password: password, phase12: out };
}

async function main(): Promise<void> {
  const url = process.env.E2E_DATABASE_URL;
  if (!url) throw new Error("E2E_DATABASE_URL is not set.");
  if (devDatabaseIdentities().includes(databaseIdentity(url))) {
    throw new Error(
      "Refusing to seed: E2E_DATABASE_URL points at the dev database (apps/api/.env).",
    );
  }

  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    cwd: API_ROOT,
    env: {
      ...process.env,
      MEROSTAY_SKIP_ENV_FILE: "1",
      DATABASE_URL: url,
      DATABASE_URL_UNPOOLED: "",
    },
    stdio: "pipe",
  });

  const prisma = createPrismaClient(url);
  try {
    const world = await createWorld(prisma);
    const partnerWorld = await createPartnerWorld(prisma, world);
    const adminWorld = await createAdminWorld(prisma, world);
    const phase10World = await createPhase10World(prisma, world);
    const paymentsWorld = await createPaymentsWorld(prisma);
    const phase12World = await createPhase12World(prisma, world);
    console.log(
      JSON.stringify({
        ...partnerWorld,
        ...adminWorld,
        ...phase10World,
        ...paymentsWorld,
        ...phase12World,
        provinceSlug: world.locations.province.slug,
        roomId: world.listings.room.id,
        roomTitle: world.listings.room.title,
        busId: world.listings.bus.id,
        busTitle: world.listings.bus.title,
        days: [0, 1, 2, 3, 10, 11, 12, 13, 14, 15].map((n) => world.day(n)),
      }),
    );
  } finally {
    await prisma.$disconnect();
  }
}

await main();
