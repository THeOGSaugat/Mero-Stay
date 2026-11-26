import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const isCI = Boolean(process.env.CI);

/**
 * Booking journey mode (Phase 7): set E2E_DATABASE_URL to a DISPOSABLE database (never dev).
 * The API then runs against it with a throwaway session secret, a seeded test world is created
 * (e2e/global-setup.ts) and the journeys run: e2e/booking.spec.ts (customer, Track A) and
 * e2e/partner.spec.ts (partner dashboard, Track B) and e2e/admin.spec.ts (admin console, Track C). Servers are never reused in this mode, so a
 * developer's API already running against the dev database cannot be picked up by mistake.
 */
const bookingDatabase = process.env.E2E_DATABASE_URL;
// Booking mode uses its own ports so it never collides with (or proxies to) a running
// `npm run dev` on 3000/4000. The web build must point at this API: `npm run test:e2e:booking`
// builds with API_URL=http://localhost:4100 (Next.js bakes the /api/v1 rewrite in at build time).
const API_PORT = bookingDatabase ? 4100 : 4000;
const WEB_PORT = bookingDatabase ? 3100 : 3000;
// The web server (apps/web/server.mts) runs on this machine and appends the browser's address to
// X-Forwarded-For; the API trusts it for exactly one hop from loopback (ADR 0014, gap 5).
const trustWebServer = { TRUST_PROXY_HOPS: "1", TRUST_PROXY_ADDRESSES: "loopback" };
// Verification documents (ADR 0016) go to a fresh temporary directory: local disk, no secrets,
// never the developer's apps/api/.storage. Only the main process starts the servers, so test
// workers (which load this file too) do not create directories.
const documentStorage = {
  STORAGE_DRIVER: "local",
  STORAGE_LOCAL_DIR:
    process.env.TEST_WORKER_INDEX === undefined
      ? mkdtempSync(join(tmpdir(), "merostay-e2e-docs-"))
      : join(tmpdir(), "merostay-e2e-docs-unused"),
};
// Payments (ADR 0017): local fake eSewa and Khalti (apps/api/src/testing/fake-gateways.ts) with
// random test keys per run; no network, no real keys, no real money. Generated in the main process
// only (the servers' environment comes from here); workers never use them.
// Not 4190: it is on the fetch "bad ports" list (Node refuses it; browsers may not).
const FAKE_GATEWAYS_PORT = 4180;
const gatewayKeys = {
  ESEWA_PRODUCT_CODE: "EPAYTEST",
  ESEWA_SECRET_KEY: randomBytes(24).toString("base64"),
  KHALTI_SECRET_KEY: `test_${randomBytes(16).toString("hex")}`,
};
const fakeGatewayUrl = `http://127.0.0.1:${FAKE_GATEWAYS_PORT}`;
const apiEnv: Record<string, string> = bookingDatabase
  ? {
      ...trustWebServer,
      ...documentStorage,
      NODE_ENV: "test",
      PORT: String(API_PORT),
      LOG_LEVEL: "warn",
      MEROSTAY_SKIP_ENV_FILE: "1",
      DATABASE_URL: bookingDatabase,
      SESSION_SECRET: randomBytes(48).toString("base64"),
      // eSewa and Khalti through the fakes; the simulated gateway (refused in production) gives
      // the partner and admin journeys online-paid bookings through the API.
      ...gatewayKeys,
      PAYMENT_GATEWAYS: "esewa,khalti,simulated",
      PAYMENT_MODE: "uat",
      PUBLIC_WEB_URL: `http://localhost:${WEB_PORT}`,
      // Every E2E browser logs in from this one machine; the per-client login limit (30 per 15
      // minutes) is raised for this test API only (refused in production; per-email unchanged).
      AUTH_LOGIN_PER_IP_LIMIT: "500",
      ESEWA_FORM_URL: `${fakeGatewayUrl}/esewa/form`,
      ESEWA_STATUS_URL: `${fakeGatewayUrl}/esewa/status`,
      KHALTI_API_URL: `${fakeGatewayUrl}/khalti`,
    }
  : {
      ...trustWebServer,
      ...documentStorage,
      NODE_ENV: "production",
      PORT: String(API_PORT),
      LOG_LEVEL: "warn",
    };

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
  // No retries, in CI too (gap 21). The journeys change data (a retried admin journey finds its
  // provider already approved), and each retried registration spends the API's 5-per-hour limit:
  // the deliberately broken CI probe showed retries turning one failure into extra 429 failures.
  // CI records a trace for every test and keeps it for failures (trace below) instead. Should
  // retries ever be added, failOnFlakyTests still fails a run that only passed on a retry.
  retries: 0,
  failOnFlakyTests: isCI,
  reporter: isCI
    ? [["github"], ["html", { open: "never" }]]
    : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    // CI: the failing test's trace is uploaded with the report (.github/workflows/ci.yml).
    trace: isCI ? "retain-on-failure" : "off",
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
  ],
  webServer: [
    ...(bookingDatabase
      ? [
          {
            command: "npm run fake-gateways -w @merostay/api",
            url: `${fakeGatewayUrl}/health`,
            reuseExistingServer: false,
            timeout: 60_000,
            env: {
              ...gatewayKeys,
              FAKE_GATEWAYS_PORT: String(FAKE_GATEWAYS_PORT),
              FAKE_GATEWAYS_LOG: process.env.FAKE_GATEWAYS_LOG ?? "",
              NODE_ENV: "test",
            },
          },
        ]
      : []),
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
      // apps/web/server.mts (Next.js production server + X-Forwarded-For) listens on PORT.
      env: { API_URL: `http://localhost:${API_PORT}`, PORT: String(WEB_PORT) },
    },
  ],
});
