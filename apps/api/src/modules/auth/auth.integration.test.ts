import { randomUUID } from "node:crypto";
import { pino } from "pino";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import type { ErrorResponseBody } from "../../lib/errors.js";
import { createPrismaClient } from "../../lib/prisma.js";
import { testAuthConfig } from "../../testing/auth-config.js";
import { resolveTestDatabase } from "../../testing/test-database.js";
import type { AuthConfig } from "./auth.config.js";
import { hashSessionToken } from "./tokens.js";

const prisma = createPrismaClient(resolveTestDatabase().pooledUrl);
const makeApp = (overrides: Partial<AuthConfig> = {}) =>
  createApp({
    logger: pino({ level: "silent" }),
    checkDatabase: () => Promise.resolve(),
    prisma,
    auth: testAuthConfig(overrides),
  });
const app = makeApp();

/** Every response body, checked at the end for password hashes and raw session tokens. */
const bodies: unknown[] = [];
const issuedTokens: string[] = [];

const PASSWORD = "a long test passphrase";
const uniqueEmail = (label: string) => `${label}-${randomUUID().slice(0, 8)}@test.local`;
const errorOf = (res: request.Response) => (res.body as ErrorResponseBody).error;

interface AuthBody {
  data: {
    user: { id: string; email: string; fullName: string; role: string; status: string };
    csrfToken: string;
    sessionExpiresAt: string;
  };
}

function sessionCookie(res: request.Response): { raw: string; pair: string; token: string } {
  const header = ([] as string[]).concat(res.headers["set-cookie"] ?? []);
  const raw = header.find((c) => c.includes("merostay_session=")) ?? "";
  const pair = raw.split(";")[0] ?? "";
  const token = decodeURIComponent(pair.split("=")[1] ?? "");
  if (token) issuedTokens.push(token);
  return { raw, pair, token };
}

