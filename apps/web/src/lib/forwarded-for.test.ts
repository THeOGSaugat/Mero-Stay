import { describe, expect, it } from "vitest";
import { appendForwardedFor } from "./forwarded-for.mts";

describe("gap 5: the web server appends the connecting address to X-Forwarded-For", () => {
  it("starts the header when the client sent none", () => {
    expect(appendForwardedFor(undefined, "203.0.113.10")).toBe("203.0.113.10");
    expect(appendForwardedFor("  ", "::1")).toBe("::1");
  });

  it("appends after whatever the client wrote; never overwrites or drops it", () => {
    expect(appendForwardedFor("198.51.100.7", "203.0.113.10")).toBe("198.51.100.7, 203.0.113.10");
    expect(appendForwardedFor(["1.1.1.1", "2.2.2.2"], "203.0.113.10")).toBe(
      "1.1.1.1, 2.2.2.2, 203.0.113.10",
    );
  });

  it("an unknown peer still ends the header, so a forged entry is never last", () => {
    expect(appendForwardedFor("198.51.100.7", undefined)).toBe("198.51.100.7, unknown");
    expect(appendForwardedFor(undefined, "")).toBe("unknown");
  });
});
