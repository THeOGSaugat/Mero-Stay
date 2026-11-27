import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * Admin console journey (Phase 7 Track C), against the seeded DISPOSABLE database
 * (E2E_DATABASE_URL, see playwright.config.ts). Skipped when no such database is configured.
 *
 * The admin logs in → sees providers → approves a complete provider (the audit entry is
 * confirmed) → cannot approve an incomplete one (the block is shown, and the API refuses it too)
 * → rejects it with a reason → views invoices and payouts (the API's strings) → finds the
 * approval in the audit log. A customer cannot reach the console: "Page not found", API 403.
 */

interface Pair {
  complete: { id: string; name: string };
  incomplete: { id: string; name: string };
}
interface World {
  roomId: string;
  days: string[];
  adminEmail: string;
  adminPassword: string;
  adminName: string;
  customerEmail: string;
  customerPassword: string;
  hotelProviderId: string;
  adminProviders: Record<"desktop" | "mobile", Pair>;
}

const world: World | null = process.env.E2E_WORLD
  ? (JSON.parse(process.env.E2E_WORLD) as World)
  : null;

/** "2027-01-10" → "2027-01-11" (calendar dates, UTC arithmetic). */
function nextDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function login(page: Page, email: string, password: string, next: string): Promise<void> {
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
}

async function csrfOf(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const res = await fetch("/api/v1/auth/me", { credentials: "include" });
    return ((await res.json()) as { data: { csrfToken: string } }).data.csrfToken;
  });
}

/**
 * The customer books, through the API, one night paid online (so a payout is pending) and one
 * night paid at the property (so an invoice exists). The test creates both itself and does not
 * rely on another spec having booked first (CI runs fewer workers, in a different order).
 *
 * The fixture room has 3 units a night, shared by every spec: day 0 = both partner journeys +
 * the mobile online night (full); days 1-2 = both customer journeys; day 3 = the desktop online
 * night + both projects' pay-at-property nights (full). Change these together.
 */
async function bookNights(api: APIRequestContext, w: World, date: string, next: string) {
  const res = await api.post("/api/v1/auth/login", {
    data: { email: w.customerEmail, password: w.customerPassword },
  });
  expect(res.status()).toBe(200);
  const csrf = ((await res.json()) as { data: { csrfToken: string } }).data.csrfToken;
  const post = async <T>(path: string, data: unknown = {}) => {
    const r = await api.post(`/api/v1${path}`, { data, headers: { "X-CSRF-Token": csrf } });
    if (!r.ok()) throw new Error(`${path} → ${r.status()} ${await r.text()}`);
    return (await r.json()) as T;
  };
  const trip = await post<{ data: { id: string } }>("/trips", { currency: "NPR" });
  await post(`/trips/${trip.data.id}/items`, {
    listingId: w.roomId,
    startDate: date,
    endDate: next,
    quantity: 1,
    paymentMethod: "online",
  });
  await post(`/trips/${trip.data.id}/confirm`);
  const intent = await post<{ data: { payment: { id: string } } }>(
    `/trips/${trip.data.id}/payments/intent`,
    { gateway: "simulated" },
  );
  await post(`/trips/${trip.data.id}/payments/${intent.data.payment.id}/confirm`);

  // Pay at property (always day 3, see above): confirming issues the commission invoice.
  const atProperty = await post<{ data: { id: string } }>("/trips", { currency: "NPR" });
  const day3 = w.days[3]!;
  await post(`/trips/${atProperty.data.id}/items`, {
    listingId: w.roomId,
    startDate: day3,
    endDate: nextDay(day3),
    quantity: 1,
    paymentMethod: "pay_at_property",
  });
  await post(`/trips/${atProperty.data.id}/confirm`);
}

/**
 * Gap 5 (ADR 0014): every request in this journey carries a forged X-Forwarded-For. The web
 * server appends the address it really saw, and the API believes only that entry, so the audit
 * rows below must show the loopback address, never this one.
 */
const FORGED_CLIENT_IP = "198.51.100.7";

