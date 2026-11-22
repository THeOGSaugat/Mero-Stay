/* eslint-disable no-console -- CLI script: prints the seeded world as JSON for Playwright. */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { createPrismaClient } from "../lib/prisma.js";
import { createWorld } from "./fixtures.js";
import { API_ROOT, databaseIdentity } from "./test-database.js";

/**
 * E2E seed (Playwright global setup, e2e/global-setup.ts). Prepares a DISPOSABLE database for the
 * booking journey: applies all migrations, then inserts a fresh test world (unique names, dates
 * relative to today) with the same fixture the integration tests use. Seeding directly is
 * deliberate: setting up providers and approved listings is not what the E2E test checks.
 *
 * Safety: reads only E2E_DATABASE_URL, and refuses when it points at the dev database in
 * apps/api/.env (same check as the integration-test guard). It never wipes anything.
 */
function devDatabaseIdentities(): string[] {
  const path = `${API_ROOT}.env`;
  if (!existsSync(path)) return [];
  const env = parseEnv(readFileSync(path, "utf8"));
  return [env.DATABASE_URL, env.DATABASE_URL_UNPOOLED]
    .filter((url): url is string => typeof url === "string" && url.length > 0)
    .map(databaseIdentity);
}

async function main(): Promise<void> {
  const url = process.env.E2E_DATABASE_URL;
  if (!url) throw new Error("E2E_DATABASE_URL is not set.");
  if (devDatabaseIdentities().includes(databaseIdentity(url))) {
    throw new Error(
      "Refusing to seed: E2E_DATABASE_URL points at the dev database (apps/api/.env).",
    );
  }

  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    cwd: API_ROOT,
    env: {
      ...process.env,
      MEROSTAY_SKIP_ENV_FILE: "1",
      DATABASE_URL: url,
      DATABASE_URL_UNPOOLED: "",
    },
    stdio: "pipe",
  });

  const prisma = createPrismaClient(url);
  try {
    const world = await createWorld(prisma);
    console.log(
      JSON.stringify({
        provinceSlug: world.locations.province.slug,
        roomId: world.listings.room.id,
        roomTitle: world.listings.room.title,
        busId: world.listings.bus.id,
        busTitle: world.listings.bus.title,
        days: [0, 1, 2, 3].map((n) => world.day(n)),
      }),
    );
  } finally {
    await prisma.$disconnect();
  }
}

await main();
