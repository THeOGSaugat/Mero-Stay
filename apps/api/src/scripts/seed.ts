/* eslint-disable no-console -- CLI script: prints results for a developer. */
import { loadEnvFileIfPresent, parseEnv } from "../config/env.js";
import { seedDatabase } from "../db/seed.js";
import { createPrismaClient } from "../lib/prisma.js";

/**
 * `npm run db:seed`: inserts SAMPLE data into the database in DATABASE_URL.
 * Safe to run once; a second run refuses and changes nothing.
 */
async function main(): Promise<void> {
  loadEnvFileIfPresent();
  const env = parseEnv(process.env);
  const target = new URL(env.DATABASE_URL);
  const prisma = createPrismaClient(env.DATABASE_URL);
  try {
    const summary = await seedDatabase(prisma);
    console.log(`✔ Sample data inserted into ${target.hostname}${target.pathname}`);
    console.log(`  ${JSON.stringify(summary)}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(`✖ ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
