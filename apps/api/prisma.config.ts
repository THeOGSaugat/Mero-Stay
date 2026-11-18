import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "prisma/config";

// Load apps/api/.env for Prisma CLI commands when it exists (local development).
// In CI/production the variables come from the real environment instead.
const envFile = fileURLToPath(new URL("./.env", import.meta.url));
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

// The Prisma CLI (migrate, db pull, ...) needs a DIRECT connection to Neon.
// It does not work through Neon's pooler (PgBouncer). The running API uses the
// pooled DATABASE_URL instead (see src/lib/prisma.ts).
const directUrl = process.env.DATABASE_URL_UNPOOLED;

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  // `prisma generate` does not need a database, so the URL is optional here
  // (a fresh clone can generate before .env exists). Commands that do need a
  // database fail clearly if it is missing.
  ...(directUrl ? { datasource: { url: directUrl } } : {}),
});
