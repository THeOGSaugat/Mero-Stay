import { expect, test, type Page } from "@playwright/test";

/**
 * Phase 10 journeys (disposable database only; seeded per project by e2e-world.ts):
 * - gap 23: a partner writes a cancellation policy and attaches it to a room; a customer sees it
 *   on the listing, books, and the booking keeps those terms even after the partner edits them.
 * - gap 14: a partner uploads a verification document (status: under review), submits; an admin
 *   opens the private file and approves; the partner sees it approved.
 */

interface ProjectWorld {
  policyPartnerEmail: string;
  policyRoomId: string;
  policyRoomTitle: string;
  docsPartnerEmail: string;
  docsProviderId: string;
  docsProviderName: string;
}

interface World {
  phase10Password: string;
  phase10: { desktop: ProjectWorld; mobile: ProjectWorld };
  customerEmail: string;
  customerPassword: string;
  adminEmail: string;
  adminPassword: string;
  days: string[];
}

const world: World | null = process.env.E2E_WORLD
  ? (JSON.parse(process.env.E2E_WORLD) as World)
  : null;

/** Logging in again replaces the browser's session, so one page can play several people. */
async function login(page: Page, email: string, password: string, next: string): Promise<void> {
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(new RegExp(next.replace(/[/?]/g, "\\$&")));
}

async function csrfOf(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const res = await fetch("/api/v1/auth/me", { credentials: "include" });
    return ((await res.json()) as { data: { csrfToken: string } }).data.csrfToken;
  });
}

const projectOf = (name: string): "desktop" | "mobile" =>
  name.startsWith("mobile") ? "mobile" : "desktop";

