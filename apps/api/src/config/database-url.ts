/**
 * Neon gives every database two hosts that differ only by "-pooler":
 *   pooled: ep-cool-name-123456-pooler.region.aws.neon.tech
 *   direct: ep-cool-name-123456.region.aws.neon.tech
 *
 * The API uses the pooled URL; the Prisma CLI needs the direct one. So the only
 * value a developer has to paste is the pooled DATABASE_URL, and the direct URL
 * is derived from it. DATABASE_URL_UNPOOLED can still be set to override this.
 *
 * Kept dependency-free so `prisma.config.ts` can import it.
 */
export function deriveDirectUrl(pooledUrl: string): string {
  const url = new URL(pooledUrl);
  url.hostname = url.hostname.replace(/-pooler(?=\.)/, "");
  return url.toString();
}

/** The direct (non-pooled) connection string: explicit override, else derived. */
export function resolveDirectUrl(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  if (env.DATABASE_URL_UNPOOLED) return env.DATABASE_URL_UNPOOLED;
  if (!env.DATABASE_URL) return undefined;
  try {
    return deriveDirectUrl(env.DATABASE_URL);
  } catch {
    return undefined;
  }
}
