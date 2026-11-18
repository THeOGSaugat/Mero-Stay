import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "prisma/config";

// Load apps/api/.env for Prisma CLI commands when it exists (local development).
// In CI/production the variables come from the real environment instead.
const envFile = fileURLToPath(new URL("./.env", import.meta.url));
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

const databaseUrl = process.env.DATABASE_URL;

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  // `prisma generate` does not need a database, so the URL is optional here.
  // Commands that do (migrate, db pull) will fail clearly if it is missing.
  ...(databaseUrl ? { datasource: { url: databaseUrl } } : {}),
});