async function register(agent = request.agent(app), email = uniqueEmail("user")) {
  const res = await agent
    .post("/api/v1/auth/register")
    .send({ email, password: PASSWORD, fullName: "Test User" });
  bodies.push(res.body);
  return { agent, res, email };
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe("register → me → logout", () => {
  it("registers, returns the user without any password data, and sets a hardened session cookie", async () => {
    const email = uniqueEmail("Ram.Bahadur");
    const { res } = await register(request.agent(app), `  ${email.toUpperCase()} `);

    expect(res.status).toBe(201);
    const { user, csrfToken } = (res.body as AuthBody).data;
    expect(Object.keys(user).sort()).toEqual([
      "createdAt",
      "email",
      "fullName",
      "id",
      "phone",
      "role",
      "status",
    ]);
    expect(user).toMatchObject({ email: email.toLowerCase(), role: "CUSTOMER", status: "ACTIVE" });
    expect(csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(res.headers["cache-control"]).toBe("no-store");

    const cookie = sessionCookie(res);
    expect(cookie.pair).toMatch(/^merostay_session=[A-Za-z0-9_-]{43}$/);
    expect(cookie.raw).toMatch(/; HttpOnly/i);
    expect(cookie.raw).toMatch(/; SameSite=Lax/i);
    expect(cookie.raw).toMatch(/; Path=\//i);
    expect(cookie.raw).toMatch(/; Expires=/i);
    expect(cookie.raw).not.toMatch(/; Secure/i); // test config: plain http

    const stored = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(stored.email).toBe(email.toLowerCase()); // normalized
    expect(stored.passwordHash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(stored.passwordHash).not.toContain(PASSWORD);

    const sessions = await prisma.session.findMany({ where: { userId: user.id } });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.tokenHash).toBe(hashSessionToken(cookie.token)); // only the hash is stored
    expect(sessions[0]!.tokenHash).not.toBe(cookie.token);
  });

  it("me returns the logged-in user and the same CSRF token; logout ends the session", async () => {
    const { agent, res } = await register();
    const registered = (res.body as AuthBody).data;
    const cookie = sessionCookie(res);

    const me = await agent.get("/api/v1/auth/me");
    bodies.push(me.body);
    expect(me.status).toBe(200);
    expect((me.body as AuthBody).data.user).toEqual(registered.user);
    expect((me.body as AuthBody).data.csrfToken).toBe(registered.csrfToken);

    // Logout is a state change: it needs the CSRF token.
    const noToken = await agent.post("/api/v1/auth/logout");
    expect([noToken.status, errorOf(noToken).code]).toEqual([403, "CSRF_TOKEN_INVALID"]);

    const out = await agent.post("/api/v1/auth/logout").set("X-CSRF-Token", registered.csrfToken);
    expect(out.status).toBe(204);
    const cleared = ([] as string[]).concat(out.headers["set-cookie"] ?? []).join(";");
    expect(cleared).toMatch(/merostay_session=;/);
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/);

    expect(await prisma.session.count({ where: { userId: registered.user.id } })).toBe(0);
    const after = await agent.get("/api/v1/auth/me");
    expect([after.status, errorOf(after).code]).toEqual([401, "UNAUTHENTICATED"]);

    // Replaying the old cookie (e.g. stolen before logout) no longer works: it was revoked server-side.
    const replay = await request(app).get("/api/v1/auth/me").set("Cookie", cookie.pair);
    expect(replay.status).toBe(401);
  });

  it("rejects a duplicate email, whatever its case (409 EMAIL_TAKEN), and a duplicate phone", async () => {
    const email = uniqueEmail("dup");
    expect((await register(request.agent(app), email)).res.status).toBe(201);
    const again = await request(app)
      .post("/api/v1/auth/register")
      .send({ email: email.toUpperCase(), password: PASSWORD, fullName: "Copy" });
    expect([again.status, errorOf(again).code]).toEqual([409, "EMAIL_TAKEN"]);

    const phone = `+97798${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
    const first = await request(app)
      .post("/api/v1/auth/register")
      .send({ email: uniqueEmail("p1"), password: PASSWORD, fullName: "P1", phone });
    expect(first.status).toBe(201);
    const second = await request(app)
      .post("/api/v1/auth/register")
      .send({ email: uniqueEmail("p2"), password: PASSWORD, fullName: "P2", phone });
    expect([second.status, errorOf(second).code]).toEqual([409, "PHONE_TAKEN"]);
  });
});

describe("login", () => {
  it("logs in with the right password (email matched case-insensitively) and starts a new session", async () => {
    const { res, email } = await register();
    const firstToken = sessionCookie(res).token;

    const login = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: `  ${email.toUpperCase()}`, password: PASSWORD });
    bodies.push(login.body);
    expect(login.status).toBe(200);
    const token = sessionCookie(login).token;
    expect(token).not.toBe(firstToken);

    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.lastLoginAt).not.toBeNull();
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(2); // two devices
  });

  it("does not reveal whether an account exists: wrong password, unknown email and password-less accounts all look the same", async () => {
    const { email } = await register();
    const seedLike = await prisma.user.create({
      data: { email: uniqueEmail("no-password"), fullName: "Sample user without a password" },
    });

    const attempts = await Promise.all([
      request(app).post("/api/v1/auth/login").send({ email, password: "wrong password here" }),
      request(app)
        .post("/api/v1/auth/login")
        .send({ email: uniqueEmail("nobody"), password: PASSWORD }),
      request(app).post("/api/v1/auth/login").send({ email: seedLike.email, password: PASSWORD }),
    ]);
    for (const res of attempts) {
      bodies.push(res.body);
      expect(res.status).toBe(401);
      expect(res.body).toEqual({
        error: { code: "INVALID_CREDENTIALS", message: "Email or password is incorrect." },
      });
      expect(res.headers["set-cookie"]).toBeUndefined();
    }
  });

  it("logging in while holding a session replaces it (session fixation defence)", async () => {
    const { agent, res, email } = await register();
    const old = sessionCookie(res);

    const login = await agent.post("/api/v1/auth/login").send({ email, password: PASSWORD });
    expect(login.status).toBe(200);
    expect(await prisma.session.count({ where: { tokenHash: hashSessionToken(old.token) } })).toBe(
      0,
    );
    expect((await request(app).get("/api/v1/auth/me").set("Cookie", old.pair)).status).toBe(401);
    expect((await agent.get("/api/v1/auth/me")).status).toBe(200);
  });
});

describe("session validity", () => {
  it("an expired session is rejected and removed", async () => {
    const { agent, res } = await register();
    const { token } = sessionCookie(res);
    await prisma.session.update({
      where: { tokenHash: hashSessionToken(token) },
      data: {
        createdAt: new Date(Date.now() - 3 * 86_400_000),
        expiresAt: new Date(Date.now() - 1_000),
      },
    });

    const me = await agent.get("/api/v1/auth/me");
    expect([me.status, errorOf(me).code]).toEqual([401, "UNAUTHENTICATED"]);
    expect(await prisma.session.count({ where: { tokenHash: hashSessionToken(token) } })).toBe(0);
  });

  it("a suspended account loses its sessions and cannot log in (403 only after the correct password)", async () => {
    const { agent, res, email } = await register();
    const userId = (res.body as AuthBody).data.user.id;
    await prisma.user.update({ where: { id: userId }, data: { status: "SUSPENDED" } });

    expect((await agent.get("/api/v1/auth/me")).status).toBe(401);
    const right = await request(app).post("/api/v1/auth/login").send({ email, password: PASSWORD });
    expect([right.status, errorOf(right).code]).toEqual([403, "ACCOUNT_DISABLED"]);
    const wrong = await request(app)
      .post("/api/v1/auth/login")
      .send({ email, password: "wrong password here" });
    expect([wrong.status, errorOf(wrong).code]).toEqual([401, "INVALID_CREDENTIALS"]); // status not leaked
  });

  it("garbage or unknown session cookies are simply unauthenticated", async () => {
    for (const value of ["x", "a".repeat(43), "%%%", "b".repeat(500)]) {
      const res = await request(app)
        .get("/api/v1/auth/me")
        .set("Cookie", `merostay_session=${value}`);
      expect(res.status).toBe(401);
    }
  });
});

describe("rate limiting", () => {
  it("limits login attempts per email address (429 with Retry-After)", async () => {
    const limited = makeApp({
      rateLimits: { ...testAuthConfig().rateLimits, loginPerEmail: { limit: 3, windowMs: 60_000 } },
    });
    const email = uniqueEmail("brute");
    const statuses: number[] = [];
    let last: request.Response | undefined;
    for (let i = 0; i < 4; i++) {
      last = await request(limited)
        .post("/api/v1/auth/login")
        .send({ email, password: `guess number ${i}` });
      statuses.push(last.status);
    }
    expect(statuses).toEqual([401, 401, 401, 429]);
    expect(errorOf(last!).code).toBe("RATE_LIMITED");
    expect(Number(last!.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("limits registrations per client IP", async () => {
    const limited = makeApp({
      rateLimits: { ...testAuthConfig().rateLimits, registerPerIp: { limit: 2, windowMs: 60_000 } },
    });
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await request(limited)
        .post("/api/v1/auth/register")
        .send({ email: uniqueEmail(`burst${i}`), password: PASSWORD, fullName: "Burst" });
      statuses.push(res.status);
    }
    expect(statuses).toEqual([201, 201, 429]);
  });
});

describe("production cookie settings", () => {
  it("uses Secure and the __Host- prefix when cookieSecure is on", async () => {
    const secureApp = makeApp({ cookieSecure: true });
    const res = await request(secureApp)
      .post("/api/v1/auth/register")
      .send({ email: uniqueEmail("secure"), password: PASSWORD, fullName: "Secure" });
    const raw = ([] as string[]).concat(res.headers["set-cookie"] ?? []).join(";");
    expect(raw).toMatch(/^__Host-merostay_session=/);
    expect(raw).toMatch(/; Secure/i);
    expect(raw).toMatch(/; HttpOnly/i);
    expect(raw).not.toMatch(/Domain=/i);
  });
});

describe("leak checks over every auth response", () => {
  it("no response ever contained a password, a password hash or a raw session token", () => {
    const all = JSON.stringify(bodies);
    expect(bodies.length).toBeGreaterThan(8);
    expect(all).not.toMatch(/argon2|passwordHash|password_hash/);
    expect(all).not.toContain(PASSWORD);
    for (const token of issuedTokens) expect(all).not.toContain(token);
  });
});
