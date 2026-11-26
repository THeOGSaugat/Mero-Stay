/* eslint-disable no-console -- CLI script: prints the seeded world as JSON for Playwright. */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { randomBytes } from "node:crypto";
import { toDbDate } from "../domain/dates.js";
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
    console.log(
      JSON.stringify({
        ...partnerWorld,
        ...adminWorld,
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
