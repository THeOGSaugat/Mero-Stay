const DEVELOPMENT_API_URL = "http://localhost:4000";

type EnvSource = Readonly<Record<string, string | undefined>>;

/**
 * Base URL of the MeroStay API for server-side requests.
 *
 * Must be called during dynamic rendering (after `await connection()`), so the
 * value is read at request time instead of being frozen into the build.
 * Missing in production → throws, so a misconfigured deploy fails loudly.
 */
export function getApiBaseUrl(env: EnvSource = process.env): string {
  const raw = env.API_URL?.trim();

  if (!raw) {
    if (env.NODE_ENV === "production") {
      throw new Error("API_URL must be set in production.");
    }
    return DEVELOPMENT_API_URL;
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("API_URL must be a valid absolute URL, e.g. http://localhost:4000");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("API_URL must use http or https.");
  }

  return raw.replace(/\/+$/, "");
}
