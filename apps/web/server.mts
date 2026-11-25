/**
 * Production web server: `next start` plus one line of proxy hygiene (ADR 0014, gap 5).
 *
 * Browsers call the API through this server (`/api/v1/*` is rewritten to API_URL, ADR 0010).
 * Before Next.js handles a request, the address of whoever connected here is APPENDED to
 * X-Forwarded-For, so the API (which trusts this server for exactly one hop) rate-limits and
 * audits the real client, and a client-written X-Forwarded-For cannot choose its own address.
 *
 * Run with `npm start` (NODE_ENV=production node server.mts; Node strips the types). Listens on
 * PORT (default 3000) on all interfaces, like `next start`. `npm run dev` still uses `next dev`:
 * development is not a security boundary.
 */
import { createServer } from "node:http";
import next from "next";
import { appendForwardedFor } from "./src/lib/forwarded-for.mts";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const app = next({ dev: false, dir: import.meta.dirname, port });
const handle = app.getRequestHandler();

await app.prepare();

const server = createServer((req, res) => {
  req.headers["x-forwarded-for"] = appendForwardedFor(
    req.headers["x-forwarded-for"],
    req.socket.remoteAddress,
  );
  void handle(req, res);
});

server.listen(port, () => {
  console.log(`MeroStay web listening on http://localhost:${port} (production)`);
});

function shutdown(): void {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
