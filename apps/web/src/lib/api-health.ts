export type ServiceState = "up" | "down" | "unknown";

export interface SystemHealth {
  /** Whether the API answered with a recognisable health response. */
  api: "up" | "down";
  /** Database status as reported by the API; "unknown" if the API is unreachable. */
  database: ServiceState;
  /** ISO timestamp of when the check was made. */
  checkedAt: string;
}

export interface GetSystemHealthOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Shape of GET /api/health/ready (see apps/api health.routes.ts). */
function readDatabaseStatus(body: unknown): "up" | "down" | null {
  if (typeof body !== "object" || body === null || !("checks" in body)) return null;
  const { checks } = body;
  if (typeof checks !== "object" || checks === null || !("database" in checks)) return null;
  const { database } = checks;
  return database === "up" || database === "down" ? database : null;
}

/**
 * Asks the API's readiness endpoint whether the API and database are healthy.
 * Never throws: any network error, timeout or unexpected response is reported
 * as the API being down.
 */
export async function getSystemHealth(
  apiBaseUrl: string,
  { fetchImpl = fetch, timeoutMs = 3_000 }: GetSystemHealthOptions = {},
): Promise<SystemHealth> {
  const checkedAt = new Date().toISOString();
  const unreachable: SystemHealth = { api: "down", database: "unknown", checkedAt };

  try {
    const response = await fetchImpl(`${apiBaseUrl}/api/health/ready`, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });

    // 200 = ready, 503 = API up but a dependency is down. Anything else is unexpected.
    if (response.status !== 200 && response.status !== 503) return unreachable;

    const database = readDatabaseStatus(await response.json());
    if (database === null) return unreachable;

    return { api: "up", database, checkedAt };
  } catch {
    return unreachable;
  }
}
