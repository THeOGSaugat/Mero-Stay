import { pino } from "pino";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp, type AppDependencies } from "./app.js";
import type { ErrorResponseBody } from "./lib/errors.js";
import type { LivenessResponse, ReadinessResponse } from "./modules/health/health.routes.js";

const silentLogger = pino({ level: "silent" });

function buildApp(overrides: Partial<AppDependencies> = {}) {
  return createApp({
    logger: silentLogger,
    checkDatabase: () => Promise.resolve(),
    ...overrides,
  });
}

describe("GET /api/health (liveness)", () => {
  it("returns 200 with service status", async () => {
    const res = await request(buildApp()).get("/api/health");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    const body = res.body as LivenessResponse;
    expect(body).toMatchObject({ status: "ok", service: "merostay-api" });
    expect(typeof body.uptimeSeconds).toBe("number");
    expect(new Date(body.timestamp).toString()).not.toBe("Invalid Date");
  });

  it("does not depend on the database", async () => {
    const app = buildApp({ checkDatabase: () => Promise.reject(new Error("db down")) });
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
  });

  it("is never cached", async () => {
    const res = await request(buildApp()).get("/api/health");
    expect(res.headers["cache-control"]).toBe("no-store");
  });
});

describe("GET /api/health/ready (readiness)", () => {
  it("returns 200 when the database is reachable", async () => {
    const res = await request(buildApp()).get("/api/health/ready");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "ok",
      service: "merostay-api",
      checks: { database: "up" },
    });
  });

  it("returns 503 without leaking the error when the database is down", async () => {
    const secret = "password authentication failed for user merostay at 10.0.0.5";
    const app = buildApp({ checkDatabase: () => Promise.reject(new Error(secret)) });

    const res = await request(app).get("/api/health/ready");

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: "unavailable", checks: { database: "down" } });
    expect(JSON.stringify(res.body)).not.toContain("password");
  });

  it("returns 503 when the database check hangs past the timeout", async () => {
    const app = buildApp({
      checkDatabase: () => new Promise(() => {}), // never settles
      healthCheckTimeoutMs: 50,
    });

    const res = await request(app).get("/api/health/ready");

    expect(res.status).toBe(503);
    expect((res.body as ReadinessResponse).checks.database).toBe("down");
  });
});

describe("cross-cutting behaviour", () => {
  it("returns a JSON 404 for unknown routes", async () => {
    const res = await request(buildApp()).get("/api/does-not-exist");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: { code: "NOT_FOUND", message: "The requested resource was not found." },
    });
  });

  it("returns 400 INVALID_JSON for malformed JSON bodies", async () => {
    const res = await request(buildApp())
      .post("/api/health")
      .set("Content-Type", "application/json")
      .send("{not json");

    expect(res.status).toBe(400);
    expect((res.body as ErrorResponseBody).error.code).toBe("INVALID_JSON");
  });

  it("returns 413 for oversized bodies", async () => {
    const res = await request(buildApp())
      .post("/api/health")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ data: "x".repeat(200 * 1024) }));

    expect(res.status).toBe(413);
    expect((res.body as ErrorResponseBody).error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("sets security headers and hides the framework", async () => {
    const res = await request(buildApp()).get("/api/health");

    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toBeDefined();
  });

  it("returns a unique request ID on every response", async () => {
    const app = buildApp();
    const a = await request(app).get("/api/health");
    const b = await request(app).get("/api/health");

    expect(a.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.headers["x-request-id"]).not.toBe(b.headers["x-request-id"]);
  });
});
