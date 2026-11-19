import { afterEach, describe, expect, it, vi } from "vitest";
import { databaseIdentity, resolveTestDatabase } from "./test-database.js";

// No env files: these tests must not depend on whether the developer has apps/api/.env(.test).
const noFiles = { testFile: {}, devFile: {} };

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
  it("refuses when the dev database is only configured in apps/api/.env", () => {
    vi.stubEnv("TEST_DATABASE_URL", "postgresql://u:p@ep-same-pooler.r.aws.neon.tech/db");
    vi.stubEnv("DATABASE_URL", "");
    expect(() =>
      resolveTestDatabase({
        testFile: {},
        devFile: { DATABASE_URL: "postgresql://u:p@ep-same.r.aws.neon.tech/db" },
      }),
    ).toThrow(/Refusing to run/);
  });

  it("prefers an explicit TEST_DATABASE_URL_UNPOOLED from apps/api/.env.test", () => {
    vi.stubEnv("TEST_DATABASE_URL", "");
    vi.stubEnv("TEST_DATABASE_URL_UNPOOLED", "");
    const db = resolveTestDatabase({
      testFile: {
        TEST_DATABASE_URL: "postgresql://u:p@ep-t-pooler.r.aws.neon.tech/db",
        TEST_DATABASE_URL_UNPOOLED: "postgresql://u:p@ep-t.r.aws.neon.tech/db",
      },
      devFile: {},
    });
    expect(new URL(db.directUrl).hostname).toBe("ep-t.r.aws.neon.tech");
  });

  it("refuses when the test database is the dev database", () => {
    vi.stubEnv("TEST_DATABASE_URL", "postgresql://u:p@ep-same-pooler.r.aws.neon.tech/db");
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@ep-same.r.aws.neon.tech/db");
    expect(() => resolveTestDatabase(noFiles)).toThrow(/Refusing to run/);
  });

  it("never mixes sources: an environment pooled URL ignores a direct URL from .env.test", () => {
    vi.stubEnv("TEST_DATABASE_URL", "postgresql://u:p@ep-env-pooler.r.aws.neon.tech/db");
    vi.stubEnv("TEST_DATABASE_URL_UNPOOLED", "");
    const db = resolveTestDatabase({
      testFile: { TEST_DATABASE_URL_UNPOOLED: "postgresql://u:p@ep-OTHER.r.aws.neon.tech/db" },
      devFile: {},
    });
    expect(new URL(db.directUrl).hostname).toBe("ep-env.r.aws.neon.tech");
  });

  it("refuses when the pooled and direct URLs are different databases", () => {
    vi.stubEnv("TEST_DATABASE_URL", "postgresql://u:p@ep-a-pooler.r.aws.neon.tech/db");
    vi.stubEnv("TEST_DATABASE_URL_UNPOOLED", "postgresql://u:p@ep-b.r.aws.neon.tech/db");
    expect(() => resolveTestDatabase(noFiles)).toThrow(/different databases/);
  });

  it("derives the direct URL for a separate test branch", () => {
    vi.stubEnv(
      "TEST_DATABASE_URL",
      "postgresql://u:p@ep-guard-unit-test-pooler.r.aws.neon.tech/db",
    );
    vi.stubEnv("TEST_DATABASE_URL_UNPOOLED", "");
    const db = resolveTestDatabase(noFiles);
    expect(new URL(db.directUrl).hostname).toBe("ep-guard-unit-test.r.aws.neon.tech");
  });
});
