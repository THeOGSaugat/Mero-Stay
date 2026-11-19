import { afterEach, describe, expect, it, vi } from "vitest";
import { databaseIdentity, resolveTestDatabase } from "./test-database.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("databaseIdentity", () => {
  it("treats a Neon pooled and direct URL of the same database as the same database", () => {
    expect(
      databaseIdentity("postgresql://u:p@ep-a-pooler.r.aws.neon.tech/db?sslmode=require"),
    ).toBe(databaseIdentity("postgresql://u:other@ep-a.r.aws.neon.tech/db"));
  });

  it("distinguishes branches (different endpoint) and databases", () => {
    const dev = databaseIdentity("postgresql://u:p@ep-dev.r.aws.neon.tech/db");
    expect(databaseIdentity("postgresql://u:p@ep-test.r.aws.neon.tech/db")).not.toBe(dev);
    expect(databaseIdentity("postgresql://u:p@ep-dev.r.aws.neon.tech/other")).not.toBe(dev);
  });
});

describe("resolveTestDatabase safety guard", () => {
  it("refuses when the test database is the dev database", () => {
    vi.stubEnv("TEST_DATABASE_URL", "postgresql://u:p@ep-same-pooler.r.aws.neon.tech/db");
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@ep-same.r.aws.neon.tech/db");
    expect(() => resolveTestDatabase()).toThrow(/Refusing to run/);
  });

  it("derives the direct URL for a separate test branch", () => {
    vi.stubEnv(
      "TEST_DATABASE_URL",
      "postgresql://u:p@ep-guard-unit-test-pooler.r.aws.neon.tech/db",
    );
    vi.stubEnv("TEST_DATABASE_URL_UNPOOLED", "");
    const db = resolveTestDatabase();
    expect(new URL(db.directUrl).hostname).toBe("ep-guard-unit-test.r.aws.neon.tech");
  });
});