test.describe("Phase 10: cancellation policies and verification documents", () => {
  test.skip(!world, "Set E2E_DATABASE_URL to a disposable database to run these journeys.");

  test("a partner's policy is shown on the listing and frozen into the booking", async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(120_000);
    const w = world!;
    const label = projectOf(testInfo.project.name);
    const p = w.phase10[label];
    const policyName = `Lakeside Moderate ${label}`;

    // Partner: no policy yet → write one (72 h: 100%, 24 h: 50%).
    await login(page, p.policyPartnerEmail, w.phase10Password, "/partner/cancellation-policies");
    await expect(page.getByTestId("no-default-policy")).toBeVisible();
    await page.getByRole("button", { name: "Add a policy" }).click();
    const form = page.getByTestId("policy-form");
    await form.getByLabel("Name", { exact: true }).fill(policyName);
    await form.getByLabel("Tier 1 hours before the start").fill("72");
    await form.getByLabel("Tier 1 refund percent").fill("100");
    await form.getByRole("button", { name: "Add a tier" }).click();
    await form.getByLabel("Tier 2 hours before the start").fill("24");
    await form.getByLabel("Tier 2 refund percent").fill("50");
    await form.getByRole("button", { name: "Add policy" }).click();
    await expect(page.getByText("Policy added.")).toBeVisible();
    const row = page.getByTestId("policy-row").filter({ hasText: policyName });
    await expect(row).toContainText("Free cancellation until 72 hours (3 days) before the start.");

    // Attach it to the room (the listing warned that none applied).
    await page.goto(`/partner/listings/${p.policyRoomId}`);
    await expect(page.getByTestId("no-policy-warning")).toBeVisible();
    await page.getByTestId("listing-policy-select").selectOption({ label: policyName });
    await expect(page.getByTestId("no-policy-warning")).toHaveCount(0);
    const policyId = await page.getByTestId("listing-policy-select").inputValue();

    // Customer: the listing shows the policy that applies now.
    await login(page, w.customerEmail, w.customerPassword, `/listings/${p.policyRoomId}`);
    // Visible only: while the server-rendered page streams in, React briefly keeps a hidden copy.
    const terms = page.getByTestId("cancellation-terms").filter({ visible: true });
    await expect(terms).toContainText(`Cancellation: ${policyName}`);
    await expect(terms).toContainText("This listing's policy");
    await expect(terms).toContainText(
      "Cancel at least 24 hours (1 day) before the start: 50% refund.",
    );

    // Book one night (through the API with the browser's session), then open the trip.
    const csrf = await csrfOf(page);
    const headers = { "X-CSRF-Token": csrf };
    const trip = await page.request.post("/api/v1/trips", { data: { currency: "NPR" }, headers });
    const tripId = ((await trip.json()) as { data: { id: string } }).data.id;
    const night = label === "desktop" ? 0 : 1;
    const added = await page.request.post(`/api/v1/trips/${tripId}/items`, {
      headers,
      data: {
        listingId: p.policyRoomId,
        startDate: w.days[night],
        endDate: w.days[night + 1],
        quantity: 1,
        paymentMethod: "pay_at_property",
      },
    });
    expect(added.status()).toBe(201);

    // The partner makes the policy stricter (through the API, as the partner).
    const partnerLogin = await request.post("/api/v1/auth/login", {
      data: { email: p.policyPartnerEmail, password: w.phase10Password },
    });
    const partnerCsrf = ((await partnerLogin.json()) as { data: { csrfToken: string } }).data
      .csrfToken;
    const edited = await request.patch(`/api/v1/partner/cancellation-policies/${policyId}`, {
      headers: { "X-CSRF-Token": partnerCsrf },
      data: { rules: [{ minHoursBeforeStart: 168, refundBps: 2_500 }] },
    });
    expect(edited.status()).toBe(200);

    // The booking keeps the terms it was booked with; the listing shows the new ones.
    await page.goto(`/trips/${tripId}`);
    const item = page.getByTestId("item-cancellation");
    await expect(item).toContainText("Free cancellation until 72 hours (3 days) before the start.");
    await item.locator("summary").click();
    await expect(item).toContainText("These terms were fixed when this was booked");
    await expect(item).not.toContainText("168 hours");
    await page.goto(`/listings/${p.policyRoomId}`);
    await expect(page.getByTestId("cancellation-summary").filter({ visible: true })).toHaveText(
      "Up to 25% refund if you cancel at least 168 hours (7 days) before the start.",
    );
  });

  test("a file near the 10 MB limit goes through the web server's proxy; a larger one is refused", async ({
    request,
  }, testInfo) => {
    const w = world!;
    const p = w.phase10[projectOf(testInfo.project.name)];
    // `request` uses the web origin, so this exercises Next.js's /api/v1 rewrite with a big body.
    const login = await request.post("/api/v1/auth/login", {
      data: { email: p.policyPartnerEmail, password: w.phase10Password },
    });
    const csrf = ((await login.json()) as { data: { csrfToken: string } }).data.csrfToken;
    const headers = { "X-CSRF-Token": csrf };
    const bytes = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(9_900_000, 0x20)]);
    const requested = await request.post("/api/v1/partner/verification-documents", {
      headers,
      data: {
        documentType: "OTHER",
        fileName: "large-scan.pdf",
        mimeType: "application/pdf",
        sizeBytes: bytes.length,
      },
    });
    expect(requested.status()).toBe(201);
    const id = ((await requested.json()) as { data: { id: string } }).data.id;
    const uploaded = await request.put(`/api/v1/partner/verification-documents/${id}/file`, {
      headers: { ...headers, "Content-Type": "application/pdf" },
      data: bytes,
    });
    expect(uploaded.status()).toBe(200);
    const tooLarge = await request.put(`/api/v1/partner/verification-documents/${id}/file`, {
      headers: { ...headers, "Content-Type": "application/pdf" },
      data: Buffer.alloc(10 * 1024 * 1024 + 1, 0x20),
    });
    expect(tooLarge.status()).toBe(413); // the API's limit, reached through the proxy
    // Far beyond the limit: the web server refuses it before buffering (no hang, ADR 0016).
    const huge = await request.put(`/api/v1/partner/verification-documents/${id}/file`, {
      headers: { ...headers, "Content-Type": "application/pdf" },
      data: Buffer.alloc(20 * 1024 * 1024, 0x20),
    });
    expect(huge.status()).toBe(413);
    const removed = await request.delete(`/api/v1/partner/verification-documents/${id}`, {
      headers,
    });
    expect(removed.status()).toBe(204);
  });

  test("a partner uploads a document, an admin opens it and approves", async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    const w = world!;
    const p = w.phase10[projectOf(testInfo.project.name)];

    // Partner: the registration is missing; upload it.
    await login(page, p.docsPartnerEmail, w.phase10Password, "/partner/verification");
    const checklist = page.getByTestId("requirement-checklist");
    await expect(checklist.locator('[data-requirement="registration"]')).toHaveAttribute(
      "data-state",
      "missing",
    );
    // The label wraps the select (its text includes every option), so select by name.
    await page.locator("select[name=documentType]").selectOption("LOCAL_GOVERNMENT_REGISTRATION");
    await page.getByLabel(/^File/).setInputFiles({
      name: "homestay-registration.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4\n1 0 obj << /Title (Registration) >> endobj\n%%EOF\n"),
    });
    await page.getByRole("button", { name: "Upload document" }).click();
    await expect(page.getByText("Document uploaded and sent for review.")).toBeVisible();
    const row = page.getByTestId("document-row").filter({ hasText: "homestay-registration.pdf" });
    await expect(row).toHaveAttribute("data-status", "PENDING");
    await expect(row).toContainText("Under review");
    await expect(checklist.locator('[data-requirement="registration"]')).toHaveAttribute(
      "data-state",
      "pending",
    );

    // The owner can open its own private file.
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      row.getByRole("button", { name: "Open" }).click(),
    ]);
    expect(download.suggestedFilename()).toBe("homestay-registration.pdf");

    await page.getByRole("button", { name: "Submit for verification" }).click();
    await expect(page.getByText("Submitted. MeroStay will review your documents.")).toBeVisible();

    // Admin: opens the uploaded file (private: the API serves it to admins) and approves.
    await login(page, w.adminEmail, w.adminPassword, `/admin/providers/${p.docsProviderId}`);
    await expect(page.getByRole("heading", { name: p.docsProviderName })).toBeVisible();
    const uploaded = page.locator("tr").filter({ hasText: "homestay-registration.pdf" });
    const href = await uploaded.getByTestId("admin-document-file").getAttribute("href");
    const file = await page.request.get(href!);
    expect(file.status()).toBe(200);
    expect(file.headers()["content-type"]).toBe("application/pdf");
    expect((await file.body()).subarray(0, 5).toString()).toBe("%PDF-");
    await page.getByRole("button", { name: "Approve provider" }).click();
    await expect(page.getByTestId("decision-outcome")).toContainText(
      "Approved: the provider is verified.",
    );

    // Partner: the document is approved (and the file can no longer be deleted).
    await login(page, p.docsPartnerEmail, w.phase10Password, "/partner/verification");
    await expect(row).toHaveAttribute("data-status", "APPROVED");
    await expect(row.getByRole("button", { name: "Delete" })).toHaveCount(0);
  });
});
