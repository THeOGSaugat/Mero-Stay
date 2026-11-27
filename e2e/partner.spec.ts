import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * Partner dashboard journey (Phase 7 Track B), against the seeded DISPOSABLE database
 * (E2E_DATABASE_URL, see playwright.config.ts). Skipped when no such database is configured.
 *
 * A customer first books the partner's room through the real API (one night paid at the
 * property, one night paid online with the simulated gateway). Then the partner logs in and:
 * sees only their own listings → adds dates → is refused an overbooking change → sees the
 * bookings with the API's money → settles the pay-at-property booking once (a lost response and
 * a second attempt are both safe) → sees the invoice and payout → gets "not found" for another
 * partner's listing and booking. Bank details appear masked only.
 */

interface World {
  roomId: string; // another partner's room (the fixture's owner)
  days: string[];
  partnerEmail: string;
  partnerPassword: string;
  partnerName: string;
  businessName: string;
  partnerRoomId: string;
  partnerRoomTitle: string;
  partnerHotelTitle: string;
}

const world: World | null = process.env.E2E_WORLD
  ? (JSON.parse(process.env.E2E_WORLD) as World)
  : null;

interface TripBody {
  data: { id: string; reference: string; items: { id: string; paymentMethod: string }[] };
}

async function post<T>(api: APIRequestContext, path: string, csrf: string, data: unknown = {}) {
  const res = await api.post(`/api/v1${path}`, { data, headers: { "X-CSRF-Token": csrf } });
  if (!res.ok()) throw new Error(`${path} → ${res.status()} ${await res.text()}`);
  return (await res.json()) as T;
}

/** The in-memory CSRF token, read the way the app does (GET /auth/me with the cookie). */
async function csrfOf(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const res = await fetch("/api/v1/auth/me", { credentials: "include" });
    return ((await res.json()) as { data: { csrfToken: string } }).data.csrfToken;
  });
}

/** Wide tables scroll inside their own box; the page itself never scrolls sideways. */
async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

/** A customer books through the API: returns this project's trip and items. */
async function bookAsCustomer(api: APIRequestContext, w: World, label: string) {
  const [day0, day1, day2, day3] = w.days as [string, string, string, string];
  const reg = await api.post("/api/v1/auth/register", {
    data: {
      fullName: `Guest ${label}`,
      email: `guest-${label}-${Date.now()}@example.com`,
      password: "a long e2e passphrase",
    },
  });
  expect(reg.status()).toBe(201);
  const csrf = ((await reg.json()) as { data: { csrfToken: string } }).data.csrfToken;

  const trip = await post<TripBody>(api, "/trips", csrf, { currency: "NPR" });
  const item = (listingId: string, startDate: string, endDate: string, paymentMethod: string) =>
    post<TripBody>(api, `/trips/${trip.data.id}/items`, csrf, {
      listingId,
      startDate,
      endDate,
      quantity: 1,
      paymentMethod,
    });
  await item(w.partnerRoomId, day0, day1, "pay_at_property");
  const full = await item(w.partnerRoomId, day2, day3, "online");
  await post(api, `/trips/${trip.data.id}/confirm`, csrf);
  const intent = await post<{ data: { payment: { id: string } } }>(
    api,
    `/trips/${trip.data.id}/payments/intent`,
    csrf,
    { gateway: "simulated" },
  );
  await post(api, `/trips/${trip.data.id}/payments/${intent.data.payment.id}/confirm`, csrf);

  // A booking of ANOTHER partner (the fixture's room), for the scoping check.
  const other = await post<TripBody>(api, "/trips", csrf, { currency: "NPR" });
  const otherFull = await post<TripBody>(api, `/trips/${other.data.id}/items`, csrf, {
    listingId: w.roomId,
    startDate: day0,
    endDate: day1,
    quantity: 1,
    paymentMethod: "pay_at_property",
  });
  await post(api, `/trips/${other.data.id}/confirm`, csrf);

  return {
    reference: trip.data.reference,
    payAtPropertyItemId: full.data.items.find((i) => i.paymentMethod === "pay_at_property")!.id,
    onlineItemId: full.data.items.find((i) => i.paymentMethod === "online")!.id,
    otherPartnersItemId: otherFull.data.items[0]!.id,
  };
}

