import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CancellationTerms } from "@/components/ui/cancellation-terms";
import { ApiError, apiRequest } from "./api-client";
import {
  draftFromTiers,
  hoursText,
  NO_POLICY_BOOKING,
  NO_POLICY_LISTING,
  policySummary,
  refundText,
  sourceLabel,
  termLines,
  tiersFromDraft,
} from "./cancellation-policy";
import {
  adminDocumentFileHref,
  canDeleteDocument,
  checkDocumentFile,
  describeUploadError,
  documentFileHref,
} from "./document-upload";

const MODERATE = {
  name: "Moderate",
  rules: [
    { minHoursBeforeStart: 72, refundBps: 10_000 },
    { minHoursBeforeStart: 24, refundBps: 5_000 },
  ],
};

describe("gap 23: cancellation terms in plain words", () => {
  it("summarises and lists the tiers; hours read as days where whole", () => {
    expect(policySummary(MODERATE)).toBe(
      "Free cancellation until 72 hours (3 days) before the start.",
    );
    expect(termLines(MODERATE)).toEqual([
      "Cancel at least 72 hours (3 days) before the start: 100% refund.",
      "Cancel at least 24 hours (1 day) before the start: 50% refund.",
      "Later than that: no refund.",
    ]);
    expect(policySummary({ rules: [{ minHoursBeforeStart: 6, refundBps: 2_550 }] })).toBe(
      "Up to 25.5% refund if you cancel at least 6 hours before the start.",
    );
    expect(hoursText(1)).toBe("1 hour");
    expect(refundText(1)).toBe("0.01%");
  });

  it("non-refundable is said plainly; an unreadable rule never crashes", () => {
    expect(policySummary({ nonRefundable: true, rules: [] })).toBe("Non-refundable.");
    expect(termLines({ nonRefundable: true })).toEqual(["No refund if you cancel, at any time."]);
    expect(termLines({ rules: ["garbage", null] })).toEqual([]);
    expect(policySummary({ rules: [] })).toBe("See the cancellation terms.");
  });

  it("current (listing) vs frozen (booking) display, and the explicit no-policy state", () => {
    const current = renderToStaticMarkup(
      createElement(CancellationTerms, {
        terms: { ...MODERATE, source: "provider" },
        context: "listing",
      }),
    );
    expect(current).toContain("Cancellation: Moderate");
    expect(current).toContain("The provider&#x27;s standard policy");
    expect(current).not.toContain("fixed when this was booked");

    const frozen = renderToStaticMarkup(
      createElement(CancellationTerms, { terms: MODERATE, context: "booking" }),
    );
    expect(frozen).toContain("These terms were fixed when this was booked");
    expect(sourceLabel("listing")).toBe("This listing's policy");

    const none = renderToStaticMarkup(
      createElement(CancellationTerms, { terms: null, context: "listing" }),
    );
    expect(none).toContain('data-testid="no-cancellation-policy"');
    expect(none).toContain(NO_POLICY_LISTING.replace(/'/g, "&#x27;").slice(0, 40));
    const noneBooked = renderToStaticMarkup(
      createElement(CancellationTerms, { terms: null, context: "booking" }),
    );
    expect(noneBooked).toContain(NO_POLICY_BOOKING);
  });

  it("the partner's tier editor: rows ⇄ tiers, with the API's rules checked first", () => {
    expect(
      tiersFromDraft([
        { hours: "72", percent: "100" },
        { hours: "24", percent: "50.5" },
      ]),
    ).toEqual({
      ok: true,
      tiers: [
        { minHoursBeforeStart: 72, refundBps: 10_000 },
        { minHoursBeforeStart: 24, refundBps: 5_050 },
      ],
    });
    expect(draftFromTiers(MODERATE.rules)).toEqual([
      { hours: "72", percent: "100" },
      { hours: "24", percent: "50" },
    ]);
    const bad = (rows: { hours: string; percent: string }[]) => tiersFromDraft(rows).ok;
    expect(bad([])).toBe(false);
    expect(bad([{ hours: "2.5", percent: "10" }])).toBe(false);
    expect(bad([{ hours: "10", percent: "0" }])).toBe(false);
    expect(bad([{ hours: "10", percent: "101" }])).toBe(false);
    expect(
      bad([
        { hours: "24", percent: "50" },
        { hours: "48", percent: "40" },
      ]),
    ).toBe(false);
    expect(
      bad([
        { hours: "48", percent: "50" },
        { hours: "24", percent: "60" },
      ]),
    ).toBe(false);
  });
});

describe("gap 14: document upload in the browser", () => {
  it("checks type and size before sending (the API checks the bytes again)", () => {
    expect(checkDocumentFile(null)).toBe("Choose the document file.");
    expect(checkDocumentFile({ type: "application/pdf", size: 0 })).toBe(
      "Choose the document file.",
    );
    expect(checkDocumentFile({ type: "image/webp", size: 10 })).toBe(
      "The file must be a PDF, JPEG or PNG.",
    );
    expect(checkDocumentFile({ type: "image/png", size: 10 * 1024 * 1024 + 1 })).toBe(
      "The file must be 10 MB or smaller.",
    );
    expect(checkDocumentFile({ type: "image/jpeg", size: 2_000 })).toBeNull();
  });

  it("delete is offered only where the API allows it", () => {
    expect(canDeleteDocument("APPROVED", "VERIFIED")).toBe(false);
    expect(canDeleteDocument("PENDING", "PENDING_VERIFICATION")).toBe(false);
    expect(canDeleteDocument("PENDING", "DRAFT")).toBe(true);
    expect(canDeleteDocument("REJECTED", "REJECTED")).toBe(true);
    expect(canDeleteDocument("AWAITING_UPLOAD", "SUSPENDED")).toBe(false);
  });

  it("upload errors in words; files are fetched through the API, never by a storage key", () => {
    expect(describeUploadError(new ApiError(422, "DOCUMENT_CONTENT_INVALID", "x"))).toMatch(
      /isn't a readable PDF, JPEG or PNG/,
    );
    expect(describeUploadError(new ApiError(413, "PAYLOAD_TOO_LARGE", "x"))).toMatch(/10 MB/);
    expect(describeUploadError(new ApiError(500, "INTERNAL_ERROR", "x"))).toBeNull();
    expect(documentFileHref("d1")).toBe("/api/v1/partner/verification-documents/d1/file");
    expect(adminDocumentFileHref("p1", "d1")).toBe("/api/v1/admin/providers/p1/documents/d1/file");
  });

  it("the API client sends a file as-is with its type (PUT, not JSON) and the CSRF token", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ data: { status: "UPLOADED" } }), { status: 200 }),
      ),
    );
    const file = new Blob(["%PDF-1.4"], { type: "application/pdf" });
    await apiRequest("/partner/verification-documents/d1/file", {
      method: "PUT",
      rawBody: { data: file, contentType: "application/pdf" },
      csrfToken: "csrf-1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/v1/partner/verification-documents/d1/file");
    expect(init.method).toBe("PUT");
    expect(init.body).toBe(file);
    expect(init.headers).toMatchObject({
      "Content-Type": "application/pdf",
      "X-CSRF-Token": "csrf-1",
    });
  });
});
