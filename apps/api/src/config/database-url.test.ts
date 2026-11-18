import { describe, expect, it } from "vitest";
import { deriveDirectUrl, resolveDirectUrl } from "./database-url.js";

const pooled =
  "postgresql://neon_user:p%40ss@ep-cool-name-123456-pooler.eu-central-1.aws.neon.tech/mydb?sslmode=require&channel_binding=require";

describe("deriveDirectUrl", () => {
  it("removes -pooler from the host and keeps everything else", () => {
    const direct = new URL(deriveDirectUrl(pooled));
    expect(direct.hostname).toBe("ep-cool-name-123456.eu-central-1.aws.neon.tech");
    expect(direct.username).toBe("neon_user");
    expect(direct.password).toBe("p%40ss");
    expect(direct.pathname).toBe("/mydb");
    expect(direct.searchParams.get("sslmode")).toBe("require");
    expect(direct.searchParams.get("channel_binding")).toBe("require");
  });

  it("leaves an already-direct URL unchanged", () => {
    const direct =
      "postgresql://u:p@ep-cool-name-123456.eu-central-1.aws.neon.tech/db?sslmode=require";
    expect(new URL(deriveDirectUrl(direct)).hostname).toBe(
      "ep-cool-name-123456.eu-central-1.aws.neon.tech",
    );
  });

  it("only changes the '-pooler' host label, not a database or user named pooler", () => {
    const url = "postgresql://my-pooler:pw@ep-x-pooler.r.aws.neon.tech/my-pooler-db";
    const direct = new URL(deriveDirectUrl(url));
    expect(direct.hostname).toBe("ep-x.r.aws.neon.tech");
    expect(direct.username).toBe("my-pooler");
    expect(direct.pathname).toBe("/my-pooler-db");
  });
});

describe("resolveDirectUrl", () => {
  it("prefers an explicit DATABASE_URL_UNPOOLED", () => {
    expect(
      resolveDirectUrl({ DATABASE_URL: pooled, DATABASE_URL_UNPOOLED: "postgresql://x/y" }),
    ).toBe("postgresql://x/y");
  });

  it("derives it from DATABASE_URL when not set", () => {
    expect(new URL(resolveDirectUrl({ DATABASE_URL: pooled })!).hostname).toBe(
      "ep-cool-name-123456.eu-central-1.aws.neon.tech",
    );
  });

  it("returns undefined when nothing usable is configured", () => {
    expect(resolveDirectUrl({})).toBeUndefined();
    expect(resolveDirectUrl({ DATABASE_URL: "not a url" })).toBeUndefined();
  });
});
