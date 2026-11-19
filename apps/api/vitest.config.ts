import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.test.ts"],
          exclude: ["src/**/*.integration.test.ts"],
        },
      },
      {
        test: {
          name: "integration",
          environment: "node",
          include: ["src/**/*.integration.test.ts"],
          // Wipes and migrates the TEST database once per run (src/testing/global-setup.ts).
          globalSetup: ["src/testing/global-setup.ts"],
          // Never let test workers read the developer's .env (dev database).
          env: { MEROSTAY_SKIP_ENV_FILE: "1" },
          // One shared database: run files one after another.
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
