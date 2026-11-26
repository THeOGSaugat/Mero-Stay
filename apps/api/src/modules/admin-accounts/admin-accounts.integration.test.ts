import { randomUUID } from "node:crypto";
import { pino } from "pino";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../../app.js";
import { inspectDatabaseError } from "../../lib/database-errors.js";
import type { ErrorResponseBody } from "../../lib/errors.js";
import { createPrismaClient } from "../../lib/prisma.js";
import { testAuthConfig } from "../../testing/auth-config.js";
import { resolveTestDatabase } from "../../testing/test-database.js";

/**
 * Phase 12 (ADR 0018, gap 9): admins create admins (one-time setup link, password set by the new
 * admin), suspend and reactivate them; never yourself, never the last usable admin; audited; no
 * password or token in any response or audit row.
 */

vi.setConfig({ testTimeout: 120_000 });

const prisma = createPrismaClient(resolveTestDatabase().pooledUrl);
const app = createApp({
  logger: pino({ level: "silent" }),
  checkDatabase: () => Promise.resolve(),
  prisma,
  auth: testAuthConfig(),
});
const PASSWORD = "a long test passphrase";

interface Client {
  agent: ReturnType<typeof request.agent>;
  csrf: string;
  userId: string;
}
let admin: Client;
let customer: Client;
const responses: unknown[] = [];

async function signUp(label: string): Promise<Client> {
  const agent = request.agent(app);
  const res = await agent.post("/api/v1/auth/register").send({
    email: `${label}-${randomUUID().slice(0, 8)}@test.local`,
    password: PASSWORD,
    fullName: label,
  });
  expect(res.status).toBe(201);
  const body = res.body as { data: { user: { id: string }; csrfToken: string } };
  return { agent, csrf: body.data.csrfToken, userId: body.data.user.id };
}

async function login(email: string, password = PASSWORD) {
  const agent = request.agent(app);
  const res = await agent.post("/api/v1/auth/login").send({ email, password });
  return { res, agent };
}

async function call(as: Client, method: "get" | "post", url: string, body?: object) {
  const req = as.agent[method](url).set("X-CSRF-Token", as.csrf);
  const res = body ? await req.send(body) : await req;
  responses.push(res.body);
  return res;
}
const dataOf = <T>(res: request.Response) => (res.body as { data: T }).data;
const codeOf = (res: request.Response) => [res.status, (res.body as ErrorResponseBody).error.code];
const tokenOf = (setupPath: string) => setupPath.split("#token=")[1]!;
const setup = (token: string, password = PASSWORD) =>
  request(app).post("/api/v1/auth/admin-setup").send({ token, password });

interface AdminBody {
  id: string;
  email: string;
  status: string;
  setupPending: boolean;
}
interface Created {
  admin: AdminBody;
  setupLink: { setupPath: string; expiresAt: string };
}

