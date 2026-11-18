/* eslint-disable no-console -- CLI script: prints results for a developer. */
import { resolveDirectUrl } from "../config/database-url.js";
import { loadEnvFileIfPresent, parseEnv } from "../config/env.js";
import { createPrismaClient } from "../lib/prisma.js";

/** Host and database only. Connection strings contain passwords and are never printed. */
function describeTarget(connectionString: string): string {
  const url = new URL(connectionString);
  return `${url.hostname}${url.pathname}`;
}

async function checkConnection(label: string, connectionString: string): Promise<boolean> {
  const target = describeTarget(connectionString);
  const prisma = createPrismaClient(connectionString);
  const started = performance.now();
  try {
    const rows = await prisma.$queryRaw<{ version: string }[]>`SELECT version()`;
    const elapsed = Math.round(performance.now() - started);
    console.log(`✔ ${label}: Prisma connected to ${target} in ${elapsed} ms`);
    console.log(`  ${rows[0]?.version ?? "unknown version"}`);
    return true;
  } catch (err) {
    console.error(`✖ ${label}: Prisma could not connect to ${target}`);
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
    return false;
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * `npm run db:check`: verifies Prisma can reach Neon over BOTH connections:
 * - DATABASE_URL           (pooled)  used by the running API
 * - DATABASE_URL_UNPOOLED  (direct)  used by the Prisma CLI and migrations
 */
async function main(): Promise<void> {
  loadEnvFileIfPresent();
  const env = parseEnv(process.env);
  const directUrl = resolveDirectUrl(process.env);

  const results = [await checkConnection("Pooled (API runtime)", env.DATABASE_URL)];

  if (directUrl) {
    results.push(await checkConnection("Direct (Prisma CLI)", directUrl));
  } else {
    console.error(
      "✖ DATABASE_URL_UNPOOLED is not set (needed by the Prisma CLI). See .env.example.",
    );
    results.push(false);
  }

  if (results.includes(false)) {
    console.error(
      "  Check the connection strings in apps/api/.env (sslmode=require is mandatory).",
    );
    console.error("  Neon may need a few seconds to wake an idle database; retry once.");
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
