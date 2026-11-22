import { ApiError, describeApiError } from "./api-client";
import type { AuthState } from "./auth-state";
import { requirementLabel } from "./partner-display";

/**
 * Who may see the partner area, and how partner API errors are shown (Phase 7 Track B).
 *
 * This is navigation, NOT security. The API decides: a non-partner gets 403 for every /partner
 * URL before any data is read, and another provider's listing, booking or invoice is a 404,
 * exactly like one that does not exist (ADR 0008). The UI shows those answers as they are.
 */

export type PartnerAccess =
  /** Still reading GET /auth/me. */
  | "loading"
  /** Not logged in: go to /login and come back. */
  | "login"
  /** A customer: may become a partner (onboarding). */
  | "become-partner"
  /** An admin account: the API refuses /partner for admins (403). */
  | "not-for-admins"
  | "partner";

export function partnerAccess(state: AuthState): PartnerAccess {
  if (state.status === "loading") return "loading";
  if (state.status === "anonymous") return "login";
  switch (state.user.role) {
    case "PARTNER":
      return "partner";
    case "CUSTOMER":
      return "become-partner";
    default:
      return "not-for-admins";
  }
}

/** Request headers that pick the provider when a partner manages several (X-Provider-Id). */
export function providerHeaders(providerId: string | null): Record<string, string> {
  return providerId ? { "X-Provider-Id": providerId } : {};
}

/** What a partner page shows for a failed request. */
export type PartnerErrorView =
  | { kind: "not-found" }
  | { kind: "choose-provider"; providerIds: string[] }
  | { kind: "onboard" }
  | { kind: "forbidden" }
  | { kind: "message"; message: string };

export function partnerErrorView(error: unknown): PartnerErrorView {
  if (error instanceof ApiError) {
    // Not yours and not existing look the same on purpose: never "access denied".
    if (error.status === 404) return { kind: "not-found" };
    if (error.code === "PROVIDER_ID_REQUIRED") {
      const ids = (error.details as { providerIds?: unknown } | undefined)?.providerIds;
      return {
        kind: "choose-provider",
        providerIds: Array.isArray(ids)
          ? ids.filter((id): id is string => typeof id === "string")
          : [],
      };
    }
    if (error.code === "PARTNER_NOT_ONBOARDED") return { kind: "onboard" };
    if (error.code === "FORBIDDEN") return { kind: "forbidden" };
  }
  return { kind: "message", message: describePartnerError(error) };
}

function listOf(values: string[]): string {
  if (values.length <= 1) return values.join("");
  return `${values.slice(0, -1).join(", ")} and ${values[values.length - 1]}`;
}

function datesOf(details: unknown): string[] {
  const dates = (details as { dates?: unknown } | undefined)?.dates;
  if (!Array.isArray(dates)) return [];
  return dates
    .map((d) => (typeof d === "string" ? d : (d as { date?: unknown })?.date))
    .filter((d): d is string => typeof d === "string");
}

/** A readable message for the partner-area error codes; anything else falls back to Track A's. */
export function describePartnerError(error: unknown): string {
  if (!(error instanceof ApiError)) return describeApiError(error);
  switch (error.code) {
    case "REQUIRED_DOCUMENTS_MISSING": {
      const missing = (error.details as { missing?: { requirement?: unknown }[] } | undefined)
        ?.missing;
      const names = Array.isArray(missing)
        ? missing
            .map((m) => m.requirement)
            .filter((r): r is string => typeof r === "string")
            .map(requirementLabel)
        : [];
      return names.length > 0
        ? `Add a document for: ${listOf(names)}. Then submit again.`
        : "Some required documents are missing.";
    }
    case "NO_PENDING_DOCUMENTS":
      return "Add your verification documents first.";
    case "PROVIDER_NOT_SUBMITTABLE":
      return "Your business is already submitted or verified.";
    case "PROVIDER_IDENTITY_LOCKED":
      return "Legal and tax details can't change after you submit for verification.";
    case "PROVIDER_SUSPENDED":
      return "Your business is suspended by MeroStay; changes are disabled.";
    case "PROVIDER_TYPE_NOT_OFFERED":
      return "That kind of business is not offered yet.";
    case "LISTING_TYPE_NOT_OFFERED":
      return "That kind of listing is not offered yet.";
    case "LISTING_STATUS_NOT_ALLOWED":
      return "That status change isn't allowed for this listing.";
    case "LISTING_SUSPENDED":
      return "This listing is suspended by MeroStay and can't be changed.";
    case "LISTING_NOT_BOOKABLE":
      return "This listing groups other listings (for example, a hotel's rooms) and has no dates of its own.";
    case "DETAILS_REQUIRED":
      return "Fill in the details for this kind of listing.";
    case "UNKNOWN_LOCATION":
      return "Choose a place from the list.";
    case "UNKNOWN_PARENT_LISTING":
      return "Choose one of your own properties.";
    case "SLOT_EXISTS": {
      const dates = datesOf(error.details);
      return `Some dates already have availability${dates.length ? ` (${listOf(dates)})` : ""}. Use "Update dates" to change them.`;
    }
    case "CAPACITY_BELOW_BOOKED": {
      const rows = (error.details as { dates?: { date?: unknown; booked?: unknown }[] } | undefined)
        ?.dates;
      const text = Array.isArray(rows)
        ? rows
            .filter((r) => typeof r.date === "string" && typeof r.booked === "number")
            .map((r) => `${String(r.date)}: ${String(r.booked)} booked`)
        : [];
      return `Capacity can't go below what is already booked${text.length ? ` (${listOf(text)})` : ""}. Nothing was changed.`;
    }
    case "INSUFFICIENT_AVAILABILITY":
      return "That would overbook a date: more units are booked than the new capacity. Nothing was changed.";
    case "ITEM_NOT_PAY_AT_PROPERTY":
      return "Only pay-at-property bookings can be settled here.";
    case "ITEM_NOT_CONFIRMED":
      return "Only confirmed bookings can be settled.";
    case "IDEMPOTENCY_KEY_REUSED":
      return "This action was already sent with different details. Reload the page and try again.";
    case "BOOKING_NOT_FOUND":
    case "LISTING_NOT_FOUND":
    case "PROVIDER_NOT_FOUND":
      return "Not found.";
    default:
      return describeApiError(error);
  }
}
