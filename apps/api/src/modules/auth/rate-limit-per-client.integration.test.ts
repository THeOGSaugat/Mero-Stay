import { randomUUID } from "node:crypto";
import { pino } from "pino";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import type { TrustProxyConfig } from "../../lib/client-ip.js";
import type { ErrorResponseBody } from "../../lib/errors.js";
import { createPrismaClient } from "../../lib/prisma.js";
import { testAuthConfig } from "../../testing/auth-config.js";
import { resolveTestDatabase } from "../../testing/test-database.js";
import type { AuthConfig } from "./auth.config.js";

/**
 * Gap 5 (ADR 0014): rate limits are per client behind the web-server proxy.
 *
 * Supertest connects from loopback, which plays the web server: with the API trusting loopback for
 * one hop, the X-Forwarded-For entry the "web server" appended (the rightmost) is the client. An
 * untrusted source is simulated by trusting some other address, so loopback is not a proxy.
 * Each test builds its own app, so every limiter starts empty.
 */

const prisma = createPrismaClient(resolveTestDatabase().pooledUrl);
afterAll(() => prisma.$disconnect());

const WEB_SERVER: TrustProxyConfig = { hops: 1, addresses: ["loopback"] };
const UNTRUSTED_SOURCE: TrustProxyConfig = { hops: 1, addresses: ["192.0.2.1"] };
const WEB_AND_EDGE: TrustProxyConfig = { hops: 2, addresses: ["loopback", "10.0.0.0/8"] };

const generous = { limit: 10_000, windowMs: 60_000 };
const tight = { limit: 3, windowMs: 60_000 };

function makeApp(rateLimits: Partial<AuthConfig["rateLimits"]>, trustProxy?: TrustProxyConfig) {
  return createApp({
    logger: pino({ level: "silent" }),
    checkDatabase: () => Promise.resolve(),
    prisma,
    auth: testAuthConfig({
      rateLimits: {
        loginPerEmail: generous,
        loginPerIp: generous,
        registerPerIp: generous,
        ...rateLimits,
      },
    }),
    ...(trustProxy ? { trustProxy } : {}),
  });
}

type App = ReturnType<typeof makeApp>;
const PASSWORD = "a long test passphrase";
const email = (label: string) => `${label}-${randomUUID().slice(0, 8)}@test.local`;
const codeOf = (res: request.Response) => (res.body as ErrorResponseBody).error?.code;

/** A failed login (unknown account) as seen through the proxy with this X-Forwarded-For. */
async function login(app: App, xff: string | undefined, address = email("nobody")) {
  const req = request(app).post("/api/v1/auth/login");
  if (xff !== undefined) req.set("X-Forwarded-For", xff);
  return req.send({ email: address, password: "wrong password guess" });
}

async function loginStatuses(app: App, xffs: readonly (string | undefined)[]): Promise<number[]> {
  const statuses: number[] = [];
  for (const xff of xffs) statuses.push((await login(app, xff)).status);
  return statuses;
}

async function register(app: App, xff: string) {
  return request(app)
    .post("/api/v1/auth/register")
    .set("X-Forwarded-For", xff)
    .send({ email: email("signup"), password: PASSWORD, fullName: "Rate Limit Person" });
}

const A = "203.0.113.10";
const B = "203.0.113.20";

