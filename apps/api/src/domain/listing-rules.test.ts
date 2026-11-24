import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { decideListingType, usableListingTypes, type ProviderTypeRules } from "./listing-rules.js";

const tourOperator: ProviderTypeRules = {
  code: "tour_operator",
  isActive: true,
  allowedListingTypes: [
    { code: "tour", isActive: true },
    { code: "activity", isActive: true },
  ],
};

describe("listing-type rules (ADR 0013): mapped AND both types active", () => {
  it("a mapped, active pair is allowed; the usable list is sorted", () => {
    expect(decideListingType(tourOperator, { code: "tour", isActive: true })).toEqual({ ok: true });
    expect(usableListingTypes(tourOperator)).toEqual(["activity", "tour"]);
  });

  it("an unmapped type is not allowed and the error names what is", () => {
    expect(decideListingType(tourOperator, { code: "hotel_room", isActive: true })).toEqual({
      ok: false,
      code: "LISTING_TYPE_NOT_ALLOWED",
      reason: "not_mapped",
      usable: ["activity", "tour"],
    });
  });

  it("an inactive listing type is not offered, even when mapped (and drops out of the usable list)", () => {
    const rules = {
      ...tourOperator,
      allowedListingTypes: [
        { code: "tour", isActive: true },
        { code: "activity", isActive: false },
      ],
    };
    expect(decideListingType(rules, { code: "activity", isActive: false })).toMatchObject({
      ok: false,
      code: "LISTING_TYPE_NOT_OFFERED",
      usable: ["tour"],
    });
    expect(decideListingType(rules, null)).toMatchObject({ code: "LISTING_TYPE_NOT_OFFERED" });
  });

  it("an inactive provider type may list nothing, even mapped and active types", () => {
    const airline: ProviderTypeRules = {
      code: "airline",
      isActive: false,
      allowedListingTypes: [{ code: "flight_ticket", isActive: true }],
    };
    expect(usableListingTypes(airline)).toEqual([]);
    expect(decideListingType(airline, { code: "flight_ticket", isActive: true })).toEqual({
      ok: false,
      code: "LISTING_TYPE_NOT_ALLOWED",
      reason: "provider_type_not_offered",
      usable: [],
    });
    expect(usableListingTypes({ ...airline, isActive: true })).toEqual(["flight_ticket"]);
  });
});

/**
 * Gap 22's "data, not code" rule, checked on the source: provider-type codes never appear as
 * string literals in application code (API or web). Listing-type codes appear only in the
 * per-vertical DETAIL descriptors that ADR 0004 sanctions (which fields a type's detail table has);
 * never in rules, enforcement or UI choices. The codes are read from the migrations, so a new
 * type is covered automatically.
 */
describe("no provider-type or listing-type names in application code", () => {
  const appsRoot = join(__dirname, "..", "..", "..");
  const migrations = join(appsRoot, "api", "prisma", "migrations");
  const sql = readdirSync(migrations, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => readFileSync(join(migrations, e.name, "migration.sql"), "utf8"))
    .join("\n");

  function seededCodes(table: string): string[] {
    const block = new RegExp(`INSERT INTO "${table}"[^;]*;`, "g");
    const codes = [...sql.matchAll(block)].flatMap((m) =>
      [...m[0].matchAll(/\(\s*'([a-z_]+)'/g)].map((c) => c[1]!),
    );
    return [...new Set(codes)];
  }
  const providerTypes = seededCodes("provider_types");
  const listingTypes = seededCodes("listing_types");

  /** Detail-table descriptors (ADR 0004): the only files allowed to name listing types. */
  const DETAIL_DESCRIPTORS = new Set([
    "api/src/modules/listings/listing-details.ts",
    "web/src/lib/listing-forms.ts",
  ]);

  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const path = join(dir, e.name);
      if (e.isDirectory())
        return /generated|testing|node_modules/.test(e.name) ? [] : sources(path);
      if (!/\.tsx?$/.test(e.name) || /\.test\.ts$/.test(e.name)) return [];
      return /\/db\/seed\.ts$/.test(path) ? [] : [path]; // sample data, not application code
    });
  }
  const files = [
    ...sources(join(appsRoot, "api", "src")),
    ...sources(join(appsRoot, "web", "src")),
  ];
  const literal = (code: string) => new RegExp(`["'\`]${code}["'\`]`);

  it("reads the type codes from the migrations", () => {
    expect(providerTypes.length).toBeGreaterThanOrEqual(5);
    expect(listingTypes.length).toBeGreaterThanOrEqual(5);
    expect(files.length).toBeGreaterThan(80);
  });

  it("no provider-type code anywhere in API or web code", () => {
    const hits = files.flatMap((file) => {
      const src = readFileSync(file, "utf8");
      return providerTypes
        .filter((c) => literal(c).test(src))
        .map((c) => `${relative(appsRoot, file)}: ${c}`);
    });
    expect(hits).toEqual([]);
  });

  it("listing-type codes only in the detail descriptors (never in rules or UI choices)", () => {
    const hits = files.flatMap((file) => {
      const rel = relative(appsRoot, file);
      if (DETAIL_DESCRIPTORS.has(rel)) return [];
      const src = readFileSync(file, "utf8");
      return listingTypes.filter((c) => literal(c).test(src)).map((c) => `${rel}: ${c}`);
    });
    expect(hits).toEqual([]);
  });
});
