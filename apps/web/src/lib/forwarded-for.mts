/**
 * X-Forwarded-For for requests the web server proxies to the API (ADR 0014, gap 5).
 *
 * `next start` passes a client's X-Forwarded-For to the API unchanged and adds nothing, so the API
 * could neither see the real client nor tell a forged header apart. The web server (server.mts)
 * therefore APPENDS the address of whoever connected to it. Whatever the client wrote stays to the
 * left, where the API ignores it: the API believes only the entries its trusted proxies appended.
 *
 * Plain TypeScript with no framework imports, so Node runs it directly (type stripping).
 */
export function appendForwardedFor(
  existing: string | string[] | undefined,
  peerAddress: string | undefined,
): string {
  const previous = (Array.isArray(existing) ? existing.join(", ") : (existing ?? "")).trim();
  // An unknown peer (socket already closed) must not leave a client-written entry last.
  const peer = peerAddress?.trim() || "unknown";
  return previous ? `${previous}, ${peer}` : peer;
}