describe("gap 5: per-client login limits behind the trusted proxy", () => {
  it("exhausting client A's login budget does not limit client B", async () => {
    const app = makeApp({ loginPerIp: tight }, WEB_SERVER);

    expect(await loginStatuses(app, [A, A, A, A])).toEqual([401, 401, 401, 429]);
    const limited = await login(app, A);
    expect([limited.status, codeOf(limited)]).toEqual([429, "RATE_LIMITED"]);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);

    // B has its own, untouched budget, and using it does not free A.
    expect(await loginStatuses(app, [B, B, B, B])).toEqual([401, 401, 401, 429]);
    expect((await login(app, A)).status).toBe(429);
  });

  it("a forged X-Forwarded-For does not open a new bucket: only the proxy's entry counts", async () => {
    const app = makeApp({ loginPerIp: tight }, WEB_SERVER);
    // Each request forges a different address in front of the entry the web server appended.
    const forged = [1, 2, 3, 4, 5].map((n) => `198.51.100.${n}, ${A}`);
    expect(await loginStatuses(app, forged)).toEqual([401, 401, 401, 429, 429]);
    // A client sending a long forged chain is still the same client.
    expect((await login(app, `9.9.9.9, 8.8.8.8, 7.7.7.7, ${A}`)).status).toBe(429);
    // ... and a different real client is unaffected.
    expect((await login(app, `198.51.100.1, ${B}`)).status).toBe(401);
  });

  it("from an untrusted source, rotating X-Forwarded-For does not bypass the limit", async () => {
    const app = makeApp({ loginPerIp: tight }, UNTRUSTED_SOURCE);
    const rotating = ["203.0.113.1", "203.0.113.2", "203.0.113.3", "203.0.113.4"];
    expect(await loginStatuses(app, rotating)).toEqual([401, 401, 401, 429]);

    // The default (no trustProxy given) trusts nothing: same result.
    const defaultApp = makeApp({ loginPerIp: tight });
    expect(await loginStatuses(defaultApp, rotating)).toEqual([401, 401, 401, 429]);
  });

  it("behind web server + edge (2 hops), the address the edge reported is the client", async () => {
    const app = makeApp({ loginPerIp: tight }, WEB_AND_EDGE);
    const viaEdge = (client: string, forged: string) => `${forged}, ${client}, 10.0.0.5`;
    const statuses = await loginStatuses(
      app,
      ["6.6.6.1", "6.6.6.2", "6.6.6.3", "6.6.6.4"].map((f) => viaEdge(A, f)),
    );
    expect(statuses).toEqual([401, 401, 401, 429]);
    expect((await login(app, viaEdge(B, "6.6.6.1"))).status).toBe(401);
  });

  it("IPv6 clients are grouped by /64, so rotating addresses inside one network does not help", async () => {
    const app = makeApp({ loginPerIp: tight }, WEB_SERVER);
    const sameNetwork = [
      "2001:db8:1:2::1",
      "2001:db8:1:2::2",
      "2001:db8:1:2::abcd",
      "2001:db8:1:2::9",
    ];
    expect(await loginStatuses(app, sameNetwork)).toEqual([401, 401, 401, 429]);
    expect((await login(app, "2001:db8:1:3::1")).status).toBe(401);
  });

  it("the per-email limit still spans clients (a distributed guess at one account)", async () => {
    const app = makeApp({ loginPerEmail: tight }, WEB_SERVER);
    const target = email("target");
    const statuses: number[] = [];
    for (const client of ["203.0.113.1", "203.0.113.2", "203.0.113.3", "203.0.113.4"]) {
      statuses.push((await login(app, client, target)).status);
    }
    expect(statuses).toEqual([401, 401, 401, 429]);
  });
});

describe("gap 5: per-client registration limits", () => {
  it("client A's registrations do not use up client B's; forging does not reset A", async () => {
    const app = makeApp({ registerPerIp: { limit: 2, windowMs: 60_000 } }, WEB_SERVER);
    const a = [await register(app, A), await register(app, A), await register(app, A)];
    expect(a.map((r) => r.status)).toEqual([201, 201, 429]);
    expect(codeOf(a[2]!)).toBe("RATE_LIMITED");

    expect((await register(app, `198.51.100.77, ${A}`)).status).toBe(429);
    expect((await register(app, B)).status).toBe(201);
    expect((await register(app, `198.51.100.77, ${B}`)).status).toBe(201);
    expect((await register(app, B)).status).toBe(429);
  });

  it("from an untrusted source, all registrations share the socket's budget", async () => {
    const app = makeApp({ registerPerIp: { limit: 2, windowMs: 60_000 } }, UNTRUSTED_SOURCE);
    const statuses = [
      (await register(app, "203.0.113.31")).status,
      (await register(app, "203.0.113.32")).status,
      (await register(app, "203.0.113.33")).status,
    ];
    expect(statuses).toEqual([201, 201, 429]);
  });
});

describe("gap 5: audit rows record the resolved client", () => {
  it("the forged entry never reaches the audit log; the proxy-reported client does", async () => {
    const app = makeApp({}, WEB_SERVER);
    const xff = `198.51.100.66, ${A}`;
    const agent = request.agent(app);
    const signup = await agent
      .post("/api/v1/auth/register")
      .set("X-Forwarded-For", xff)
      .send({ email: email("auditip"), password: PASSWORD, fullName: "Audit Ip" });
    expect(signup.status).toBe(201);
    const csrf = (signup.body as { data: { csrfToken: string } }).data.csrfToken;

    const onboarded = await agent
      .post("/api/v1/partner/onboarding")
      .set("X-Forwarded-For", xff)
      .set("X-CSRF-Token", csrf)
      .send({
        providerTypeCode: "guide",
        legalName: "Audit Ip Guides",
        displayName: `Audit Ip ${randomUUID().slice(0, 6)}`,
      });
    expect(onboarded.status).toBe(201);
    const providerId = (onboarded.body as { data: { id: string } }).data.id;

    const row = await prisma.auditLog.findFirstOrThrow({
      where: { action: "provider.create", entityId: providerId },
      select: { ip: true },
    });
    expect(row.ip).toBe(A);
  });
});
