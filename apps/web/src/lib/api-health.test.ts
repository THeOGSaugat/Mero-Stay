import { describe, expect, it, vi } from "vitest";
import { getSystemHealth } from "./api-health";

const BASE = "http://api.test";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("getSystemHealth", () => {
  it("calls the readiness endpoint without caching", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(jsonResponse(200, { status: "ok", checks: { database: "up" } })),
    );

    await getSystemHealth(BASE, { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://api.test/api/health/ready");
    expect(init?.cache).toBe("no-store");
  });

  it("reports API and database up on 200", async () => {
    const fetchImpl = () =>
      Promise.resolve(jsonResponse(200, { status: "ok", checks: { database: "up" } }));

    const health = await getSystemHealth(BASE, { fetchImpl });

    expect(health).toMatchObject({ api: "up", database: "up" });
    expect(new Date(health.checkedAt).toString()).not.toBe("Invalid Date");
  });

  it("reports API up but database down on 503", async () => {
    const fetchImpl = () =>
      Promise.resolve(jsonResponse(503, { status: "unavailable", checks: { database: "down" } }));

    expect(await getSystemHealth(BASE, { fetchImpl })).toMatchObject({
      api: "up",
      database: "down",
    });
  });

  it("reports API down when the request fails", async () => {
    const fetchImpl = () => Promise.reject(new TypeError("fetch failed"));

    expect(await getSystemHealth(BASE, { fetchImpl })).toMatchObject({
      api: "down",
      database: "unknown",
    });
  });

  it("reports API down on unexpected status codes", async () => {
    const fetchImpl = () => Promise.resolve(jsonResponse(500, { error: "boom" }));

    expect((await getSystemHealth(BASE, { fetchImpl })).api).toBe("down");
  });

  it.each([
    ["non-JSON body", new Response("<html>proxy error</html>", { status: 200 })],
    ["wrong shape", jsonResponse(200, { hello: "world" })],
    ["unknown status value", jsonResponse(200, { checks: { database: "maybe" } })],
  ])("reports API down for %s", async (_label, response) => {
    const fetchImpl = () => Promise.resolve(response);

    expect((await getSystemHealth(BASE, { fetchImpl })).api).toBe("down");
  });

  it("gives up after the timeout", async () => {
    // A fetch that only settles when aborted, like a hung server.
    const fetchImpl: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });

    const started = Date.now();
    const health = await getSystemHealth(BASE, { fetchImpl, timeoutMs: 50 });

    expect(health.api).toBe("down");
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
