import { ApiError } from "./api-client";
import type { AuthState } from "./auth-state";
import { describePartnerError } from "./partner-access";
import { requirementLabel } from "./partner-display";

/**
 * Who may see the admin console (Phase 7 Track C, ADR 0012).
 *
 * Navigation only: the API answers 403 to every non-admin for every /admin URL before reading
 * any data. The UI goes one step further in what it reveals: a logged-in non-admin sees the same
 * "not found" page as for any unknown URL, so the console is not advertised.
 */
export type AdminAccess = "loading" | "login" | "not-found" | "admin";

export function adminAccess(state: AuthState): AdminAccess {
  if (state.status === "loading") return "loading";
  if (state.status === "anonymous") return "login";
  return state.user.role === "ADMIN" ? "admin" : "not-found";
}

export type AdminErrorView = { kind: "not-found" } | { kind: "message"; message: string };

/** A 404, and a 403 (the session lost its admin role), both read as "not found". */
export function adminErrorView(error: unknown): AdminErrorView {
  if (error instanceof ApiError && (error.status === 404 || error.code === "FORBIDDEN")) {
    return { kind: "not-found" };
  }
  return { kind: "message", message: describeAdminError(error) };
}

/** The missing required-document groups named by a 409 REQUIRED_DOCUMENTS_MISSING. */
export function missingGroupsOf(error: unknown): string[] {
  if (!(error instanceof ApiError) || error.code !== "REQUIRED_DOCUMENTS_MISSING") return [];
  const missing = (error.details as { missing?: { requirement?: unknown }[] } | undefined)?.missing;
  return Array.isArray(missing)
    ? missing.map((m) => m.requirement).filter((r): r is string => typeof r === "string")
    : [];
}

export function describeAdminError(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "REQUIRED_DOCUMENTS_MISSING": {
        const groups = missingGroupsOf(error).map(requirementLabel);
        return groups.length > 0
          ? `Approval is blocked: no document for ${groups.join(", ")}. Nothing was changed.`
          : "Approval is blocked: required documents are missing. Nothing was changed.";
      }
      case "PROVIDER_NOT_PENDING":
        return "This provider is not waiting for a decision (it was already decided). Reload to see its status.";
      // Phase 12 (ADR 0018)
      case "PAYOUT_ACCOUNT_NOT_VERIFIED":
        return "The provider's bank account is not verified. Verify it on the provider's page first.";
      case "PAYOUT_EMPTY":
        return "This payout has no bookings left to pay (they were cancelled or are being refunded).";
      case "PAYOUT_ALREADY_PAID":
        return "This payout was already recorded as paid with another reference. Nothing was changed.";
      case "PAYOUT_NOT_SCHEDULED":
      case "PAYOUT_NOT_SCHEDULABLE":
        return "This payout cannot do that in its current state. Reload to see where it is.";
      case "LISTING_TYPE_NOT_ALLOWED":
      case "LISTING_TYPE_NOT_OFFERED":
        return "Approval is blocked: this listing's type is not allowed for this kind of business. Nothing was changed.";
      case "LISTING_NOT_IN_REVIEW":
        return "This listing is not waiting for review (it was already decided). Reload to see its status.";
      case "LAST_ADMIN":
        return "At least one active admin must remain, so this admin cannot be suspended.";
      case "ADMIN_SELF_LOCKOUT":
        return "You cannot suspend your own account.";
      case "EMAIL_TAKEN":
        return "An account with this email already exists.";
      case "RECONCILIATION_ALREADY_RESOLVED":
        return "This late payment was already marked as handled.";
      case "VALIDATION_ERROR":
        if (JSON.stringify(error.details ?? "").includes("reason")) {
          return "Give a reason (at least 3 characters) to reject.";
        }
        break;
    }
  }
  return describePartnerError(error);
}
