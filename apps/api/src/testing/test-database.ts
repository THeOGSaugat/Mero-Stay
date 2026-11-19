import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { deriveDirectUrl } from "../config/database-url.js";

/**
 * Locates the TEST database. Integration tests WIPE this database on every run,
 * so this module is deliberately strict:
 *
 * - It only reads TEST_DATABASE_URL (from the environment, or apps/api/.env.test).
 *   It never falls back to DATABASE_URL.
 * - It refuses to continue if the test URL points at the same database as the
 *   developer's DATABASE_URL / DATABASE_URL_UNPOOLED (environment or apps/api/.env).
 */

export const API_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export interface TestDatabase {
  /** Pooled URL, as the running API would use. */
  pooledUrl: string;
  /** Direct URL for migrations and resets. */
  directUrl: string;
}

function readEnvFile(fileName: string): Record<string, string | undefined> {
  const path = `${API_ROOT}${fileName}`;
  return existsSync(path) ? parseEnv(readFileSync(path, "utf8")) : {};
}

/** host:port/database, with Neon's "-pooler" removed so pooled and direct URLs compare equal. */
export function databaseIdentity(url: string): string {
  const parsed = new URL(url);
  const host = parsed.hostname.replace(/-pooler(?=\.)/, "");
  return `${host}:${parsed.port || "5432"}${parsed.pathname}`;
}

export function resolveTestDatabase(): TestDatabase {
  const testFile = readEnvFile(".env.test");
  // `||` (not `??`): an empty value such as `TEST_DATABASE_URL_UNPOOLED=` counts as unset.
  const pooledUrl = process.env.TEST_DATABASE_URL || testFile.TEST_DATABASE_URL;
  if (!pooledUrl) {
    throw new Error(
      "TEST_DATABASE_URL is not set. Integration tests need a SEPARATE database that they may wipe. " +
        "Create a Neon branch named `test`, copy apps/api/.env.test.example to apps/api/.env.test " +
        "and paste that branch's connection string. See docs/development/local-setup.md.",
    );
  }
  const directUrl =
    process.env.TEST_DATABASE_URL_UNPOOLED ||
    testFile.TEST_DATABASE_URL_UNPOOLED ||
    deriveDirectUrl(pooledUrl);

  const devFile = readEnvFile(".env");
  const devUrls = [
    process.env.DATABASE_URL,
    process.env.DATABASE_URL_UNPOOLED,
    devFile.DATABASE_URL,
    devFile.DATABASE_URL_UNPOOLED,
  ].filter((url): url is string => Boolean(url));

  const testIds = new Set([databaseIdentity(pooledUrl), databaseIdentity(directUrl)]);
  for (const devUrl of devUrls) {
    if (testIds.has(databaseIdentity(devUrl))) {
      throw new Error(
        "Refusing to run: TEST_DATABASE_URL points at the same database as DATABASE_URL. " +
          "Integration tests wipe their database; use a separate Neon branch for tests.",
      );
    }
  }

  return { pooledUrl, directUrl };
}
