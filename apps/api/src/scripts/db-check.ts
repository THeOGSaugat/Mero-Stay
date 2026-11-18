/* eslint-disable no-console -- CLI script: prints results for a developer. */
import { loadEnvFileIfPresent, parseEnv } from "../config/env.js";
import { createPrismaClient } from "../lib/prisma.js";

/**
 * `npm run db:check`: verifies that Prisma can connect to PostgreSQL.
 * Prints host/database only. The connection string (which contains the
 * password) is never printed.
 */
async function main(): Promise<void> {
  loadEnvFileIfPresent();
  const env = parseEnv(process.env);
  const url = new URL(env.DATABASE_URL);
  const target = `${url.hostname}:${url.port || "5432"}${url.pathname}`;

  const prisma = createPrismaClient(env.DATABASE_URL);
  const started = performance.now();
  try {
    const rows = await prisma.$queryRaw<{ version: string }[]>`SELECT version()`;
    const elapsed = Math.round(performance.now() - started);
    console.log(`✔ Prisma connected to PostgreSQL at ${target} in ${elapsed} ms`);
    console.log(`  ${rows[0]?.version ?? "unknown version"}`);
  } catch (err) {
    console.error(`✖ Prisma could not connect to PostgreSQL at ${target}`);
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
    console.error("  Is the database running? Try: npm run db:up");
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
