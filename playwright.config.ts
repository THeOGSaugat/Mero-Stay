import { randomBytes } from "node:crypto";
import { defineConfig, devices } from "@playwright/test";

const isCI = Boolean(process.env.CI);

/**
 * Booking journey mode (Phase 7): set E2E_DATABASE_URL to a DISPOSABLE database (never dev).
 * The API then runs against it with a throwaway session secret, a seeded test world is created
 * (e2e/global-setup.ts) and the journeys run: e2e/booking.spec.ts (customer, Track A) and
 * e2e/partner.spec.ts (partner dashboard, Track B). Servers are never reused in this mode, so a
 * developer's API already running against the dev database cannot be picked up by mistake.
 */
const bookingDatabase = process.env.E2E_DATABASE_URL;
// Booking mode uses its own ports so it never collides with (or proxies to) a running
// `npm run dev` on 3000/4000. The web build must point at this API: `npm run test:e2e:booking`
// builds with API_URL=http://localhost:4100 (Next.js bakes the /api/v1 rewrite in at build time).
const API_PORT = bookingDatabase ? 4100 : 4000;
const WEB_PORT = bookingDatabase ? 3100 : 3000;
const apiEnv: Record<string, string> = bookingDatabase
  ? {
      NODE_ENV: "test",
      PORT: String(API_PORT),
      LOG_LEVEL: "warn",
      MEROSTAY_SKIP_ENV_FILE: "1",
      DATABASE_URL: bookingDatabase,
      SESSION_SECRET: randomBytes(48).toString("base64"),
      // Test-mode gateway (refused in production) so the partner journey has an online-paid
      // booking for the payout summary. The customer UI still offers no online payment.
      PAYMENT_GATEWAY: "simulated",
    }
  : { NODE_ENV: "production", PORT: String(API_PORT), LOG_LEVEL: "warn" };

/**
 * End-to-end tests run against PRODUCTION builds of the API and web app.
 * `npm run test:e2e` builds first. By default the API uses apps/api/.env (dev) and only the
 * read-only Phase 1 checks run; see E2E_DATABASE_URL below for the booking journey.
 */
export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
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
      reuseExistingServer: !isCI && !bookingDatabase,
      timeout: 60_000,
      env: apiEnv,
    },
    {
      command: "npm run start -w @merostay/web",
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: !isCI && !bookingDatabase,
      timeout: 60_000,
      // `next start` listens on PORT (default 3000).
      env: { API_URL: `http://localhost:${API_PORT}`, PORT: String(WEB_PORT) },
    },
  ],
});
