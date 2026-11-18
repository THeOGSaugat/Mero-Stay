import { describe, expect, it } from "vitest";
import { getApiBaseUrl } from "./config";

describe("getApiBaseUrl", () => {
  it("uses API_URL when provided", () => {
    expect(getApiBaseUrl({ API_URL: "https://api.merostay.example" })).toBe(
      "https://api.merostay.example",
    );
  });

  it("strips trailing slashes", () => {
    expect(getApiBaseUrl({ API_URL: "http://localhost:4000//" })).toBe("http://localhost:4000");
  });

  it("falls back to localhost in development", () => {
    expect(getApiBaseUrl({ NODE_ENV: "development" })).toBe("http://localhost:4000");
  });

  it("requires API_URL in production", () => {
    expect(() => getApiBaseUrl({ NODE_ENV: "production" })).toThrow(/API_URL must be set/);
  });

  it.each(["not a url", "localhost:4000"])("rejects invalid URL %j", (value) => {
    expect(() => getApiBaseUrl({ API_URL: value })).toThrow(/API_URL must/);
  });

  it("rejects non-http protocols", () => {
    expect(() => getApiBaseUrl({ API_URL: "ftp://example.com" })).toThrow(/http or https/);
  });
});
