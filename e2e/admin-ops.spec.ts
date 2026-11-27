import { expect, test, type BrowserContext, type Page } from "@playwright/test";

/**
 * Phase 12 journeys (ADR 0018; disposable database only, seeded per project by e2e-world.ts):
 * - gap 15: an admin approves a listing waiting for review; it becomes public;
 * - gap 16: an admin prepares last month's payout, schedules it, records the bank transfer; the
 *   partner sees it paid with the reference masked;
 * - gap 34: an admin handles a late payment and sees the refund request (not executed);
 * - gap 9: an admin adds an admin; the new admin sets a password with the one-time link and logs in.
 *
 * Serial, with ONE admin and ONE partner login per project shared by the tests: every E2E browser
 * comes from the same address, and the API's per-client login limit (30 per 15 minutes) is real.
 */

interface ProjectWorld {
  adminEmail: string;
  partnerEmail: string;
  providerId: string;
  pendingListingId: string;
  pendingListingTitle: string;
  payoutPeriod: string;
  payoutNetMinor: string;
  lateAmountMinor: string;
  lateTripReference: string;
  lateRefundReason: string;
}

interface World {
  phase12Password: string;
  phase12: { desktop: ProjectWorld; mobile: ProjectWorld };
}

const world: World | null = process.env.E2E_WORLD
  ? (JSON.parse(process.env.E2E_WORLD) as World)
  : null;

const projectOf = (name: string): "desktop" | "mobile" =>
  name.startsWith("mobile") ? "mobile" : "desktop";

/** "306000" paisa → "Rs. 3,060.00" (only to build expectations; the UI formats the API's string). */
function rupees(minor: string): string {
  const whole = minor.slice(0, -2) || "0";
  return `Rs. ${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${minor.slice(-2).padStart(2, "0")}`;
}

async function login(page: Page, email: string, password: string, next: string): Promise<void> {
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(new RegExp(next.replace(/[/?]/g, "\\$&")));
}

