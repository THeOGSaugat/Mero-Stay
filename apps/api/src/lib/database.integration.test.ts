import { pino } from "pino";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { resolveDirectUrl } from "../config/database-url.js";
import { loadEnvFileIfPresent } from "../config/env.js";
import type { ReadinessResponse } from "../modules/health/health.routes.js";
import { checkDatabaseConnection, createPrismaClient } from "./prisma.js";

/**
 * Integration tests: these talk to a REAL PostgreSQL instance.
 * - Locally: your Neon database, via the direct DATABASE_URL_UNPOOLED in apps/api/.env.
 * - In CI: a temporary PostgreSQL service container (no Neon secrets in CI).
 * They only run read-only queries, so they never modify data.
 *
 * These tests do NOT skip silently: with no database configured they fail loudly,
 * because a skipped integration suite would look like a pass.
 */
loadEnvFileIfPresent();
const databaseUrl = resolveDirectUrl(process.env);
if (!databaseUrl) {
  throw new Error(
    "No database configured. Copy apps/api/.env.example to apps/api/.env and set " +
      "DATABASE_URL_UNPOOLED (your Neon direct connection).",
  );
}

const prisma = createPrismaClient(databaseUrl);
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
