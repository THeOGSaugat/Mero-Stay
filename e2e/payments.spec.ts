import { expect, test, type Page } from "@playwright/test";

/**
 * Phase 11 journeys (ADR 0017; disposable database only): a customer pays a confirmed trip online
 * with eSewa or Khalti. The browser goes to the gateway (a local fake that follows the documented
 * contract: no network, no real keys, no real money), comes back to /payments/…, and the API
 * verifies the payment server to server before the trip is marked paid. A cancelled payment is
 * not paid, and the customer can try again.
 */

interface World {
  paymentCustomers: Record<string, { esewa: string; khalti: string }>;
  paymentPassword: string;
  busId: string;
  days: string[];
}

const world: World | null = process.env.E2E_WORLD
  ? (JSON.parse(process.env.E2E_WORLD) as World)
  : null;

async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login?next=%2Ftrips");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/trips$/);
}

/** One online bus seat (Rs 1,800.00), confirmed through the API; returns the trip id. */
async function confirmedTrip(page: Page): Promise<string> {
  const csrf = await page.evaluate(async () => {
    const res = await fetch("/api/v1/auth/me", { credentials: "include" });
    return ((await res.json()) as { data: { csrfToken: string } }).data.csrfToken;
  });
  const headers = { "X-CSRF-Token": csrf };
  const created = await page.request.post("/api/v1/trips", { headers, data: { currency: "NPR" } });
  expect(created.status()).toBe(201);
  const tripId = ((await created.json()) as { data: { id: string } }).data.id;
  const item = await page.request.post(`/api/v1/trips/${tripId}/items`, {
    headers,
    data: {
      listingId: world!.busId,
      startDate: world!.days[1],
      quantity: 1,
      paymentMethod: "online",
    },
  });
  expect(item.status()).toBe(201);
  expect((await page.request.post(`/api/v1/trips/${tripId}/confirm`, { headers })).status()).toBe(
    200,
  );
  return tripId;
}

async function startPayment(page: Page, tripId: string, label: "eSewa" | "Khalti") {
  await page.goto(`/trips/${tripId}`);
  const pay = page.getByRole("region", { name: "Pay online" });
  await expect(pay).toContainText("Rs 1,800.00");
  await pay.getByLabel(label).check();
  await pay.getByRole("button", { name: `Pay Rs 1,800.00 with ${label}` }).click();
  await expect(page.getByRole("heading", { name: `${label} (test)` })).toBeVisible();
}

async function expectPaid(page: Page, gateway: string, tripId: string) {
  await expect(page).toHaveURL(new RegExp(`/payments/${gateway}/return/[0-9a-f-]{36}`));
  await expect(page.getByTestId("payment-outcome")).toContainText("Payment received");
  await page.getByRole("link", { name: "Back to your trip" }).click();
  await expect(page).toHaveURL(new RegExp(`/trips/${tripId}$`));
  await expect(page.getByTestId("trip-item")).toContainText("Paid");
  await expect(page.getByRole("region", { name: "Pay online" })).toHaveCount(0);
  // Coming back to the return page again (reload, back button) changes nothing.
  await page.goBack();
  await expect(page.getByTestId("payment-outcome")).toContainText("Payment received");
}

test.describe("Phase 11: paying online with eSewa and Khalti", () => {
  test.skip(!world, "Set E2E_DATABASE_URL to a disposable database to run these journeys.");

  test("eSewa: cancel, then pay; the trip is marked paid after verification", async ({
    page,
  }, testInfo) => {
    const w = world!;
    await login(page, w.paymentCustomers[testInfo.project.name]!.esewa, w.paymentPassword);
    const tripId = await confirmedTrip(page);

    // Cancel at eSewa: back on the failure page, the API asks eSewa; nothing is paid.
    await startPayment(page, tripId, "eSewa");
    await page.getByRole("button", { name: "Cancel eSewa payment" }).click();
    await expect(page).toHaveURL(/\/payments\/esewa\/failure\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId("payment-outcome")).toContainText("Payment not completed");
    await page.getByRole("link", { name: "Back to your trip" }).click();

    // Pay: eSewa redirects back with its signed response; the API verifies it.
    await startPayment(page, tripId, "eSewa");
    await page.getByRole("button", { name: "Pay with test eSewa" }).click();
    await expectPaid(page, "esewa", tripId);
  });

  test("Khalti: cancel, then pay; the trip is marked paid after lookup", async ({
    page,
  }, testInfo) => {
    const w = world!;
    await login(page, w.paymentCustomers[testInfo.project.name]!.khalti, w.paymentPassword);
    const tripId = await confirmedTrip(page);

    await startPayment(page, tripId, "Khalti");
    await page.getByRole("button", { name: "Cancel Khalti payment" }).click();
    await expect(page).toHaveURL(/\/payments\/khalti\/return\/[0-9a-f-]{36}\?pidx=/);
    await expect(page.getByTestId("payment-outcome")).toContainText("Payment not completed");
    await page.getByRole("link", { name: "Back to your trip" }).click();

    await startPayment(page, tripId, "Khalti");
    await page.getByRole("button", { name: "Pay with test Khalti" }).click();
    await expectPaid(page, "khalti", tripId);
  });
});
