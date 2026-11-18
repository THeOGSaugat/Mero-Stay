import { expect, test } from "@playwright/test";

test.describe("home page (Phase 1 health check)", () => {
  test("renders the MeroStay landing content", async ({ page }) => {
    await page.goto("/");

    await expect(page).toHaveTitle(/MeroStay/);
    await expect(page.getByRole("link", { name: "MeroStay" })).toBeVisible();
    await expect(
      page.getByRole("heading", { level: 1, name: "Find your stay anywhere in Nepal" }),
    ).toBeVisible();
  });

  test("shows web, API and database as operational", async ({ page }) => {
    await page.goto("/");

    const status = page.getByRole("region", { name: "System status" });
    await expect(status.getByTestId("status-web")).toContainText("Operational");
    await expect(status.getByTestId("status-api")).toContainText("Operational");
    await expect(status.getByTestId("status-database")).toContainText("Operational");
    await expect(status.getByText("(Nepal time)")).toBeVisible();
  });

  test("has no horizontal scrolling", async ({ page }) => {
    await page.goto("/");

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test.describe("API health endpoints", () => {
  test("liveness and readiness respond", async ({ request }) => {
    const live = await request.get("http://localhost:4000/api/health");
    expect(live.status()).toBe(200);
    expect(await live.json()).toMatchObject({ status: "ok", service: "merostay-api" });

    const ready = await request.get("http://localhost:4000/api/health/ready");
    expect(ready.status()).toBe(200);
    expect(await ready.json()).toMatchObject({ checks: { database: "up" } });
  });
});
