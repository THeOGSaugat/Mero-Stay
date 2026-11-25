import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { parseEnv, trustProxyConfigFromEnv } from "../config/env.js";
import { createRateLimiter } from "../modules/auth/rate-limit.js";
import {
  clientIp,
  createProxyTrust,
  normalizeIp,
  NO_TRUSTED_PROXY,
  parseTrustedAddresses,
  rateLimitKeyForIp,
  type TrustProxyConfig,
} from "./client-ip.js";

/** A bare Express app with the same `trust proxy` wiring as createApp, echoing the client IP. */
function echoApp(config: TrustProxyConfig) {
  const app = express();
  app.set("trust proxy", createProxyTrust(config));
  app.get("/ip", (req, res) => {
    res.json({ ip: clientIp(req) ?? null, key: rateLimitKeyForIp(clientIp(req)) });
  });
  return app;
}

async function resolvedIp(config: TrustProxyConfig, xff?: string): Promise<string | null> {
  const req = request(echoApp(config)).get("/ip");
  const res = xff === undefined ? await req : await req.set("X-Forwarded-For", xff);
  return (res.body as { ip: string | null }).ip;
}

const WEB_SERVER: TrustProxyConfig = { hops: 1, addresses: ["loopback"] };
/** Supertest connects from loopback; trusting only this address makes loopback an untrusted source. */
const SOMEONE_ELSE: TrustProxyConfig = { hops: 1, addresses: ["192.0.2.1"] };

describe("client IP resolution (gap 5, ADR 0014)", () => {
  it("without a trusted proxy, X-Forwarded-For is ignored: the socket peer is the client", async () => {
    expect(await resolvedIp(NO_TRUSTED_PROXY)).toBe("127.0.0.1");
    expect(await resolvedIp(NO_TRUSTED_PROXY, "203.0.113.10")).toBe("127.0.0.1");
  });

  it("behind the trusted web server, the entry it appended is the client", async () => {
    expect(await resolvedIp(WEB_SERVER, "203.0.113.10")).toBe("203.0.113.10");
    // No header at all (a server-side call from the web server itself): the web server's address.
    expect(await resolvedIp(WEB_SERVER)).toBe("127.0.0.1");
  });

  it("entries a client forged to the left of the trusted hop are ignored", async () => {
    expect(await resolvedIp(WEB_SERVER, "1.1.1.1, 203.0.113.10")).toBe("203.0.113.10");
    expect(await resolvedIp(WEB_SERVER, "8.8.8.8, 9.9.9.9, 203.0.113.10")).toBe("203.0.113.10");
  });

  it("from an untrusted source, X-Forwarded-For is ignored entirely (direct calls cannot spoof)", async () => {
    expect(await resolvedIp(SOMEONE_ELSE, "203.0.113.10")).toBe("127.0.0.1");
    expect(await resolvedIp(SOMEONE_ELSE, "1.1.1.1, 203.0.113.10")).toBe("127.0.0.1");
  });

  it("with an edge in front of the web server (2 hops), the client is the entry the edge wrote", async () => {
    const edge: TrustProxyConfig = { hops: 2, addresses: ["loopback", "10.0.0.0/8"] };
    // client → edge (appends client) → web server (appends edge address) → API
    expect(await resolvedIp(edge, "6.6.6.6, 203.0.113.10, 10.0.0.5")).toBe("203.0.113.10");
    // A hop that is not a configured proxy address stops the walk there.
    expect(await resolvedIp(edge, "6.6.6.6, 203.0.113.10, 198.51.100.9")).toBe("198.51.100.9");
    // Trust never extends past the configured hop count, even through trusted addresses.
    expect(await resolvedIp(edge, "6.6.6.6, 10.0.0.7, 10.0.0.5")).toBe("10.0.0.7");
  });

  it("an IPv4-mapped peer address counts as IPv4 for trust and keys", () => {
    const trust = createProxyTrust(WEB_SERVER);
    expect(trust("::ffff:127.0.0.1", 0)).toBe(true);
    expect(trust("::1", 0)).toBe(true);
    expect(trust("127.0.0.1", 1)).toBe(false); // hop 1 is beyond 1 trusted hop
    expect(trust("not-an-ip", 0)).toBe(false);
    expect(createProxyTrust({ hops: 0, addresses: ["loopback"] })("127.0.0.1", 0)).toBe(false);
  });
});

