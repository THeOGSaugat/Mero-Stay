import { expect, test, type BrowserContext, type Page } from "@playwright/test";

/**
 * Phase 14 journeys (ADR 0020; disposable database only, seeded per project by e2e-world.ts):
 * - a customer cancels a paid booking and sees the exact refund before and after confirming;
 * - an admin approves and executes the refund (the simulated gateway refunds at once) and sees
 *   its status change;
 * - a customer cannot open the refund queue.
 *
 * Serial, with one customer and one admin login per project (the API's per-client login limit is
 * real, ADR 0014).
 */

interface ProjectWorld {
  customerEmail: string;
  adminEmail: string;
}

interface World {
  phase14Password: string;
  phase14: { desktop: ProjectWorld; mobile: ProjectWorld };
  phase14RoomId: string;
  phase14Days: [string, string];
}

const world: World | null = process.env.E2E_WORLD
  ? (JSON.parse(process.env.E2E_WORLD) as World)
  : null;

const projectOf = (name: string): "desktop" | "mobile" =>
  name.startsWith("mobile") ? "mobile" : "desktop";

async function login(page: Page, email: string, password: string, next: string): Promise<void> {
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(new RegExp(next.replace(/[/?]/g, "\\$&")));
}

/** A confirmed one-night stay paid online (simulated gateway), through the API; trip id + ref. */
async function paidStay(page: Page): Promise<{ tripId: string; reference: string }> {
  const csrf = await page.evaluate(async () => {
    const res = await fetch("/api/v1/auth/me", { credentials: "include" });
    return ((await res.json()) as { data: { csrfToken: string } }).data.csrfToken;
  });
  const headers = { "X-CSRF-Token": csrf };
  const created = await page.request.post("/api/v1/trips", { headers, data: { currency: "NPR" } });
  expect(created.status()).toBe(201);
  const trip = ((await created.json()) as { data: { id: string; reference: string } }).data;
  const [checkIn, checkOut] = world!.phase14Days;
  const item = await page.request.post(`/api/v1/trips/${trip.id}/items`, {
    headers,
    data: {
      listingId: world!.phase14RoomId,
      startDate: checkIn,
      endDate: checkOut,
      quantity: 1,
      paymentMethod: "online",
    },
  });
  expect(item.status()).toBe(201);
  expect((await page.request.post(`/api/v1/trips/${trip.id}/confirm`, { headers })).status()).toBe(
    200,
  );
  const intent = await page.request.post(`/api/v1/trips/${trip.id}/payments/intent`, {
    headers,
    data: { gateway: "simulated" },
  });
  expect(intent.status()).toBe(201);
  const paymentId = ((await intent.json()) as { data: { payment: { id: string } } }).data.payment
    .id;
  const paid = await page.request.post(`/api/v1/trips/${trip.id}/payments/${paymentId}/confirm`, {
    headers,
    data: {},
  });
  expect(paid.status()).toBe(200);
  return { tripId: trip.id, reference: trip.reference };
}

test.describe("Phase 14: cancellations and refunds", () => {
  test.skip(!world, "Set E2E_DATABASE_URL to a disposable database to run these journeys.");
  test.describe.configure({ mode: "serial" });

  let p: ProjectWorld;
  let customerContext: BrowserContext;
  let adminContext: BrowserContext;
  let customer: Page;
  let admin: Page;
  let reference: string;

  test.beforeAll(async ({ browser }, testInfo) => {
    p = world!.phase14[projectOf(testInfo.project.name)];
    customerContext = await browser.newContext(testInfo.project.use);
    adminContext = await browser.newContext(testInfo.project.use);
    customer = await customerContext.newPage();
    admin = await adminContext.newPage();
    await login(customer, p.customerEmail, world!.phase14Password, "/trips");
    await login(admin, p.adminEmail, world!.phase14Password, "/admin");
  });

  test.afterAll(async () => {
    await customerContext.close();
    await adminContext.close();
  });

  test("a customer cancels a paid stay and sees the exact refund (100%: 40 days' notice)", async () => {
    const stay = await paidStay(customer);
    reference = stay.reference;
    await customer.goto(`/trips/${stay.tripId}`);
    const item = customer.getByTestId("trip-item");
    // Check-in at the hotel's 13:00, Nepal time (the refund clock).
    await expect(item.getByTestId("item-starts")).toContainText("13:00 (Nepal time)");
    await item.getByTestId("cancel-item-start").click();
    const box = customer.getByTestId("cancel-item");
    // Rs 3,500 + 10% service charge + 13% VAT = Rs 4,350.50, all of it back.
    await expect(box.getByTestId("cancel-item-refund")).toHaveText(
      "You get Rs. 4,350.50 back (100% of Rs. 4,350.50).",
    );
    await expect(box).toContainText(
      "cancelling at least 72 hours before the start gives 100% back",
    );
    await box.getByTestId("cancel-item-confirm").click();
    await expect(customer.getByTestId("item-cancelled-note")).toHaveText(
      "You cancelled this booking: Rs. 4,350.50 (100%) is being refunded to how you paid.",
    );
    await expect(item).toContainText("Cancelled");
  });

  test("an admin approves and executes the refund, and sees it refunded", async () => {
    await admin.goto("/admin/refund-requests");
    await admin.getByRole("button", { name: "To approve" }).click();
    const card = admin.getByTestId("refund-request").filter({ hasText: `Trip ${reference}` });
    await expect(card.getByTestId("refund-request-amount")).toContainText("Rs. 4,350.50");
    await expect(card.getByTestId("refund-request-status")).toHaveText("Requested (not executed)");
    await card.getByRole("button", { name: "Approve" }).click();

    await admin.getByRole("button", { name: "Approved", exact: true }).click();
    const approved = admin.getByTestId("refund-request").filter({ hasText: `Trip ${reference}` });
    await expect(approved.getByTestId("refund-request-status")).toHaveText(
      "Approved, not sent yet",
    );
    await approved.getByRole("button", { name: "Refund through test gateway" }).click();

    await admin.getByRole("button", { name: "Refunded", exact: true }).click();
    const done = admin.getByTestId("refund-request").filter({ hasText: `Trip ${reference}` });
    await expect(done.getByTestId("refund-request-status")).toHaveText("Refunded");
    await expect(done).toContainText("Gateway reference ••••");
  });

  test("a customer cannot open the refund queue", async () => {
    await customer.goto("/admin/refund-requests");
    await expect(customer.getByTestId("admin-not-found")).toBeVisible();
    const res = await customer.request.get("/api/v1/admin/refund-requests");
    expect(res.status()).toBe(403);
  });
});
