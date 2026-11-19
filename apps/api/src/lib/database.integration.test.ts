import { pino } from "pino";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import type { ReadinessResponse } from "../modules/health/health.routes.js";
import { resolveTestDatabase } from "../testing/test-database.js";
import { checkDatabaseConnection, createPrismaClient } from "./prisma.js";

/**
 * Integration tests run against the TEST database only (TEST_DATABASE_URL):
 * - Locally: a separate Neon branch configured in apps/api/.env.test.
 * - In CI: a temporary PostgreSQL service container (no Neon secrets in CI).
 *
 * They never skip silently: with no test database configured they fail loudly,
 * because a skipped integration suite would look like a pass.
 */
const prisma = createPrismaClient(resolveTestDatabase().pooledUrl);
const logger = pino({ level: "silent" });

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Prisma ↔ PostgreSQL", () => {
  it("connects and executes a query", async () => {
    await expect(checkDatabaseConnection(prisma)).resolves.toBeUndefined();

    const rows = await prisma.$queryRaw<{ version: string }[]>`SELECT version()`;
    expect(rows[0]?.version).toMatch(/^PostgreSQL \d+/);
  });

  it("reports the API as ready when the real database is reachable", async () => {
    const app = createApp({ logger, checkDatabase: () => checkDatabaseConnection(prisma) });

    const res = await request(app).get("/api/health/ready");

    expect(res.status).toBe(200);
    expect((res.body as ReadinessResponse).checks).toEqual({ database: "up" });
  });

  it("reports the API as unavailable when the database cannot be reached", async () => {
    // Port 1 on localhost: nothing listens there, so the connection is refused.
    const unreachable = createPrismaClient("postgresql://nobody:nothing@127.0.0.1:1/none");
    try {
      const app = createApp({ logger, checkDatabase: () => checkDatabaseConnection(unreachable) });

      const res = await request(app).get("/api/health/ready");

      expect(res.status).toBe(503);
      expect((res.body as ReadinessResponse).checks).toEqual({ database: "down" });
    } finally {
      await unreachable.$disconnect();
    }
  });
});