test.describe("Phase 12: payouts and admin moderation", () => {
  test.skip(!world, "Set E2E_DATABASE_URL to a disposable database to run these journeys.");
  test.describe.configure({ mode: "serial" });

  let p: ProjectWorld;
  let adminContext: BrowserContext;
  let partnerContext: BrowserContext;
  let admin: Page;
  let partner: Page;

  test.beforeAll(async ({ browser }, testInfo) => {
    p = world!.phase12[projectOf(testInfo.project.name)];
    const options = testInfo.project.use;
    adminContext = await browser.newContext(options);
    partnerContext = await browser.newContext(options);
    admin = await adminContext.newPage();
    partner = await partnerContext.newPage();
    await login(admin, p.adminEmail, world!.phase12Password, "/admin");
    await login(partner, p.partnerEmail, world!.phase12Password, "/partner/payouts");
  });

  test.afterAll(async () => {
    await adminContext?.close();
    await partnerContext?.close();
  });

  test("an admin approves a listing waiting for review; it becomes public", async () => {
    expect((await admin.request.get(`/api/v1/listings/${p.pendingListingId}`)).status()).toBe(404);
    await admin.goto("/admin/listings");
    const card = admin.locator(
      `[data-testid="review-listing"][data-listing="${p.pendingListingId}"]`,
    );
    await expect(card).toContainText(p.pendingListingTitle);
    await expect(card.getByTestId("review-type-rule")).toHaveText(
      "Allowed for this kind of business",
    );
    await card.getByRole("button", { name: "Approve" }).click();
    await expect(card).toHaveCount(0);

    await admin.goto(`/listings/${p.pendingListingId}`);
    await expect(
      admin.getByRole("heading", { level: 1, name: p.pendingListingTitle }),
    ).toBeVisible();
  });

  test("an admin pays out last month by recorded bank transfer; the partner sees it paid", async ({}, testInfo) => {
    await admin.goto("/admin/payouts");
    // The month field defaults to last month, which is the seeded one.
    const month = admin.getByLabel("Service month");
    if ((await month.inputValue()) !== p.payoutPeriod) await month.fill(p.payoutPeriod);
    await admin.getByRole("button", { name: "Prepare payouts" }).click();
    // The other project may have prepared this month already: either message is fine.
    await expect(admin.getByTestId("payout-generate-outcome")).toBeVisible();
    await admin.goto("/admin/payouts?status=PENDING");
    const row = admin.locator(`[data-testid="payout-batch-row"][data-provider="${p.providerId}"]`);
    await expect(row.getByTestId("payout-batch-net")).toHaveText(rupees(p.payoutNetMinor));
    await row.getByRole("button", { name: /^Open payout for / }).click();

    const detail = admin.getByTestId("payout-batch-detail");
    await expect(detail.getByTestId("payout-detail-net")).toHaveText(rupees(p.payoutNetMinor));
    await detail.getByRole("button", { name: "Schedule transfer" }).click();
    await expect(detail).toContainText("To: Nabil Bank · ••••");
    const reference = `NABIL-E2E-${testInfo.project.name.length}${Date.now() % 100000}`;
    await detail.getByLabel("Bank transfer reference").fill(reference);
    await detail.getByRole("button", { name: "Record as paid" }).click();
    await expect(detail).toContainText(`Bank reference ••••${reference.slice(-4)}`);
    await expect(detail).not.toContainText(reference);

    // The partner sees the transfer, reference masked.
    await partner.goto("/partner/payouts");
    const batch = partner.getByTestId("partner-payout-batch").first();
    await expect(batch).toContainText("Paid");
    await expect(batch).toContainText(rupees(p.payoutNetMinor));
    await expect(batch).toContainText(`••••${reference.slice(-4)}`);
  });

  test("an admin handles a late payment and sees the refund request (not executed)", async () => {
    await admin.goto("/admin/late-payments");
    const card = admin.getByTestId("late-payment").filter({ hasText: p.lateTripReference });
    await expect(card).toContainText(rupees(p.lateAmountMinor));
    await expect(card).toContainText("Paid after the booking hold ended");
    await expect(card).toContainText("Khalti");
    await card.getByLabel("What was done").fill("Refund requested; customer called back");
    await card.getByRole("button", { name: "Mark as handled" }).click();
    await expect(card).toHaveCount(0);
    await admin.getByRole("button", { name: "Handled", exact: true }).click();
    await expect(
      admin.getByTestId("late-payment").filter({ hasText: p.lateTripReference }),
    ).toContainText("Refund requested; customer called back");

    await admin.goto("/admin/refund-requests");
    const refund = admin.getByTestId("refund-request").filter({ hasText: p.lateRefundReason });
    await expect(refund).toContainText(rupees(p.lateAmountMinor));
    await expect(refund).toContainText("Requested (not executed)");
    await expect(refund).toContainText("For a late payment");
  });

  test("an admin adds an admin; the new admin sets a password with the one-time link", async ({
    browser,
  }, testInfo) => {
    await admin.goto("/admin/admins");
    const email = `new-admin-${testInfo.project.name}-${Date.now()}@example.com`;
    await admin.getByLabel("Email").fill(email);
    await admin.getByLabel("Full name").fill("Sita Admin");
    await admin.getByRole("button", { name: "Add admin" }).click();
    const url = (await admin.getByTestId("admin-setup-url").textContent())!.trim();
    expect(url).toMatch(/\/admin-setup#token=[A-Za-z0-9_-]{43}$/);
    await expect(
      admin.locator(`[data-testid="admin-account-row"][data-email="${email}"]`),
    ).toContainText("Invited (no password yet)");

    // The new admin, in their own browser.
    const context = await browser.newContext(testInfo.project.use);
    const newAdmin = await context.newPage();
    try {
      await newAdmin.goto(url);
      const password = "a long new admin passphrase";
      await newAdmin.getByLabel("New password (at least 12 characters)").fill(password);
      await newAdmin.getByLabel("Repeat the password").fill(password);
      await newAdmin.getByRole("button", { name: "Set password" }).click();
      await expect(newAdmin.getByTestId("admin-setup-done")).toBeVisible();
      await expect(newAdmin).not.toHaveURL(/#token=/);
      // The link works once (opened again in a new tab: a fresh page load).
      const again = await context.newPage();
      await again.goto(url);
      await again
        .getByLabel("New password (at least 12 characters)")
        .fill("another long passphrase");
      await again.getByLabel("Repeat the password").fill("another long passphrase");
      await again.getByRole("button", { name: "Set password" }).click();
      await expect(
        again.getByRole("alert").filter({ hasText: "invalid, already used or expired" }),
      ).toBeVisible();
      await login(newAdmin, email, password, "/admin");
      await expect(newAdmin.getByRole("link", { name: "Admins" }).first()).toBeVisible();
    } finally {
      await context.close();
    }
    await admin.reload();
    await expect(
      admin.locator(`[data-testid="admin-account-row"][data-email="${email}"]`),
    ).toContainText("Active");
  });

  test("a partner cannot open the admin queues", async () => {
    for (const path of ["/admin/listings", "/admin/late-payments", "/admin/admins"]) {
      await partner.goto(path);
      await expect(partner.getByTestId("admin-not-found")).toBeVisible();
    }
  });
});
