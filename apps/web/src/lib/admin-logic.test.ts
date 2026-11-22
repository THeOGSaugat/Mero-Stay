import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { adminAccess, adminErrorView, describeAdminError, missingGroupsOf } from "./admin-access";
import { ApiError } from "./api-client";
import type { PublicUser } from "./api-types";
import type { AuthState } from "./auth-state";
import { auditActionLabel, auditQuery, auditRows } from "./audit-display";
import { formatMoney } from "./money";
import { payoutAccountSummary, safeMaskedAccountNumber } from "./partner-display";

const as = (role: PublicUser["role"]): AuthState => ({
  status: "authenticated",
  csrfToken: "csrf-1",
  user: {
    id: "u1",
    email: null,
    phone: null,
    fullName: "Anita",
    role,
    status: "ACTIVE",
    createdAt: "2026-11-22T00:00:00Z",
  },
});

describe("admin route guard (navigation only; the API's 403 is the real check)", () => {
  it("only admins see the console; everyone else logged in sees 'not found'", () => {
    expect(adminAccess({ status: "loading", user: null, csrfToken: null })).toBe("loading");
    expect(adminAccess({ status: "anonymous", user: null, csrfToken: null })).toBe("login");
    expect(adminAccess(as("CUSTOMER"))).toBe("not-found");
    expect(adminAccess(as("PARTNER"))).toBe("not-found");
    expect(adminAccess(as("ADMIN"))).toBe("admin");
  });

  it("an API 404 or 403 reads as 'not found'; other errors as messages", () => {
    expect(adminErrorView(new ApiError(404, "PROVIDER_NOT_FOUND", "x"))).toEqual({
      kind: "not-found",
    });
    expect(adminErrorView(new ApiError(403, "FORBIDDEN", "x"))).toEqual({ kind: "not-found" });
    expect(adminErrorView(new ApiError(409, "PROVIDER_NOT_PENDING", "x"))).toMatchObject({
      kind: "message",
    });
  });
});

describe("the incomplete-provider block", () => {
  const blocked = new ApiError(409, "REQUIRED_DOCUMENTS_MISSING", "x", {
    missing: [
      { requirement: "registration", acceptedDocumentTypes: ["BUSINESS_REGISTRATION"] },
      { requirement: "tax", acceptedDocumentTypes: ["PAN_CERTIFICATE"] },
    ],
  });

  it("names the missing groups and says nothing changed", () => {
    expect(missingGroupsOf(blocked)).toEqual(["registration", "tax"]);
    expect(describeAdminError(blocked)).toBe(
      "Approval is blocked: no document for Business registration, Tax registration. Nothing was changed.",
    );
    expect(missingGroupsOf(new ApiError(409, "OTHER", "x"))).toEqual([]);
  });

  it("a reject without a reason is explained", () => {
    const err = new ApiError(400, "VALIDATION_ERROR", "x", [
      { path: "reason", message: "is required" },
    ]);
    expect(describeAdminError(err)).toBe("Give a reason (at least 3 characters) to reject.");
  });
});

describe("money and masking reuse the shared helpers", () => {
  it("invoice and payout strings are formatted, never computed", () => {
    expect(formatMoney("115500", "NPR", 2)).toBe("Rs 1,155.00");
    expect(formatMoney("38255000", "NPR", 2)).toBe("Rs 3,82,550.00");
    expect(formatMoney("9007199254740993", "NPR", 2)).toBe("Rs 9,00,71,99,25,47,409.93");
  });

  it("bank numbers: the API's mask is shown, anything longer is masked again", () => {
    expect(safeMaskedAccountNumber("••••1234")).toBe("••••1234");
    expect(safeMaskedAccountNumber("99887766551234")).toBe("••••");
    expect(
      payoutAccountSummary({
        id: "a",
        bankName: "Global IME",
        branch: null,
        accountName: "X",
        accountNumberMasked: "99887766551234",
        verified: false,
        verifiedAt: null,
      }),
    ).toBe("Global IME · ••••");
  });
});

describe("audit before/after rendering", () => {
  it("one text row per field, nested paths flattened, changes flagged", () => {
    const rows = auditRows(
      { status: "PENDING_VERIFICATION", pendingDocumentIds: ["d1", "d2"] },
      { status: "VERIFIED", documentStatus: "APPROVED", reason: null },
    );
    expect(rows).toEqual([
      { key: "documentStatus", before: "—", after: "APPROVED", changed: true },
      { key: "pendingDocumentIds", before: '["d1","d2"]', after: "—", changed: true },
      { key: "reason", before: "—", after: "null", changed: true },
      { key: "status", before: "PENDING_VERIFICATION", after: "VERIFIED", changed: true },
    ]);
    expect(auditRows({ a: { b: 1 } }, { a: { b: 1 } })).toEqual([
      { key: "a.b", before: "1", after: "1", changed: false },
    ]);
    expect(auditRows(null, null)).toEqual([]);
  });

  it("markup in values stays literal text (React renders strings as text, never HTML)", () => {
    const evil = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const [row] = auditRows({ reason: "ok" }, { reason: evil });
    expect(row?.after).toBe(evil); // unchanged string → a text node, not parsed
    expect(typeof row?.after).toBe("string");
  });

  it("backstop: secret-looking keys are hidden and account numbers re-masked, at any depth", () => {
    const rows = auditRows(
      {},
      {
        password: "hunter2-long-password",
        payoutAccount: {
          accountNumber: "0123456789012",
          accountNumberMasked: "••••9012",
          tokenHash: "abc",
        },
        session_token: "t",
        CsrfToken: "c",
      },
    );
    const after = Object.fromEntries(rows.map((r) => [r.key, r.after]));
    expect(after).toEqual({
      CsrfToken: "[hidden]",
      password: "[hidden]",
      "payoutAccount.accountNumber": "••••",
      "payoutAccount.accountNumberMasked": "••••9012",
      "payoutAccount.tokenHash": "[hidden]",
      session_token: "[hidden]",
    });
    expect(JSON.stringify(rows)).not.toMatch(/hunter2|0123456789012|abc/);
  });

  it("filters become the API query; unknown actions show their code", () => {
    expect(
      auditQuery({ action: "provider.verification.approve", entityId: " p1 ", actorUserId: "" }, 2),
    ).toBe("page=2&pageSize=20&action=provider.verification.approve&entityId=p1");
    expect(auditActionLabel("provider.verification.approve")).toBe("Verification approved");
    expect(auditActionLabel("listing.something")).toBe("listing.something");
  });
});

describe("no raw HTML anywhere in the web app", () => {
  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sources(path);
      return /\.(tsx?|jsx?)$/.test(entry.name) && !entry.name.endsWith(".test.ts") ? [path] : [];
    });
  }

  it("no component uses dangerouslySetInnerHTML (audit values and API text are always text)", () => {
    const files = sources(join(__dirname, ".."));
    expect(files.length).toBeGreaterThan(40);
    const offenders = files.filter((file) =>
      readFileSync(file, "utf8").includes("dangerouslySetInnerHTML"),
    );
    expect(offenders).toEqual([]);
  });
});
