import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

/**
 * Playwright global setup. When E2E_DATABASE_URL names a DISPOSABLE database, it seeds a fresh
 * test world there (apps/api/src/testing/e2e-world.ts, which refuses the dev database) and passes
 * the world's ids to the booking tests through E2E_WORLD. Without E2E_DATABASE_URL the booking
 * journey is skipped and only the Phase 1 checks run.
 */
export default function globalSetup(): void {
  if (!process.env.E2E_DATABASE_URL) return;
  // Playwright loads this file as CommonJS, so __dirname (not import.meta) is available.
  const apiRoot = resolve(__dirname, "../apps/api");
  const output = execFileSync("npx", ["tsx", "src/testing/e2e-world.ts"], {
    cwd: apiRoot,
    env: process.env,
    encoding: "utf8",
  });
  const json = output.trim().split("\n").at(-1) ?? "";
  JSON.parse(json); // fail early on unexpected output
  process.env.E2E_WORLD = json;
}