describe("rate-limit keying", () => {
  it("normalises addresses", () => {
    expect(normalizeIp("::ffff:203.0.113.10")).toBe("203.0.113.10");
    expect(normalizeIp(" 2001:DB8::1 ")).toBe("2001:db8::1");
    expect(normalizeIp("fe80::1%en0")).toBe("fe80::1");
    expect(normalizeIp("unknown")).toBeUndefined();
    expect(normalizeIp(undefined)).toBeUndefined();
  });

  it("keys IPv4 by address and IPv6 by /64; unknown shares one bucket", () => {
    expect(rateLimitKeyForIp("203.0.113.10")).toBe("203.0.113.10");
    expect(rateLimitKeyForIp("::ffff:203.0.113.10")).toBe("203.0.113.10");
    expect(rateLimitKeyForIp("2001:db8:1:2:aaaa::1")).toBe("2001:0db8:0001:0002::/64");
    expect(rateLimitKeyForIp("2001:db8:1:2::ffff")).toBe("2001:0db8:0001:0002::/64");
    expect(rateLimitKeyForIp("2001:db8:1:3::1")).toBe("2001:0db8:0001:0003::/64");
    expect(rateLimitKeyForIp("::1")).toBe("0000:0000:0000:0000::/64");
    expect(rateLimitKeyForIp(undefined)).toBe("unknown");
  });

  it("each client has its own budget; rotating IPv6 addresses inside a /64 does not reset it", () => {
    const limiter = createRateLimiter({ limit: 2, windowMs: 60_000 }, () => 0);
    const consume = (ip: string) => limiter.consume(rateLimitKeyForIp(ip)).allowed;
    expect([consume("203.0.113.10"), consume("203.0.113.10"), consume("203.0.113.10")]).toEqual([
      true,
      true,
      false,
    ]);
    expect(consume("203.0.113.20")).toBe(true); // client B unaffected by client A
    expect([consume("2001:db8::1"), consume("2001:db8::2"), consume("2001:db8::3")]).toEqual([
      true,
      true,
      false,
    ]);
  });

  it("through Express, two forged headers with the same appended entry share one key", async () => {
    const app = echoApp(WEB_SERVER);
    const a = await request(app).get("/ip").set("X-Forwarded-For", "1.1.1.1, 203.0.113.10");
    const b = await request(app).get("/ip").set("X-Forwarded-For", "2.2.2.2, 203.0.113.10");
    expect((a.body as { key: string }).key).toBe("203.0.113.10");
    expect((b.body as { key: string }).key).toBe("203.0.113.10");
  });
});

describe("TRUST_PROXY_* configuration", () => {
  const url = "postgresql://u:p@localhost/db";
  const prodUrl = `${url}?sslmode=require`;

  it("accepts IPs, CIDR ranges and the named ranges", () => {
    expect(parseTrustedAddresses("loopback, 10.0.0.0/8 ,fd00::/8, 192.0.2.7, uniquelocal")).toEqual(
      ["loopback", "10.0.0.0/8", "fd00::/8", "192.0.2.7", "uniquelocal"],
    );
  });

  it.each([
    "true",
    "*",
    "all",
    "0.0.0.0/0",
    "::/0",
    "10.0.0.0/33",
    "example.com",
    "1.2.3.4/x",
    ",",
  ])("refuses %s", (value) => {
    expect(() => parseTrustedAddresses(value)).toThrow();
  });

  it("defaults outside production to one hop from loopback (the local web server)", () => {
    expect(trustProxyConfigFromEnv(parseEnv({ DATABASE_URL: url }))).toEqual({
      hops: 1,
      addresses: ["loopback"],
    });
    expect(
      trustProxyConfigFromEnv(
        parseEnv({
          DATABASE_URL: url,
          TRUST_PROXY_HOPS: "2",
          TRUST_PROXY_ADDRESSES: "10.1.0.0/16",
        }),
      ),
    ).toEqual({ hops: 2, addresses: ["10.1.0.0/16"] });
  });

  it("production must state the chain explicitly", () => {
    expect(() => parseEnv({ DATABASE_URL: prodUrl, NODE_ENV: "production" })).toThrow(
      /TRUST_PROXY_HOPS: is required in production/,
    );
    expect(() =>
      parseEnv({ DATABASE_URL: prodUrl, NODE_ENV: "production", TRUST_PROXY_HOPS: "1" }),
    ).toThrow(/TRUST_PROXY_ADDRESSES: is required in production/);
    // 0 hops = the API is exposed directly; no addresses needed, nothing is trusted.
    const direct = parseEnv({
      DATABASE_URL: prodUrl,
      NODE_ENV: "production",
      TRUST_PROXY_HOPS: "0",
    });
    expect(trustProxyConfigFromEnv(direct).hops).toBe(0);
  });

  it("rejects trust-everything values and out-of-range hops, naming the variable", () => {
    expect(() => parseEnv({ DATABASE_URL: url, TRUST_PROXY_ADDRESSES: "true" })).toThrow(
      /TRUST_PROXY_ADDRESSES: "true" would trust every address/,
    );
    expect(() => parseEnv({ DATABASE_URL: url, TRUST_PROXY_ADDRESSES: "0.0.0.0/0" })).toThrow(
      /TRUST_PROXY_ADDRESSES: "0.0.0.0\/0" would trust every address/,
    );
    expect(() => parseEnv({ DATABASE_URL: url, TRUST_PROXY_HOPS: "6" })).toThrow(
      /TRUST_PROXY_HOPS/,
    );
    expect(() => parseEnv({ DATABASE_URL: url, TRUST_PROXY_HOPS: "true" })).toThrow(
      /TRUST_PROXY_HOPS/,
    );
  });
});