test.describe("partner dashboard journey", () => {
  test.skip(!world, "Set E2E_DATABASE_URL to a disposable database to run the partner journey.");

  test("own listings, dates, bookings, settle once, invoice, payout; other partners' data is not found", async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(120_000);
    const w = world!;
    const label = testInfo.project.name.startsWith("mobile") ? "mobile" : "desktop";
    const booked = await bookAsCustomer(request, w, label);
    // Each project adds its own dates so the two projects never collide.
    const [from, to] = (label === "desktop" ? w.days.slice(4, 6) : w.days.slice(7, 9)) as [
      string,
      string,
    ];

    // Log in as the partner; the header now offers the partner area.
    await page.goto("/login?next=/partner");
    await page.getByLabel("Email").fill(w.partnerEmail);
    await page.getByLabel("Password").fill(w.partnerPassword);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).toHaveURL(/\/partner$/);
    await expect(page.getByRole("heading", { name: w.businessName })).toBeVisible();
    await expect(page.getByRole("link", { name: "Partner", exact: true })).toBeVisible();

    // Only this partner's listings: their hotel and room, none of the fixture owner's.
    await page
      .getByRole("navigation", { name: "Partner" })
      .getByRole("link", { name: "Listings" })
      .click();
    const rows = page.getByTestId("partner-listing-row");
    await expect(rows).toHaveCount(2);
    await expect(page.getByTestId("partner-listings")).toContainText(w.partnerRoomTitle);
    await expect(page.getByTestId("partner-listings")).toContainText(w.partnerHotelTitle);
    await expect(page.getByTestId("partner-listings")).not.toContainText("Test Double Room");

    // Gap 22: a hotel business may only create its property and rooms; the API refuses others.
    await page.goto("/partner/listings/new");
    const kind = page.getByLabel("Kind of listing");
    await expect(kind.locator("option")).toHaveText(["Choose…", /Hotel \/ property/, "Hotel room"]);
    const refused = await page.request.post("/api/v1/partner/listings", {
      data: { listingTypeCode: "bus_ticket", title: "Not ours", basePriceMinor: "100000" },
      headers: { "X-CSRF-Token": await csrfOf(page) },
    });
    expect(refused.status()).toBe(422);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
      "LISTING_TYPE_NOT_ALLOWED",
    );
    await page.goBack();

    // Add dates with a date price, then try to lower booked dates to zero (overbooking: refused).
    await page.getByRole("link", { name: w.partnerRoomTitle }).click();
    await expect(page.getByRole("heading", { name: w.partnerRoomTitle })).toBeVisible();
    const add = page
      .locator("form")
      .filter({ has: page.getByRole("heading", { name: "Add dates" }) });
    await add.getByLabel("From").fill(from);
    await add.getByLabel("Up to (not including)").fill(to);
    await add.getByLabel("Units per date").fill("3");
    await add.getByLabel(/Date price/).fill("2800");
    await add.getByRole("button", { name: "Add dates" }).click();
    await expect(page.getByTestId("inventory-result")).toContainText("Added 1 date");
    const table = page.getByTestId("inventory-table");
    await expect(table.locator(`tr[data-date="${from}"]`)).toContainText("Rs. 2,800.00");
    await expect(table.locator(`tr[data-date="${from}"]`)).toContainText("date price");
    await expectNoHorizontalScroll(page);

    const update = page
      .locator("form")
      .filter({ has: page.getByRole("heading", { name: "Update dates" }) });
    await update.getByLabel("From").fill(w.days[0]!);
    await update.getByLabel("Up to (not including)").fill(w.days[1]!);
    await update.getByLabel(/Units per date/).fill("0");
    await update.getByRole("button", { name: "Update dates" }).click();
    await expect(page.getByTestId("inventory-error")).toContainText(
      "Capacity can't go below what is already booked",
    );
    await expect(page.getByTestId("inventory-error")).toContainText("Nothing was changed.");

    // Bookings: this customer's two nights are listed with the API's amounts.
    await page.goto("/partner/bookings");
    const mine = page.getByTestId("partner-booking").filter({ hasText: booked.reference });
    await expect(mine).toHaveCount(2);
    await expect(mine.first()).toContainText(`Guest ${label}`);

    // The pay-at-property night: frozen money, masked contact, then settle with a lost response.
    await page.goto(`/partner/bookings/${booked.payAtPropertyItemId}`);
    const money = page.getByTestId("booking-money");
    await expect(money).toContainText("Rs. 2,500.00"); // subtotal and total
    await expect(money).toContainText("Rs. 375.00"); // 15% commission
    await expect(money).toContainText("Rs. 2,125.00"); // the partner's share
    await expect(page.getByText(/^g•••@e•••\.com$/)).toBeVisible();
    await expectNoHorizontalScroll(page);

    const settleUrl = `**/api/v1/partner/bookings/${booked.payAtPropertyItemId}/settle-at-property`;
    const sentKeys: string[] = [];
    await page.route(settleUrl, async (route) => {
      sentKeys.push(route.request().headers()["idempotency-key"] ?? "");
      await route.fetch(); // the API records the payment…
      await route.abort("connectionreset"); // …but the browser never hears back
    });
    await page.getByRole("button", { name: "Record payment received at the property" }).click();
    await expect(page.getByTestId("settle-action").getByRole("alert")).toContainText(
      "Trying again is safe",
    );
    await page.unroute(settleUrl);
    page.on("request", (req) => {
      if (req.url().includes("/settle-at-property")) {
        sentKeys.push(req.headers()["idempotency-key"] ?? "");
      }
    });
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByTestId("settle-outcome")).toContainText("recorded once");
    expect(sentKeys).toHaveLength(2);
    expect(sentKeys[1]).toBe(sentKeys[0]); // the same Idempotency-Key both times
    await expect(page.getByTestId("settled-record")).toContainText(`by ${w.partnerName}`);
    const recorded = await page.getByTestId("settled-record").textContent();

    // A second attempt (new key, e.g. another tab) changes nothing; after a reload the action
    // is gone and the record is the same.
    const csrf = await page.evaluate(async () => {
      const res = await fetch("/api/v1/auth/me", { credentials: "include" });
      return ((await res.json()) as { data: { csrfToken: string } }).data.csrfToken;
    });
    const again = await page.request.post(
      `/api/v1/partner/bookings/${booked.payAtPropertyItemId}/settle-at-property`,
      {
        data: {},
        headers: { "X-CSRF-Token": csrf, "Idempotency-Key": `e2e-second-${Date.now()}` },
      },
    );
    expect(again.status()).toBe(200);
    await page.reload();
    await expect(page.getByTestId("settled-record")).toHaveText(recorded ?? "");
    await expect(page.getByTestId("settle-action")).toHaveCount(0);
    const invoiceNumber = (await page.getByRole("link", { name: /^INV-/ }).textContent())?.split(
      " ",
    )[0];
    expect(invoiceNumber).toMatch(/^INV-/);

    // The online night: the API's payout figure, shown as it is.
    await page.goto(`/partner/bookings/${booked.onlineItemId}`);
    await expect(page.getByTestId("booking-money")).toContainText("Rs. 2,125.00");
    await expect(page.getByTestId("settle-action")).toHaveCount(0);

    // Invoices: the commission invoice of the pay-at-property night.
    await page.goto("/partner/invoices");
    const invoice = page.getByTestId("partner-invoice").filter({ hasText: invoiceNumber! });
    await expect(invoice.getByTestId("invoice-amount")).toHaveText("Rs. 375.00");

    // Payouts: pending, and exactly the API's string (total − commission per ADR 0008).
    await page.goto("/partner/payouts");
    const payouts = (await (await page.request.get("/api/v1/partner/payouts")).json()) as {
      data: { providerPayoutMinor: string }[];
    };
    const row = page.getByTestId("payout-row").first();
    await expect(row).toContainText("Pending");
    const shown = (await row.locator("td").nth(4).textContent()) ?? "";
    expect(shown.replace(/\D/g, "")).toBe(payouts.data[0]!.providerPayoutMinor);

    // Bank account: masked only.
    await page.goto("/partner/profile");
    await expect(page.getByTestId("account-number-masked")).toHaveText("••••4321");
    await expect(page.locator("body")).not.toContainText("00112233444321");

    // Verification: the hotel type's required groups, both satisfied by approved documents.
    await page.goto("/partner/verification");
    const checklist = page.getByTestId("requirement-checklist");
    await expect(checklist.locator('[data-requirement="identity"]')).toHaveAttribute(
      "data-state",
      "approved",
    );
    await expect(checklist.locator('[data-requirement="registration"]')).toHaveAttribute(
      "data-state",
      "approved",
    );

    // Another partner's listing and booking: "not found", exactly like a missing one.
    await page.goto(`/partner/listings/${w.roomId}`);
    await expect(page.getByTestId("partner-not-found")).toBeVisible();
    await page.goto(`/partner/bookings/${booked.otherPartnersItemId}`);
    await expect(page.getByTestId("partner-not-found")).toBeVisible();
    expect(
      (await page.request.get(`/api/v1/partner/bookings/${booked.otherPartnersItemId}`)).status(),
    ).toBe(404);
  });

  test("the partner area sends a visitor to log in; the API refuses anonymous partner calls", async ({
    page,
    request,
  }) => {
    await page.goto("/partner/bookings");
    await expect(page).toHaveURL(/\/login\?next=%2Fpartner%2Fbookings/);
    expect((await request.get("/api/v1/partner/profile")).status()).toBe(401);
  });
});
