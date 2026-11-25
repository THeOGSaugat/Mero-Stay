import { expect, test } from "@playwright/test";

/**
 * Customer booking journey (Phase 7 Track A), against a seeded DISPOSABLE database
 * (E2E_DATABASE_URL, see playwright.config.ts). Skipped when no such database is configured.
 *
 * register → log out → log in → search → add a hotel room (pay at property) and two bus seats
 * (online) → quote → confirm → see the trip in history. Every amount on screen is checked as the
 * exact formatted string the API's minor units produce.
 */

interface World {
  provinceSlug: string;
  roomId: string;
  roomTitle: string;
  busId: string;
  busTitle: string;
  days: string[];
}

const world: World | null = process.env.E2E_WORLD
  ? (JSON.parse(process.env.E2E_WORLD) as World)
  : null;

test.describe("customer booking journey", () => {
  test.skip(!world, "Set E2E_DATABASE_URL to a disposable database to run the booking journey.");

  test.beforeAll(async ({ request }) => {
    // Safety: the web app's /api/v1 proxy must reach the E2E API (the seeded database), not a
    // developer's API. Only the E2E database knows the seeded province.
    const res = await request.get(`/api/v1/listings?location=${world!.provinceSlug}`);
    if (res.status() !== 200) {
      throw new Error(
        `The web proxy does not reach the E2E API (status ${res.status()}). ` +
          "Run `npm run test:e2e:booking` so the web build points at http://localhost:4100.",
      );
    }
  });

  test("register, log in, search, build a hotel + bus trip, quote, confirm, see it in history", async ({
    page,
  }, testInfo) => {
    const w = world!;
    const [, day1, , day3] = w.days as [string, string, string, string];
    const email = `e2e-${testInfo.project.name}-${Date.now()}@example.com`;
    const password = "a long e2e passphrase";

    // Register (lands on search), then log out and log back in.
    await page.goto("/register");
    await page.getByLabel("Full name").fill("Sita Sharma");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel(/^Password/).fill(password);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page).toHaveURL(/\/search/);
    await page.getByRole("button", { name: "Log out" }).click();
    await expect(page.getByRole("link", { name: "Log in" })).toBeVisible();

    await page.getByRole("link", { name: "Log in" }).click();
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill("wrong password, long enough");
    await page.getByRole("button", { name: "Log in" }).click();
    // Scoped to the form: Next.js also renders a route announcer with role="alert".
    await expect(page.locator("form").getByRole("alert")).toHaveText(
      "Email or password is incorrect.",
    );
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).toHaveURL(/\/search/);

    // Search hotel rooms in the seeded province for two nights.
    await page.goto(
      `/search?type=hotel_room&location=${w.provinceSlug}&startDate=${day1}&endDate=${day3}&quantity=1`,
    );
    await expect(page.getByRole("link", { name: w.roomTitle })).toBeVisible();
    // Scoped to the room's visible result card: while results stream in, React briefly keeps a
    // hidden copy of them in the DOM, which a page-wide getByText would also match (seen in CI).
    const roomCard = page
      .getByRole("listitem")
      .filter({ has: page.getByRole("link", { name: w.roomTitle }) });
    await expect(roomCard.getByText("Rs 7,700.00 for 1 × 2 nights")).toBeVisible();
    await page.getByRole("link", { name: w.roomTitle }).click();

    // Listing detail: priced calendar (the festival price on the first night), then add to trip.
    await expect(page.getByRole("heading", { level: 1, name: w.roomTitle })).toBeVisible();
    await expect(page.getByRole("cell", { name: "Rs 4,200.00" })).toBeVisible();
    await page.getByLabel("Payment").selectOption("pay_at_property");
    await page.getByRole("button", { name: "Add to trip" }).click();
    await expect(page.getByText(`${w.roomTitle} was added to your trip.`)).toBeVisible();

    // Add two bus seats (online) from the bus listing page.
    await page.goto(`/listings/${w.busId}?startDate=${day1}&quantity=2`);
    await page.getByRole("button", { name: "Add to trip" }).click();
    await expect(page.getByText(`${w.busTitle} was added to your trip.`)).toBeVisible();

    // Trip builder: both items with their totals, then the API's quote.
    await page.goto("/trip");
    await expect(page.getByTestId("trip-item")).toHaveCount(2);
    const totals = page.getByTestId("trip-totals");
    await expect(totals).toContainText("Rs 13,171.10"); // 9,571.10 + 3,600.00
    await expect(totals).toContainText("Rs 9,571.10"); // pay at the property
    await expect(totals).toContainText("Rs 3,600.00"); // pay online
    await page.getByRole("button", { name: "Get quote" }).click();
    const quote = page.getByTestId("quote-table");
    await expect(quote).toContainText("Rs 7,700.00");
    await expect(quote).toContainText("Rs 1,101.10");
    await expect(page.getByTestId("quote-totals")).toContainText("Rs 13,171.10");

    // Confirm: the stay is confirmed (pay at property); the bus waits for online payment.
    await page.getByRole("button", { name: "Confirm trip" }).click();
    await expect(page).toHaveURL(/\/trips\/[0-9a-f-]{36}\?confirmed=1/);
    await expect(page.getByRole("status").first()).toContainText(
      "1 pay-at-property item is confirmed; 1 online item is reserved and waiting for online payment",
    );

    // History lists the trip; its detail shows the same totals.
    await page.goto("/trips");
    const entry = page.getByRole("listitem").filter({ hasText: w.roomTitle });
    await expect(entry).toContainText("Awaiting payment");
    await expect(entry).toContainText("Rs 13,171.10");
    await entry.getByRole("link").click();
    await expect(page.getByTestId("trip-totals")).toContainText("Rs 13,171.10");

    // Log out → home.
    await page.getByRole("button", { name: "Log out" }).click();
    await expect(page).toHaveURL(/\/$/);
  });

  test("a protected page sends a visitor to log in", async ({ page }) => {
    await page.goto("/trips");
    await expect(page).toHaveURL(/\/login\?next=%2Ftrips/);
  });
});
