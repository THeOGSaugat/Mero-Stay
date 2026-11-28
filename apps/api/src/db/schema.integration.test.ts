import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../lib/prisma.js";
import { testDatabaseCliEnv } from "../testing/global-setup.js";
import { API_ROOT, resolveTestDatabase } from "../testing/test-database.js";

const prisma = createPrismaClient(resolveTestDatabase().pooledUrl);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("migrations", () => {
  it("every migration in prisma/migrations applied cleanly", async () => {
    const onDisk = readdirSync(`${API_ROOT}prisma/migrations`, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    const applied = await prisma.$queryRaw<
      { migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }[]
    >`SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY migration_name`;

    expect(applied.map((m) => m.migration_name)).toEqual(onDisk);
    for (const migration of applied) {
      expect(migration.finished_at).not.toBeNull();
      expect(migration.rolled_back_at).toBeNull();
    }
  });

  it("the migrated database matches schema.prisma exactly (no drift)", () => {
    // Exit code 0 = no differences, 2 = differences. execFileSync throws on non-zero.
    expect(() =>
      execFileSync(
        "npx",
        [
          "prisma",
          "migrate",
          "diff",
          "--from-config-datasource",
          "--to-schema=prisma/schema.prisma",
          "--exit-code",
        ],
        { cwd: API_ROOT, env: testDatabaseCliEnv(), stdio: "pipe" },
      ),
    ).not.toThrow();
  });

  it("creates every core and detail table", async () => {
    const rows = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name <> '_prisma_migrations'`;
    expect(rows.map((r) => r.table_name).sort()).toEqual(
      [
        "activity_details",
        "admin_setup_tokens",
        "audit_log",
        "booking_item_slots",
        "booking_items",
        "bus_route_details",
        "cancellation_policies",
        "flight_route_details",
        "guide_service_details",
        "hotel_details",
        "hotel_room_details",
        "idempotency_keys",
        "inventory_slots",
        "listing_types",
        "listings",
        "locations",
        "notifications",
        "payment_allocations",
        "payment_gateway_checks",
        "payment_reconciliations",
        "payments",
        "payouts",
        "provider_clawback_recoveries",
        "provider_clawbacks",
        "provider_documents",
        "provider_invoice_adjustments",
        "provider_invoices",
        "provider_payout_accounts",
        "provider_type_listing_types",
        "provider_type_required_documents",
        "provider_types",
        "providers",
        "refund_requests",
        "reviews",
        "sessions",
        "settlement_reconciliation_resolutions",
        "tour_details",
        "trips",
        "users",
      ].sort(),
    );
  });
});

describe("reference data from the migration", () => {
  it("registers the verticals, with flights modelled but inactive", async () => {
    const types = await prisma.listingType.findMany({ orderBy: { code: "asc" } });
    expect(types.map((t) => [t.code, t.unitLabel, t.isBookable, t.isActive])).toEqual([
      ["activity", "person", true, true],
      ["bus_ticket", "seat", true, true],
      ["flight_ticket", "seat", true, false],
      ["guide_service", "day", true, true],
      ["hotel", "property", false, true],
      ["hotel_room", "night", true, true],
      ["tour", "person", true, true],
    ]);
  });

  it("registers provider types", async () => {
    const codes = (await prisma.providerType.findMany()).map((t) => t.code).sort();
    expect(codes).toEqual(
      ["activity_operator", "airline", "bus_operator", "guide", "hotel", "tour_operator"].sort(),
    );
  });
});
