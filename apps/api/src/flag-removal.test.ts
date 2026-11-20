import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Phase 4 removed the temporary ALLOW_UNAUTHENTICATED_TRIPS_API flag (ADR 0006). This test fails
 * if it reappears anywhere in tracked code, configuration or current documentation.
 *
 * Excluded on purpose: historical records that describe what existed at the time (ADR 0005 and the
 * Phase 3 report, both marked as superseded) and the tests that assert its absence.
 *
 * Checks tracked AND untracked (non-ignored) files, so a new file cannot slip past before it is
 * committed.
 */
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FLAG = ["ALLOW", "UNAUTHENTICATED", "TRIPS", "API"].join("_");
const HISTORICAL = new Set([
  "docs/architecture/decisions/0005-search-and-booking-api-conventions.md",
  "docs/phases/phase-03-search-booking-api.md",
]);
const ABSENCE_TESTS = new Set([
  "apps/api/src/flag-removal.test.ts",
  "apps/api/src/modules/auth/auth.unit.test.ts", // asserts the env parser ignores it
]);

describe("the unauthenticated trips flag is gone", () => {
  it("is not referenced in any tracked file except historical records", () => {
    const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    })
      .split("\n")
      .filter(
        (file) =>
          file &&
          !HISTORICAL.has(file) &&
          !ABSENCE_TESTS.has(file) &&
          !/\.(png|jpg|ico|svg|woff2?)$/.test(file),
      );
    expect(files.length).toBeGreaterThan(50); // really scanned the repository
    const offenders = files.filter((file) => {
      try {
        return readFileSync(`${REPO_ROOT}${file}`, "utf8").includes(FLAG);
      } catch {
        return false; // deleted in the working tree
      }
    });
    expect(offenders).toEqual([]);
  });

  it("the historical records point to its removal", () => {
    for (const file of HISTORICAL) {
      expect(readFileSync(`${REPO_ROOT}${file}`, "utf8")).toMatch(/ADR 0006/);
    }
  });
});