beforeAll(async () => {
  admin = await signUp("accounts-admin");
  await prisma.user.update({ where: { id: admin.userId }, data: { role: "ADMIN" } });
  customer = await signUp("accounts-customer");
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("creating an admin with a one-time setup link", () => {
  let created: Created;
  const email = `new-admin-${randomUUID().slice(0, 8)}@merostay.test`;

  it("creates the account WITHOUT a password and returns the link once (no-store)", async () => {
    const res = await call(admin, "post", "/api/v1/admin/admins", {
      email,
      fullName: "Anita Sharma",
    });
    expect(res.status).toBe(201);
    expect(res.headers["cache-control"]).toBe("no-store");
    created = dataOf<Created>(res);
    expect(created.admin).toMatchObject({ email, status: "ACTIVE", setupPending: true });
    expect(created.setupLink.setupPath).toMatch(/^\/admin-setup#token=[A-Za-z0-9_-]{43}$/);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: created.admin.id } });
    expect([user.role, user.passwordHash]).toEqual(["ADMIN", null]);
    // Only the SHA-256 is stored; the token appears in no audit row.
    const token = tokenOf(created.setupLink.setupPath);
    const stored = await prisma.adminSetupToken.findFirstOrThrow({ where: { userId: user.id } });
    expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.tokenHash).not.toContain(token);
    const audit = await prisma.auditLog.findMany({ where: { entityId: user.id } });
    expect(audit.map((a) => a.action)).toEqual(["admin.create"]);
    expect(JSON.stringify(audit)).not.toContain(token);
    // No password yet: cannot log in.
    expect(codeOf((await login(email)).res)).toEqual([401, "INVALID_CREDENTIALS"]);
  });

  it("the new admin sets a password with the link, once; then logs in as admin", async () => {
    const token = tokenOf(created.setupLink.setupPath);
    expect((await setup(token, "short")).status).toBe(400);
    expect((await setup(token)).status).toBe(204);
    expect(codeOf(await setup(token, "another long passphrase"))).toEqual([
      400,
      "SETUP_LINK_INVALID",
    ]);
    const { res, agent } = await login(email);
    expect(res.status).toBe(200);
    const csrf = (res.body as { data: { csrfToken: string } }).data.csrfToken;
    const list = await agent.get("/api/v1/admin/admins").set("X-CSRF-Token", csrf);
    expect(list.status).toBe(200);
    const me = (list.body as { data: AdminBody[] }).data.find((a) => a.id === created.admin.id);
    expect(me?.setupPending).toBe(false);
    expect(
      await prisma.auditLog.count({
        where: { entityId: created.admin.id, action: "admin.setup.complete" },
      }),
    ).toBe(1);
  });

  it("unknown, malformed and expired links are refused alike; a reissued link replaces the old one", async () => {
    expect(codeOf(await setup("A".repeat(43)))).toEqual([400, "SETUP_LINK_INVALID"]);
    expect((await setup("not-a-token")).status).toBe(400);
    const other = dataOf<Created>(
      await call(admin, "post", "/api/v1/admin/admins", {
        email: `late-${randomUUID().slice(0, 8)}@merostay.test`,
        fullName: "Late Admin",
      }),
    );
    const first = tokenOf(other.setupLink.setupPath);
    const reissued = await call(admin, "post", `/api/v1/admin/admins/${other.admin.id}/setup-link`);
    const second = tokenOf(
      dataOf<{ setupLink: { setupPath: string } }>(reissued).setupLink.setupPath,
    );
    expect(second).not.toBe(first);
    expect(codeOf(await setup(first))).toEqual([400, "SETUP_LINK_INVALID"]);
    // Expire it (as if 24 h had passed): expiry = creation time.
    await prisma.$executeRaw`
      UPDATE admin_setup_tokens SET expires_at = created_at
      WHERE user_id = ${other.admin.id}::uuid AND used_at IS NULL`;
    expect(codeOf(await setup(second))).toEqual([400, "SETUP_LINK_INVALID"]);
    expect(
      codeOf(await call(admin, "post", `/api/v1/admin/admins/${created.admin.id}/setup-link`)),
    ).toEqual([409, "ADMIN_ALREADY_SET_UP"]);
  });

  it("an email already in use is a 409; nothing is promoted silently", async () => {
    const existing = await prisma.user.findUniqueOrThrow({ where: { id: customer.userId } });
    const res = await call(admin, "post", "/api/v1/admin/admins", {
      email: existing.email,
      fullName: "x",
    });
    expect(codeOf(res)).toEqual([409, "EMAIL_TAKEN"]);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: customer.userId } })).role).toBe(
      "CUSTOMER",
    );
  });

  describe("suspend and reactivate", () => {
    it("suspending ends the admin's sessions at once; reactivating lets them back in", async () => {
      const { res, agent } = await login(email);
      const csrf = (res.body as { data: { csrfToken: string } }).data.csrfToken;
      expect((await agent.get("/api/v1/admin/admins").set("X-CSRF-Token", csrf)).status).toBe(200);

      const suspended = await call(
        admin,
        "post",
        `/api/v1/admin/admins/${created.admin.id}/suspend`,
      );
      expect(dataOf<{ changed: boolean; admin: AdminBody }>(suspended)).toMatchObject({
        changed: true,
        admin: { status: "SUSPENDED" },
      });
      expect((await agent.get("/api/v1/admin/admins").set("X-CSRF-Token", csrf)).status).toBe(401);
      expect(await prisma.session.count({ where: { userId: created.admin.id } })).toBe(0);
      expect(codeOf((await login(email)).res)).toEqual([403, "ACCOUNT_DISABLED"]);
      const again = await call(admin, "post", `/api/v1/admin/admins/${created.admin.id}/suspend`);
      expect(dataOf<{ changed: boolean }>(again).changed).toBe(false);

      const back = await call(admin, "post", `/api/v1/admin/admins/${created.admin.id}/reactivate`);
      expect(dataOf<{ admin: AdminBody }>(back).admin.status).toBe("ACTIVE");
      expect((await login(email)).res.status).toBe(200);
      const actions = await prisma.auditLog.findMany({
        where: {
          entityId: created.admin.id,
          action: { in: ["admin.suspend", "admin.reactivate"] },
        },
        orderBy: { createdAt: "asc" },
      });
      expect(actions.map((a) => a.action)).toEqual(["admin.suspend", "admin.reactivate"]);
    });

    it("you cannot suspend yourself", async () => {
      expect(
        codeOf(await call(admin, "post", `/api/v1/admin/admins/${admin.userId}/suspend`)),
      ).toEqual([409, "ADMIN_SELF_LOCKOUT"]);
    });

    it("the database never lets the last usable admin go (checked inside a rolled-back transaction)", async () => {
      const marker = new Error("rollback");
      const result = await prisma
        .$transaction(async (tx) => {
          // Everyone else stops being a usable admin…
          await tx.user.updateMany({
            where: {
              role: "ADMIN",
              status: "ACTIVE",
              passwordHash: { not: null },
              id: { not: admin.userId },
            },
            data: { status: "SUSPENDED" },
          });
          // …then the last one cannot be suspended, demoted or lose its password.
          const outcomes = [];
          for (const data of [
            { status: "SUSPENDED" as const },
            { role: "CUSTOMER" as const },
            { passwordHash: null },
          ]) {
            try {
              await tx.$executeRaw`SAVEPOINT attempt`;
              await tx.user.update({ where: { id: admin.userId }, data });
              outcomes.push("allowed");
            } catch (err) {
              outcomes.push(inspectDatabaseError(err)?.constraint ?? "other");
              await tx.$executeRaw`ROLLBACK TO SAVEPOINT attempt`;
            }
          }
          throw Object.assign(marker, { outcomes });
        })
        .catch((err: unknown) => err as Error & { outcomes?: string[] });
      expect(result).toBe(marker);
      expect(result.outcomes).toEqual([
        "users_last_admin_chk",
        "users_last_admin_chk",
        "users_last_admin_chk",
      ]);
      // Rolled back: the other admins are still active.
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: created.admin.id } })).status,
      ).toBe("ACTIVE");
    });
  });
});

it("non-admins cannot list, create or suspend admins", async () => {
  expect(codeOf(await call(customer, "get", "/api/v1/admin/admins"))).toEqual([403, "FORBIDDEN"]);
  expect(
    codeOf(
      await call(customer, "post", "/api/v1/admin/admins", {
        email: "x@merostay.test",
        fullName: "x",
      }),
    ),
  ).toEqual([403, "FORBIDDEN"]);
  expect(
    codeOf(await call(customer, "post", `/api/v1/admin/admins/${admin.userId}/suspend`)),
  ).toEqual([403, "FORBIDDEN"]);
  expect((await request(app).get("/api/v1/admin/admins")).status).toBe(401);
});

it("no response carries a password hash", () => {
  const text = JSON.stringify(responses);
  expect(text).not.toContain("passwordHash");
  expect(text).not.toContain("$argon2");
});
