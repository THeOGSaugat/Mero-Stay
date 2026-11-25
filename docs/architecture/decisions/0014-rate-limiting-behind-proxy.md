# 0014. Client IP and per-client rate limits behind the web proxy

- **Status:** Accepted
- **Date:** 2026-11-25
- **Phase:** 09 (closes operational gap 5)

## Context

Since Phase 7 every browser request reaches the API through the web app's `/api/v1` rewrite
(ADR 0010). Express trusted no proxy, so `req.ip` was always the web server's address. The per-IP
limits from ADR 0006 (login 30 / 15 min, registration 5 / hour) were therefore **one global limit
for everyone**: a handful of requests could lock all users out of login or registration. This was
gap 5, the last launch blocker.

**What the web server actually forwards** was checked on Next.js 16.4.6, with `next start` in front
of an echo server:

| Browser sends | The API received |
|---|---|
| No `X-Forwarded-For` | **No `X-Forwarded-For`**; the peer is the web server |
| `X-Forwarded-For: 198.51.100.7` | `198.51.100.7`, **unchanged** |
| `X-Forwarded-For: 1.1.1.1, 198.51.100.7` | `1.1.1.1, 198.51.100.7`, **unchanged** |

The rewrite proxy (`router-server` → `proxyRequest`, httpxy without `xfwd`) neither adds nor
appends anything. So the usual fix, turning on Express `trust proxy`, would be wrong in both
directions:

- the API still could not see real clients;
- every client could choose its own address, and with it a fresh rate-limit budget.

## Decision

### 1. The web server appends the connecting address

`apps/web/server.mts` is the production web server (`npm start`). It is Next.js's documented
custom-server API with one addition: before Next handles a request, it **appends**
`req.socket.remoteAddress` to `X-Forwarded-For` (`src/lib/forwarded-for.mts`). It never
overwrites. What the client wrote stays on the left; an unknown peer is written as `unknown`, so a
client-written entry is never last. The rewrite then passes the header to the API.

- Node runs the file directly with type stripping, so there is no build step.
- `npm run dev` still uses `next dev`, which does not append. Development is not a security
  boundary, so there a client can still pick its own address.

Checked through the real rewrite after the change:

| Browser sends | The API receives |
|---|---|
| Nothing | `::ffff:127.0.0.1` |
| `198.51.100.7` | `198.51.100.7, ::ffff:127.0.0.1` |
| `1.1.1.1, 198.51.100.7` | `1.1.1.1, 198.51.100.7, ::ffff:127.0.0.1` |

### 2. The API trusts an explicit chain, never `true`

Express's `trust proxy` is the function `createProxyTrust` from `src/lib/client-ip.ts`.
proxy-addr calls it for each address, starting at the socket peer (hop 0) and walking
`X-Forwarded-For` from right to left. The client is the first address it does not trust. An
address is trusted only when **both** hold:

| Condition | Setting | Why |
|---|---|---|
| Its hop index is below the hop count | `TRUST_PROXY_HOPS` (0–5) | Entries further left were written by the client. Trust never extends past the known number of proxies, even through trusted addresses (e.g. a browser on the same machine) |
| It is a configured proxy address | `TRUST_PROXY_ADDRESSES`: IPs, CIDR ranges, or `loopback`, `linklocal`, `uniquelocal` | A caller that reaches the API directly from anywhere else is not a proxy, so its `X-Forwarded-For` is ignored. A hop count alone would trust any direct caller |

**Validation at startup (`config/env.ts`):**

- `true`, `*`, `all`, `any` and any `/0` range are refused, with a message naming the variable.
- In **production, both variables are required**; `TRUST_PROXY_HOPS=0` means the API is exposed
  directly and needs no addresses.
- Elsewhere the default is 1 hop from `loopback` (the web server on the same machine).
- `createApp` trusts nothing unless it is given a config.

**Configuration by topology:**

| Topology | `TRUST_PROXY_HOPS` | `TRUST_PROXY_ADDRESSES` |
|---|---|---|
| Web server and API on one host (dev, CI, a single VM) | `1` | `loopback` |
| Web server and API on separate hosts in a private network | `1` | The web server's private address or subnet, e.g. `10.0.1.0/24` |
| An edge/load balancer that **appends** the client in front of the web server | `2` | The web server's address **and** the edge's addresses |
| API exposed directly (no web proxy) | `0` | (none) |

### 3. Keying

- **Login per IP and registration per IP** are keyed by the resolved client.
  - IPv4: the address. An IPv4-mapped IPv6 address (`::ffff:1.2.3.4`) counts as IPv4.
  - IPv6: the **/64**, because one home or phone network normally controls a whole /64 and could
    otherwise rotate addresses to get fresh budgets.
- Each action has its own limiter, so the effective key is (action, client).
- **Login per email is unchanged** and spans clients, so a distributed guess at one account is
  still limited.
- Audit rows store the same resolved, normalised client IP (the full address, not the /64).

### 4. Storage: in memory, one API instance

The limiter stays in process memory (no dependency). That is correct for **one API instance**,
which is the deployment today. Across several instances each would count separately, so limits
would multiply, and a restart resets them.

That limitation is the existing **gap 4**: "shared store before scaling out", targeted at Hardening
(Phase 17). It is not a launch blocker for a single-instance launch. The limiter's
`consume(key)` interface is what a Redis-backed store would implement; no new dependency is added
now.

## Alternatives considered

| Alternative | Why not |
|---|---|
| `app.set("trust proxy", true)` | Trusts any `X-Forwarded-For`; with `next start` passing it through unchanged, any client picks its own bucket |
| A hop count only | Correct behind the proxy, but a caller that reaches the API directly is trusted as a proxy and can spoof |
| Trusted addresses only | In dev, CI or a single VM the browser itself is on loopback (trusted), so the walk continues left into the forged entry. The hop limit stops this |
| Rely on an edge proxy that overwrites the header | Works only where such an edge exists and is configured correctly; dev and CI have none, and nothing in the repository could test it |
| A Route Handler proxy, or Next.js `proxy.ts` | Neither sees the socket address (`NextRequest` has no IP), and the base server keeps a client-supplied header (`??=`) |

## Consequences

- **Deployment (README):**
  - Run the web app with `npm start` (`server.mts`), not `next start` directly.
  - Set `TRUST_PROXY_HOPS` and `TRUST_PROXY_ADDRESSES` for the topology.
  - An edge in front of the web server must **append** to `X-Forwarded-For`, not replace it, or
    the hop count must account for it.
- **Standalone output** (`output: "standalone"`) cannot be combined with a custom server; the
  project does not use it.
- **Tests** (Phase 9 report):
  - unit: resolution through a real Express app, keying, configuration;
  - integration: per-client isolation, forged and untrusted headers, registration, the 2-hop
    edge case, IPv6, audit IP;
  - E2E: a forged header through the real web server never reaches the audit log.
- **Mutation checks:**
  - trusting no proxy fails 6 integration tests;
  - `trust proxy = true` fails 6;
  - raw-IP keys fail the IPv6 test;
  - plain `next start` fails the E2E check.
- **Responses:** unchanged. A limited request is still `429 RATE_LIMITED` with `Retry-After`; it
  now applies to one client instead of everyone.
