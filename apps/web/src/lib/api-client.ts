import type { ApiErrorBody } from "./api-types";

/**
 * Browser → API calls (ADR 0010). The browser only talks to its OWN origin: `/api/v1/*` is
 * rewritten by Next.js to the API (next.config.ts), so the httpOnly session cookie stays
 * first-party and no CORS is needed. Every call sends `credentials: "include"`; writes send the
 * `X-CSRF-Token` header (from GET /auth/me, login or register). Nothing is stored in
 * localStorage: the CSRF token lives in memory (React state).
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    /** Seconds from a 429 `Retry-After` header. */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiRequest {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  csrfToken?: string | null;
  /**
   * Extra request headers (e.g. `X-Provider-Id`, `Idempotency-Key`). They cannot replace the ones
   * this client sets itself (Accept, Content-Type, X-CSRF-Token).
   */
  headers?: Record<string, string>;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

export const API_PREFIX = "/api/v1";

function isErrorBody(body: unknown): body is ApiErrorBody {
  return (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof (body as ApiErrorBody).error?.code === "string"
  );
}

/** Calls the API on the same origin. Resolves with the parsed body; throws ApiError otherwise. */
export async function apiRequest<T>(path: string, request: ApiRequest = {}): Promise<T> {
  const { method = "GET", body, csrfToken, fetchImpl = fetch } = request;
  const headers: Record<string, string> = { ...request.headers, Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET" && csrfToken) headers["X-CSRF-Token"] = csrfToken;

  let response: Response;
  try {
    response = await fetchImpl(`${API_PREFIX}${path}`, {
      method,
      headers,
      credentials: "include",
      cache: "no-store",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "NETWORK_ERROR", "Could not reach MeroStay. Check your connection.");
  }

  if (response.status === 204) return undefined as T;
  const parsed: unknown = await response.json().catch(() => null);
  if (response.ok) return parsed as T;

  const retryAfter = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
  if (isErrorBody(parsed)) {
    throw new ApiError(
      response.status,
      parsed.error.code,
      parsed.error.message,
      parsed.error.details,
      Number.isFinite(retryAfter) ? retryAfter : undefined,
    );
  }
  throw new ApiError(response.status, "UNEXPECTED_RESPONSE", "Something went wrong. Try again.");
}

/** Validation details from a 400, as "field: message" lines. */
function validationLines(details: unknown): string[] {
  if (!Array.isArray(details)) return [];
  return details
    .filter((d): d is { path: string; message: string } => typeof d?.message === "string")
    .map((d) => (d.path ? `${d.path}: ${d.message}` : d.message));
}

function minutes(seconds: number): string {
  const m = Math.max(1, Math.ceil(seconds / 60));
  return `${m} minute${m === 1 ? "" : "s"}`;
}

/** A short, human message for an API error (shown next to the form or action that failed). */
export function describeApiError(error: unknown): string {
  if (!(error instanceof ApiError)) return "Something went wrong. Try again.";
  switch (error.code) {
    case "INVALID_CREDENTIALS":
      return "Email or password is incorrect.";
    case "EMAIL_TAKEN":
      return "An account with this email already exists. Log in instead.";
    case "PHONE_TAKEN":
      return "An account with this phone number already exists.";
    case "RATE_LIMITED":
      return error.retryAfterSeconds
        ? `Too many attempts. Try again in ${minutes(error.retryAfterSeconds)}.`
        : "Too many attempts. Try again later.";
    case "UNSUPPORTED_MEDIA_TYPE":
      return "The request was sent in the wrong format. Reload the page and try again.";
    case "UNAUTHENTICATED":
      return "Please log in to continue.";
    case "CSRF_TOKEN_INVALID":
      return "Your session needs refreshing. Reload the page and try again.";
    case "INSUFFICIENT_AVAILABILITY":
      return "Not enough availability for those dates and quantity. Try fewer units or other dates.";
    case "NOT_AVAILABLE":
      return "That date is not available for booking.";
    case "CURRENCY_MISMATCH":
      return "This item is priced in a different currency from your trip. Start a separate trip for it.";
    case "TRIP_EXPIRED":
      return "Your trip's hold has expired. Start a new trip.";
    case "TRIP_NOT_EDITABLE":
      return "This trip has been submitted and can no longer be changed.";
    case "TRIP_EMPTY":
      return "Add at least one item before confirming.";
    case "ITEM_NO_LONGER_BOOKABLE":
      return "One of the items can no longer be booked. Remove it and try again.";
    case "DATE_IN_PAST":
      return "Choose a date that is not in the past.";
    case "INVALID_DATE_RANGE":
      return "Check the dates: the end must be after the start.";
    case "TRIP_NOT_FOUND":
    case "NOT_FOUND":
      return "Not found.";
    case "VALIDATION_ERROR": {
      const lines = validationLines(error.details);
      return lines.length > 0 ? `Please check: ${lines.join("; ")}` : error.message;
    }
    case "NETWORK_ERROR":
      return error.message;
    default:
      return error.message || "Something went wrong. Try again.";
  }
}
