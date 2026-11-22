import { connection } from "next/server";
import type { ApiErrorBody } from "./api-types";
import { getApiBaseUrl } from "./config";

/**
 * Server → API calls for PUBLIC pages (search, listing details), rendered on the server for SEO
 * and a light first load on mobile data. Called during request-time rendering (inside
 * <Suspense>, Cache Components). No cookies are forwarded: these pages show public data only.
 * Server-only: it uses `connection()` from next/server and the server's API_URL.
 */
export type ServerApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; code: string; message: string };

export async function serverApi<T>(path: string): Promise<ServerApiResult<T>> {
  await connection();
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/v1${path}`, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    const body: unknown = await response.json().catch(() => null);
    if (response.ok) return { ok: true, status: response.status, data: body as T };
    const error = (body as ApiErrorBody | null)?.error;
    return {
      ok: false,
      status: response.status,
      code: error?.code ?? "UNEXPECTED_RESPONSE",
      message: error?.message ?? "The service did not answer as expected.",
    };
  } catch {
    return {
      ok: false,
      status: 0,
      code: "NETWORK_ERROR",
      message: "MeroStay is not reachable right now.",
    };
  }
}
