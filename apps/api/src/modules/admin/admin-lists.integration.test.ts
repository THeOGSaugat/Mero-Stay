import { randomUUID } from "node:crypto";
import { simulatedPayments } from "../../modules/payments/payments.config.js";
import { pino } from "pino";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../../app.js";
import type { PrismaClient } from "../../generated/prisma/client.js";
import type { ErrorResponseBody } from "../../lib/errors.js";
import { createPrismaClient } from "../../lib/prisma.js";
import { testAuthConfig } from "../../testing/auth-config.js";
import { createWorld, type World } from "../../testing/fixtures.js";
import { moneyBoundaryViolations } from "../../testing/json-safety.js";
import { resolveTestDatabase } from "../../testing/test-database.js";

/**
 * Gap 25 (Phase 8): admin lists search, order stably and page past 100 rows; the audit log shows
 * the actor's name. Bulk rows that are not under test (105 providers, 100 audit rows) are seeded
 * with Prisma.
 */

vi.setConfig({ testTimeout: 300_000 });

const prisma = createPrismaClient(resolveTestDatabase().pooledUrl);

/** Counts top-level Prisma operations, to show list endpoints don't query once per row. */
let operations = 0;
const counted = prisma.$extends({
  query: {
    async $allOperations({ args, query }) {
      operations += 1;
      const result: unknown = await query(args);
      return result;
    },
  },
}) as unknown as PrismaClient;

const app = createApp({
  logger: pino({ level: "silent" }),
  checkDatabase: () => Promise.resolve(),
  prisma: counted,
  auth: testAuthConfig(),
  payments: simulatedPayments(),
});

interface Client {
  agent: ReturnType<typeof request.agent>;
  csrfToken: string;
  userId: string;
}

const dataOf = <T>(res: request.Response) => (res.body as { data: T }).data;
const pageOf = (res: request.Response) =>
  (res.body as { page: { page: number; pageSize: number; total: number; totalPages: number } })
    .page;
const codeOf = (res: request.Response) => [res.status, (res.body as ErrorResponseBody).error?.code];

async function signUp(label: string): Promise<Client> {
  const agent = request.agent(app);
  const res = await agent.post("/api/v1/auth/register").send({
    email: `${label}-${randomUUID().slice(0, 8)}@test.local`,
    password: "a long test passphrase",
    fullName: `${label} Person`,
  });
  expect(res.status).toBe(201);
  const body = res.body as { data: { user: { id: string }; csrfToken: string } };
  return { agent, csrfToken: body.data.csrfToken, userId: body.data.user.id };
}

function call(who: Client, method: "get" | "post", url: string, body?: unknown) {
  const req = who.agent[method](url).set("X-CSRF-Token", who.csrfToken);
  return body === undefined ? req : req.send(body as object);
}

const tag = `zq${randomUUID().slice(0, 6)}`;
/** A separate token, so the email-only provider is not matched by `tag`. */
const emailToken = `em${randomUUID().slice(0, 6)}`;
const PROVIDERS = 105;
let admin: Client;
let customer: Client;
let world: World;
let seededIds: string[];

