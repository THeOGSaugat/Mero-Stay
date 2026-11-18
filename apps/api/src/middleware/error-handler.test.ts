import express from "express";
import { pino } from "pino";
import { pinoHttp } from "pino-http";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { AppError, type ErrorResponseBody } from "../lib/errors.js";
import { errorHandler } from "./error-handler.js";

function appThatThrows(error: unknown) {
  const app = express();
  app.use(pinoHttp({ logger: pino({ level: "silent" }) }));
  app.get("/boom", () => {
    throw error;
  });
  app.use(errorHandler);
  return app;
}

describe("errorHandler", () => {
  it("maps AppError to its status, code and message", async () => {
    const res = await request(
      appThatThrows(new AppError(409, "CONFLICT", "Already exists", { field: "email" })),
    ).get("/boom");

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: { code: "CONFLICT", message: "Already exists", details: { field: "email" } },
    });
  });

  it("omits details when an AppError has none", async () => {
    const res = await request(appThatThrows(new AppError(400, "BAD", "Bad request"))).get("/boom");
    expect((res.body as ErrorResponseBody).error).not.toHaveProperty("details");
  });

  it("hides internal error messages behind a generic 500", async () => {
    const res = await request(
      appThatThrows(new Error("connect ECONNREFUSED postgres://admin:hunter2@db")),
    ).get("/boom");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: { code: "INTERNAL_ERROR", message: "Something went wrong. Please try again later." },
    });
    expect(JSON.stringify(res.body)).not.toContain("hunter2");
  });

  it("handles non-Error throwables", async () => {
    const res = await request(appThatThrows("a string was thrown")).get("/boom");
    expect(res.status).toBe(500);
    expect((res.body as ErrorResponseBody).error.code).toBe("INTERNAL_ERROR");
  });
});
