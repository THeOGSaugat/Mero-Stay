import { execFileSync } from "node:child_process";
import { createPrismaClient } from "../lib/prisma.js";
import { API_ROOT, resolveTestDatabase } from "./test-database.js";

/** Environment for Prisma CLI commands aimed at the test database (never reads the dev .env). */
export function testDatabaseCliEnv(): NodeJS.ProcessEnv {
  const db = resolveTestDatabase();
  return {
    ...process.env,
    MEROSTAY_SKIP_ENV_FILE: "1",
    DATABASE_URL: db.pooledUrl,
    DATABASE_URL_UNPOOLED: db.directUrl,
  };
}

/**
 * Vitest global setup for the integration project. Runs once per test run:
 * 1. empties the TEST database (drop + recreate the `public` schema),
 * 2. applies every migration with `prisma migrate deploy`, exactly as production would.
 */
export default async function setup(): Promise<void> {
  const db = resolveTestDatabase();

  const prisma = createPrismaClient(db.directUrl);
  try {
    await prisma.$executeRawUnsafe("DROP SCHEMA IF EXISTS public CASCADE");
    await prisma.$executeRawUnsafe("CREATE SCHEMA public");
  } finally {
    await prisma.$disconnect();
  }

  try {
    execFileSync("npx", ["prisma", "migrate", "deploy"], {
      cwd: API_ROOT,
      env: testDatabaseCliEnv(),
      encoding: "utf8",
      stdio: "pipe",
    });
  } catch (err) {
    const output = err as { stdout?: string; stderr?: string };
    throw new Error(
      `prisma migrate deploy failed on the test database:\n${output.stdout ?? ""}${output.stderr ?? ""}`,
    );
  }
}
