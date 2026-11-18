import { defineConfig, devices } from "@playwright/test";

const API_PORT = 4000;
const WEB_PORT = 3000;
const isCI = Boolean(process.env.CI);

/**
 * End-to-end tests run against PRODUCTION builds of the API and web app.
 * `npm run test:e2e` builds first. A reachable database is required (Neon via apps/api/.env).
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  reporter: isCI
    ? [["github"], ["html", { open: "never" }]]
    : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: "on-first-retry",
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
  ],
  webServer: [
    {
      command: "npm run start -w @merostay/api",
      url: `http://localhost:${API_PORT}/api/health`,
      reuseExistingServer: !isCI,
      timeout: 60_000,
      env: { NODE_ENV: "production", PORT: String(API_PORT), LOG_LEVEL: "warn" },
    },
    {
      command: "npm run start -w @merostay/web",
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: !isCI,
      timeout: 60_000,
      env: { API_URL: `http://localhost:${API_PORT}` },
    },
  ],
});
