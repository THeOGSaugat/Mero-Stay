import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "prisma/config";
import { resolveDirectUrl } from "./src/config/database-url.js";

// Load apps/api/.env for Prisma CLI commands when it exists (local development).
// In CI/production the variables come from the real environment instead.
// MEROSTAY_SKIP_ENV_FILE=1 is set by the test runner so that commands aimed at the
// TEST database can never fall back to the developer's dev database in .env.
const envFile = fileURLToPath(new URL("./.env", import.meta.url));
if (process.env.MEROSTAY_SKIP_ENV_FILE !== "1" && existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

// The Prisma CLI (migrate, db pull, ...) needs a DIRECT connection to Neon.
// It does not work through Neon's pooler (PgBouncer). The running API uses the
// pooled DATABASE_URL instead (see src/lib/prisma.ts).
// It is derived from DATABASE_URL (drops "-pooler") unless DATABASE_URL_UNPOOLED is set.
const directUrl = resolveDirectUrl(process.env);

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    // `npm run db:seed`: sample data for local development (refuses to run twice).
    seed: "tsx src/scripts/seed.ts",
  },
  // `prisma generate` does not need a database, so the URL is optional here
  // (a fresh clone can generate before .env exists). Commands that do need a
  // database fail clearly if it is missing.
  ...(directUrl ? { datasource: { url: directUrl } } : {}),
});
