import { describe, expect, it } from "vitest";
import { parseEnv } from "./env.js";

const validUrl = "postgresql://user:s3cret-pass@localhost:5432/merostay";

describe("parseEnv", () => {
  it("applies defaults when only DATABASE_URL is provided", () => {
    expect(parseEnv({ DATABASE_URL: validUrl })).toEqual({
      NODE_ENV: "development",
      PORT: 4000,
      LOG_LEVEL: "info",
      DATABASE_URL: validUrl,
    });
  });

  it("coerces PORT from a string", () => {
    expect(parseEnv({ DATABASE_URL: validUrl, PORT: "8080" }).PORT).toBe(8080);
  });

  it("rejects a missing DATABASE_URL", () => {
    expect(() => parseEnv({})).toThrow(/DATABASE_URL: is required/);
  });

  it("rejects a non-PostgreSQL DATABASE_URL without echoing its value", () => {
    const badUrl = "mysql://root:topsecret@localhost/db";
    let message = "";
    try {
      parseEnv({ DATABASE_URL: badUrl });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/DATABASE_URL: must be a postgresql:\/\/ connection string/);
    expect(message).not.toContain("topsecret");
  });

  it.each([
    ["PORT", "not-a-number"],
    ["PORT", "70000"],
    ["NODE_ENV", "staging"],
    ["LOG_LEVEL", "verbose"],
  ])("rejects invalid %s=%s", (key, value) => {
    expect(() => parseEnv({ DATABASE_URL: validUrl, [key]: value })).toThrow(
      new RegExp(`- ${key}:`),
    );
  });
});