test.describe("admin console journey", () => {
  test.skip(!world, "Set E2E_DATABASE_URL to a disposable database to run the admin journey.");
  test.use({ extraHTTPHeaders: { "X-Forwarded-For": FORGED_CLIENT_IP } });

  test("providers, approve with audit, blocked approval, reject, invoices, payouts, audit log", async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(120_000);
    const w = world!;
    const label = testInfo.project.name.startsWith("mobile") ? "mobile" : "desktop";
    const pair = w.adminProviders[label];
    // Each project pays a different night of the fixture's room, so its payout row is its own.
    const night = (label === "desktop" ? w.days[3] : w.days[0])!;
    const morning = nextDay(night);
    await bookNights(request, w, night, morning);

    await login(page, w.adminEmail, w.adminPassword, "/admin");
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByRole("link", { name: "Admin", exact: true })).toBeVisible();
    await expect(page.getByTestId("pending-count")).toHaveText(/^\d+$/);

    // Providers: search finds this project's providers by name (gap 25), newest first.
    await page.goto("/admin/providers");
    const searchForm = page.getByTestId("provider-search");
    await searchForm.getByLabel("Search").fill(pair.incomplete.name);
    await searchForm.getByRole("button", { name: "Search" }).click();
    await expect(page).toHaveURL(/q=Incomplete/);
    await expect(page.getByTestId("admin-provider-row")).toHaveCount(1);
    await expect(page.getByTestId("admin-providers")).toContainText(pair.incomplete.name);
    // Search + the status filter: the complete one, waiting for verification.
    await searchForm.getByLabel("Search").fill(pair.complete.name);
    await searchForm.getByLabel("Verification status").selectOption("PENDING_VERIFICATION");
    await searchForm.getByRole("button", { name: "Search" }).click();
    await expect(page).toHaveURL(/status=PENDING_VERIFICATION/);
    await expect(page.getByTestId("providers-total")).toHaveText("1 providers");
    await page.getByRole("link", { name: pair.complete.name }).click();
    await expect(page.getByRole("heading", { name: pair.complete.name })).toBeVisible();
    const reqs = page.getByTestId("admin-requirements");
    await expect(reqs.locator('[data-requirement="identity"]')).toHaveAttribute(
      "data-state",
      "pending",
    );
    await expect(reqs.locator('[data-requirement="registration"]')).toHaveAttribute(
      "data-state",
      "pending",
    );
    await expect(page.getByTestId("admin-account-masked")).toHaveText("••••1234");
    await expect(page.locator("body")).not.toContainText("99887766551234");
    await page.getByRole("button", { name: "Approve provider" }).click();
    const outcome = page.getByTestId("decision-outcome");
    await expect(outcome).toContainText("Approved: the provider is verified.");
    await expect(outcome).toContainText("Audit entry recorded");
    await expect(outcome).toContainText("provider.verification.approve");
    await expect(page.getByText("Verified", { exact: true }).first()).toBeVisible();

    // The approval in the audit log (via the confirmation's link), before → after.
    await outcome.getByRole("link", { name: "View in the audit log" }).click();
    const entry = page.locator(
      '[data-testid="audit-entry"][data-action="provider.verification.approve"]',
    );
    await expect(entry).toHaveCount(1);
    const status = entry.locator('tr[data-key="status"]');
    await expect(status).toContainText("PENDING_VERIFICATION");
    await expect(status).toContainText("VERIFIED");
    // The actor is shown by name (gap 25), not by user id.
    await expect(entry.getByTestId("audit-actor")).toHaveText(`${w.adminName} (admin)`);
    // Gap 5: the browser forged X-Forwarded-For; the row has the address the web server saw.
    const actorLine = entry.getByTestId("audit-actor").locator("xpath=..");
    await expect(actorLine).toHaveText(/ · (127\.0\.0\.1|::1)$/);
    await expect(entry).not.toContainText(FORGED_CLIENT_IP);

    // An incomplete provider: the block is shown before clicking, and Approve is disabled.
    await page.goto(`/admin/providers/${pair.incomplete.id}`);
    await expect(
      page.getByTestId("admin-requirements").locator('[data-requirement="registration"]'),
    ).toHaveAttribute("data-state", "missing");
    await expect(page.getByTestId("approval-blocked")).toContainText(
      "Approval is blocked: no document for Business registration",
    );
    await expect(page.getByRole("button", { name: "Approve provider" })).toBeDisabled();
    // Hiding the button is not the security: the API refuses the approval itself.
    const forced = await page.request.post(
      `/api/v1/admin/providers/${pair.incomplete.id}/verification/approve`,
      { data: {}, headers: { "X-CSRF-Token": await csrfOf(page) } },
    );
    expect(forced.status()).toBe(409);
    expect(((await forced.json()) as { error: { code: string } }).error.code).toBe(
      "REQUIRED_DOCUMENTS_MISSING",
    );
    await page.reload();
    await expect(page.getByText("Waiting for verification").first()).toBeVisible();

    // Reject it with a reason instead: confirmed, with its audit entry.
    await page
      .getByLabel(/Reason for rejecting/)
      .fill("The business registration certificate is missing.");
    await page.getByRole("button", { name: "Reject" }).click();
    await expect(page.getByTestId("decision-outcome")).toContainText("Rejected");
    await expect(page.getByTestId("decision-outcome")).toContainText(
      "provider.verification.reject",
    );
    await expect(
      page.getByText("The business registration certificate is missing.").first(),
    ).toBeVisible();

    // Listing rules (read-only): hotels may list properties and rooms; flights are not usable.
    await page.goto("/admin/listing-rules");
    const rules = page.getByTestId("listing-rules");
    await expect(rules.locator('[data-provider-type="hotel"] [data-testid="usable"]')).toHaveText(
      "hotel, hotel_room",
    );
    await expect(rules.locator('[data-provider-type="airline"] [data-testid="usable"]')).toHaveText(
      "None",
    );

    // Invoices: every amount on screen is the API's string; the status filter works.
    await page.goto("/admin/invoices");
    const firstRow = page.getByTestId("admin-invoice-row").first();
    await expect(firstRow).toBeVisible();
    const invoiceId = await firstRow.getAttribute("data-invoice");
    const shown = (await firstRow.getByTestId("admin-invoice-amount").textContent()) ?? "";
    const invoices = (await (
      await page.request.get("/api/v1/admin/invoices?pageSize=100")
    ).json()) as {
      data: { id: string; amountMinor: string }[];
    };
    expect(shown.replace(/\D/g, "")).toBe(
      invoices.data.find((i) => i.id === invoiceId)?.amountMinor,
    );
    await page.getByLabel("Status").selectOption("ISSUED");
    await page.getByRole("button", { name: "Filter" }).click();
    await expect(page).toHaveURL(/status=ISSUED/);
    await expect(page.getByTestId("admin-invoice-row").first()).toContainText("Issued");

    // Payouts: this project's night only → total − commission = Rs. 4,350.50 − Rs. 525.00.
    await page.goto(`/admin/payouts?providerId=${w.hotelProviderId}&from=${night}&to=${morning}`);
    const payout = page.getByTestId("admin-payout-row");
    await expect(payout).toHaveCount(1);
    await expect(payout).toContainText("Rs. 4,350.50");
    await expect(payout).toContainText("Rs. 525.00");
    await expect(payout.getByTestId("admin-payout-amount")).toHaveText("Rs. 3,825.50");
    await expect(payout).toContainText("Pending · not paid out");
  });

  test("a customer cannot reach the console: page not found, API 403; a visitor is sent to log in", async ({
    page,
  }) => {
    const w = world!;
    await page.goto("/admin/providers");
    await expect(page).toHaveURL(/\/login\?next=%2Fadmin%2Fproviders/);

    await login(page, w.customerEmail, w.customerPassword, "/admin");
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByTestId("admin-not-found")).toContainText("Page not found");
    await expect(page.getByRole("link", { name: "Admin", exact: true })).toHaveCount(0);
    await page.goto(`/admin/providers/${w.adminProviders.desktop.complete.id}`);
    await expect(page.getByTestId("admin-not-found")).toBeVisible();
    expect((await page.request.get("/api/v1/admin/providers")).status()).toBe(403);
    expect((await page.request.get("/api/v1/admin/audit-log")).status()).toBe(403);
  });
});