beforeAll(async () => {
  [admin, customer, world] = await Promise.all([
    signUp("lists-admin"),
    signUp("lists-customer"),
    createWorld(prisma),
  ]);
  await prisma.user.update({ where: { id: admin.userId }, data: { role: "ADMIN" } });

  // 105 providers carrying the tag; pairs share a created_at so the id tie-breaker matters.
  const owner = await prisma.user.create({
    data: { email: `owner-${tag}@test.local`, fullName: "Bulk Owner", role: "PARTNER" },
  });
  const base = Date.UTC(2026, 0, 1);
  await prisma.provider.createMany({
    data: Array.from({ length: PROVIDERS }, (_, i) => ({
      providerTypeCode: i % 5 === 0 ? "bus_operator" : "hotel",
      ownerUserId: owner.id,
      legalName: `Legal ${tag} ${String(i).padStart(3, "0")}`,
      displayName: `Stay ${tag} ${String(i).padStart(3, "0")}`,
      status: i % 3 === 0 ? ("VERIFIED" as const) : ("DRAFT" as const),
      createdAt: new Date(base + Math.floor(i / 2) * 1000),
    })),
  });
  // A provider found only by its owner's email.
  const emailOwner = await prisma.user.create({
    data: { email: `findme-${emailToken}@test.local`, fullName: "Email Owner", role: "PARTNER" },
  });
  await prisma.provider.create({
    data: {
      providerTypeCode: "guide",
      ownerUserId: emailOwner.id,
      legalName: "Himal Guides",
      displayName: "Himal Guides",
    },
  });
  seededIds = (
    await prisma.provider.findMany({
      where: { displayName: { contains: tag } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true },
    })
  ).map((p) => p.id);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("gap 25: admin providers list", () => {
  it("pages past 100: three pages of 50/50/5, no overlap, newest first with an id tie-breaker", async () => {
    expect(seededIds).toHaveLength(PROVIDERS);
    const ids: string[] = [];
    for (const page of [1, 2, 3]) {
      const res = await call(
        admin,
        "get",
        `/api/v1/admin/providers?q=${tag}&pageSize=50&page=${page}`,
      );
      expect(res.status).toBe(200);
      expect(pageOf(res)).toEqual({ page, pageSize: 50, total: PROVIDERS, totalPages: 3 });
      ids.push(...dataOf<{ id: string }[]>(res).map((p) => p.id));
    }
    expect(ids).toHaveLength(PROVIDERS);
    expect(new Set(ids).size).toBe(PROVIDERS);
    expect(ids).toEqual(seededIds); // exactly the database's stable order
    const beyond = await call(admin, "get", `/api/v1/admin/providers?q=${tag}&pageSize=50&page=4`);
    expect([dataOf<unknown[]>(beyond), pageOf(beyond).total]).toEqual([[], PROVIDERS]);
    // Repeating a page returns the same rows (stable ordering).
    const again = await call(admin, "get", `/api/v1/admin/providers?q=${tag}&pageSize=50&page=2`);
    expect(dataOf<{ id: string }[]>(again).map((p) => p.id)).toEqual(ids.slice(50, 100));
  });

  it("other orders: oldest first is the reverse; by name is alphabetical", async () => {
    const oldest = await call(
      admin,
      "get",
      `/api/v1/admin/providers?q=${tag}&pageSize=100&sort=oldest`,
    );
    expect(dataOf<{ id: string }[]>(oldest).map((p) => p.id)).toEqual(
      [...seededIds].reverse().slice(0, 100),
    );
    const byName = await call(
      admin,
      "get",
      `/api/v1/admin/providers?q=${tag}&pageSize=5&sort=name`,
    );
    expect(dataOf<{ displayName: string }[]>(byName).map((p) => p.displayName)).toEqual(
      [0, 1, 2, 3, 4].map((i) => `Stay ${tag} 00${i}`),
    );
  });

  it("search: name, legal name, owner email, type; combined with the filters", async () => {
    const one = await call(admin, "get", `/api/v1/admin/providers?q=${tag}%20042`);
    expect(dataOf<{ displayName: string }[]>(one).map((p) => p.displayName)).toEqual([
      `Stay ${tag} 042`,
    ]);
    expect(pageOf(await call(admin, "get", `/api/v1/admin/providers?q=Legal%20${tag}`)).total).toBe(
      PROVIDERS,
    );

    const byEmail = await call(admin, "get", `/api/v1/admin/providers?q=findme-${emailToken}`);
    expect(dataOf<{ displayName: string }[]>(byEmail).map((p) => p.displayName)).toEqual([
      "Himal Guides",
    ]);

    // q + the type filter + the status filter (AND): every 5th is a bus operator, every 3rd verified.
    const busVerified = await call(
      admin,
      "get",
      `/api/v1/admin/providers?q=${tag}&providerType=bus_operator&status=VERIFIED&pageSize=100`,
    );
    const expected = Array.from({ length: PROVIDERS }, (_, i) => i).filter(
      (i) => i % 15 === 0,
    ).length;
    expect(pageOf(busVerified).total).toBe(expected);
    // The type's name is searchable too.
    expect(
      pageOf(await call(admin, "get", `/api/v1/admin/providers?q=bus%20operator&pageSize=1`)).total,
    ).toBeGreaterThanOrEqual(
      Array.from({ length: PROVIDERS }, (_, i) => i).filter((i) => i % 5 === 0).length,
    );
    expect(pageOf(await call(admin, "get", `/api/v1/admin/providers?q=nothing-${tag}`)).total).toBe(
      0,
    );
  });

  it("bad parameters are 400; non-admins are 403", async () => {
    for (const bad of ["pageSize=101", "sort=random", "q=", "q=%20%20"]) {
      expect(codeOf(await call(admin, "get", `/api/v1/admin/providers?${bad}`))).toEqual([
        400,
        "VALIDATION_ERROR",
      ]);
    }
    expect(codeOf(await call(customer, "get", `/api/v1/admin/providers?q=${tag}`))).toEqual([
      403,
      "FORBIDDEN",
    ]);
  });

  it("the number of queries does not grow with the page size (no N+1)", async () => {
    const countFor = async (url: string) => {
      operations = 0;
      expect((await call(admin, "get", url)).status).toBe(200);
      return operations;
    };
    const small = await countFor(`/api/v1/admin/providers?q=${tag}&pageSize=5`);
    const large = await countFor(`/api/v1/admin/providers?q=${tag}&pageSize=100`);
    expect(large).toBe(small);
    expect(large).toBeLessThanOrEqual(6); // session + user lookups, rows, count
  });
});

describe("gap 25: audit log actor names", () => {
  it("shows the actor's name (no contact data); a system row has no actor", async () => {
    const partner = await signUp("audited-partner");
    const onboarded = await call(partner, "post", "/api/v1/partner/onboarding", {
      providerTypeCode: "hotel",
      legalName: "Audited Lodge",
      displayName: "Audited Lodge",
    });
    const providerId = dataOf<{ id: string }>(onboarded).id;
    await prisma.auditLog.create({
      data: { action: "provider.system.check", entityType: "provider", entityId: providerId },
    });
    const res = await call(
      admin,
      "get",
      `/api/v1/admin/audit-log?entityType=provider&entityId=${providerId}`,
    );
    const rows = dataOf<{ action: string; actor: unknown }[]>(res);
    expect(rows.map((r) => [r.action, r.actor])).toEqual([
      ["provider.system.check", null],
      [
        "provider.create",
        { userId: partner.userId, role: "CUSTOMER", name: "audited-partner Person" },
      ],
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/@test\.local|passwordHash|tokenHash/);
  });

  it("names are loaded per page, not per row", async () => {
    const entityId = `bulk-${tag}`;
    await prisma.auditLog.createMany({
      data: Array.from({ length: 100 }, (_, i) => ({
        actorUserId: admin.userId,
        actorRole: "ADMIN" as const,
        action: "provider.bulk.check",
        entityType: "provider",
        entityId,
        after: { i },
      })),
    });
    const countFor = async (pageSize: number) => {
      operations = 0;
      const res = await call(
        admin,
        "get",
        `/api/v1/admin/audit-log?entityId=${entityId}&pageSize=${pageSize}`,
      );
      expect(
        dataOf<{ actor: { name: string } }[]>(res).every(
          (r) => r.actor.name === "lists-admin Person",
        ),
      ).toBe(true);
      expect(pageOf(res).total).toBe(100);
      return operations;
    };
    expect(await countFor(100)).toBe(await countFor(5));
  });
});

describe("gap 25: invoices and payouts", () => {
  async function bookAndConfirm(method: "pay_at_property" | "online", day: number) {
    const trip = dataOf<{ id: string }>(
      await call(customer, "post", "/api/v1/trips", { currency: "NPR" }),
    );
    await call(customer, "post", `/api/v1/trips/${trip.id}/items`, {
      listingId: world.listings.room.id,
      startDate: world.day(day),
      endDate: world.day(day + 1),
      quantity: 1,
      paymentMethod: method,
    });
    await call(customer, "post", `/api/v1/trips/${trip.id}/confirm`);
    if (method === "online") {
      const intent = dataOf<{ payment: { id: string } }>(
        await call(customer, "post", `/api/v1/trips/${trip.id}/payments/intent`, {
          gateway: "simulated",
        }),
      );
      await call(
        customer,
        "post",
        `/api/v1/trips/${trip.id}/payments/${intent.payment.id}/confirm`,
      );
    }
  }

  it("invoices: newest first, search by number or provider name, paging info", async () => {
    await bookAndConfirm("pay_at_property", 0);
    await bookAndConfirm("pay_at_property", 2);
    const provider = world.providers.hotelProvider;
    const mine = await call(admin, "get", `/api/v1/admin/invoices?providerId=${provider.id}`);
    const invoices =
      dataOf<{ id: string; number: string; issuedAt: string; amountMinor: string }[]>(mine);
    expect(invoices).toHaveLength(2);
    expect(invoices[0]!.issuedAt >= invoices[1]!.issuedAt).toBe(true); // newest first
    expect(pageOf(mine)).toMatchObject({ total: 2, totalPages: 1 });

    const byNumber = await call(admin, "get", `/api/v1/admin/invoices?q=${invoices[1]!.number}`);
    expect(dataOf<{ id: string }[]>(byNumber).map((i) => i.id)).toEqual([invoices[1]!.id]);
    const byName = await call(
      admin,
      "get",
      `/api/v1/admin/invoices?q=${encodeURIComponent(provider.displayName)}`,
    );
    expect(dataOf<{ id: string }[]>(byName).map((i) => i.id)).toEqual(invoices.map((i) => i.id));
    expect(moneyBoundaryViolations(mine.body)).toEqual([]);
  });

  it("payouts: search by provider name; the wildcard characters are literal", async () => {
    await bookAndConfirm("online", 3);
    const name = world.providers.hotelProvider.displayName;
    const found = await call(admin, "get", `/api/v1/admin/payouts?q=${encodeURIComponent(name)}`);
    const rows = dataOf<{ provider: { name: string }; providerPayoutMinor: string }[]>(found);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => r.provider.name === name)).toBe(true);
    expect(moneyBoundaryViolations(found.body)).toEqual([]);
    expect(dataOf<unknown[]>(await call(admin, "get", "/api/v1/admin/payouts?q=%25%25"))).toEqual(
      [],
    );
  });
});
