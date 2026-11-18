import type { RequestHandler } from "express";
import type { ErrorResponseBody } from "../lib/errors.js";

/** Catch-all for unknown routes. Registered after every router. */
export const notFoundHandler: RequestHandler = (_req, res) => {
  const body: ErrorResponseBody = {
    error: { code: "NOT_FOUND", message: "The requested resource was not found." },
  };
  res.status(404).json(body);
};
