import { BlockList, isIP } from "node:net";
import type { Request } from "express";

/**
 * Client IP behind the MeroStay web server (ADR 0014, gap 5).
 *
 * Browsers reach the API through the web app's `/api/v1` proxy, so the API's socket peer is the
 * web server. The web server appends that peer address to `X-Forwarded-For` (apps/web/server.mts).
 * The API believes a forwarded entry only when every hop that reported it is:
 *
 * - **one of the configured proxy addresses** (a direct caller from anywhere else is not a proxy,
 *   so its `X-Forwarded-For` is ignored), and
 * - **within the configured number of hops** (entries further left were written by the client and
 *   are ignored, so a forged header cannot pick its own rate-limit bucket).
 *
 * Express's `trust proxy` is never `true`.
 */
export interface TrustProxyConfig {
  /** Proxies in front of the API: 0 = API exposed directly; 1 = the web server; 2 = web + edge. */
  hops: number;
  /**
   * Addresses those proxies connect from: IPs, CIDR ranges, or the names `loopback`, `linklocal`,
   * `uniquelocal` (private ranges). Never all addresses.
   */
  addresses: readonly string[];
}

/** Trust nothing: `req.ip` is the socket peer. The default when no config is given. */
export const NO_TRUSTED_PROXY: TrustProxyConfig = { hops: 0, addresses: [] };

export const MAX_TRUST_PROXY_HOPS = 5;

/** The same named ranges Express (proxy-addr) knows. */
const NAMED_RANGES: Record<string, readonly string[]> = {
  loopback: ["127.0.0.1/8", "::1/128"],
  linklocal: ["169.254.0.0/16", "fe80::/10"],
  uniquelocal: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"],
};

/** Values that would trust every address; refused with a clear message. */
const TRUST_EVERYTHING = new Set(["true", "*", "all", "any"]);

/**
 * Parses `TRUST_PROXY_ADDRESSES` (comma-separated). Throws a message naming the bad entry; never
 * accepts anything that trusts every address.
 */
export function parseTrustedAddresses(raw: string): string[] {
  const entries = raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) throw new Error("must list at least one address or range");
  for (const entry of entries) {
    if (TRUST_EVERYTHING.has(entry)) {
      throw new Error(`"${entry}" would trust every address; list the proxy addresses instead`);
    }
    if (entry in NAMED_RANGES) continue;
    const [address = "", prefixText, extra] = entry.split("/");
    const family = isIP(address);
    if (family === 0 || extra !== undefined) {
      throw new Error(
        `"${entry}" is not an IP address, CIDR range or loopback/linklocal/uniquelocal`,
      );
    }
    if (prefixText !== undefined) {
      const prefix = Number(prefixText);
      const max = family === 4 ? 32 : 128;
      if (!/^\d+$/.test(prefixText) || prefix > max) {
        throw new Error(`"${entry}" has an invalid prefix length`);
      }
      if (prefix === 0) throw new Error(`"${entry}" would trust every address`);
    }
  }
  return entries;
}

/** `::ffff:1.2.3.4` → `1.2.3.4`; lower-case; `undefined` for anything that is not an IP. */
export function normalizeIp(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  let ip = raw.trim().toLowerCase();
  // Zone ids ("fe80::1%en0") never matter for limits.
  ip = ip.split("%")[0] ?? ip;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  if (mapped?.[1]) ip = mapped[1];
  return isIP(ip) === 0 ? undefined : ip;
}

function buildBlockList(addresses: readonly string[]): BlockList {
  const list = new BlockList();
  for (const entry of addresses.flatMap((a) => NAMED_RANGES[a] ?? [a])) {
    const [address = "", prefixText] = entry.split("/");
    const type = isIP(address) === 6 ? "ipv6" : "ipv4";
    if (prefixText === undefined) list.addAddress(address, type);
    else list.addSubnet(address, Number(prefixText), type);
  }
  return list;
}

/**
 * The function Express uses for `trust proxy`. proxy-addr calls it with each address, starting at
 * the socket peer (hop 0) and walking `X-Forwarded-For` right to left; the client IP is the first
 * address it does not trust.
 */
export function createProxyTrust(
  config: TrustProxyConfig,
): (address: string, hop: number) => boolean {
  if (config.hops <= 0 || config.addresses.length === 0) return () => false;
  const trusted = buildBlockList(config.addresses);
  return (address, hop) => {
    if (hop >= config.hops) return false;
    const ip = normalizeIp(address);
    if (!ip) return false;
    return trusted.check(ip, isIP(ip) === 6 ? "ipv6" : "ipv4");
  };
}

/** The resolved client IP of a request (normalised), or `undefined` when unknown. */
export function clientIp(req: Pick<Request, "ip">): string | undefined {
  return normalizeIp(req.ip);
}

/**
 * The rate-limit bucket for a client IP. IPv4: the address. IPv6: its /64, because one client
 * (one home or phone network) usually controls a whole /64 and could otherwise rotate addresses
 * to get fresh budgets.
 */
export function rateLimitKeyForIp(ip: string | undefined): string {
  const normalized = normalizeIp(ip);
  if (!normalized) return "unknown";
  if (isIP(normalized) === 4) return normalized;
  // Rare IPv6 forms with an embedded IPv4 tail (other than ::ffff:, normalised above): the address.
  if (normalized.includes(".")) return `${normalized}/128`;
  const [head = "", tail] = normalized.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups =
    tail === undefined
      ? left
      : [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right];
  const prefix = groups.slice(0, 4).map((g) => g.padStart(4, "0"));
  return `${prefix.join(":")}::/64`;
}
