import type { ErrorRequestHandler } from "express";
import { AppError, type ErrorResponseBody } from "../lib/errors.js";

/** Errors raised by express.json() (body-parser) carry a `type` field. */
function bodyParserErrorType(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "type" in err && typeof err.type === "string") {
    return err.type;
  }
  return undefined;
}

/**
 * Central error handler. Must be registered last.
 * - AppError        → its own status/code/message
 * - Bad JSON / size → 400 / 413
 * - Anything else   → 500 with a generic message (details only in server logs)
 */
export const errorHandler: ErrorRequestHandler = (err: unknown, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }

  let status: number;
  let body: ErrorResponseBody;

  const parserErrorType = bodyParserErrorType(err);

  if (err instanceof AppError) {
    status = err.statusCode;
    body = {
      error: {
        code: err.code,
        message: err.message,
        ...(err.details === undefined ? {} : { details: err.details }),
      },
    };
  } else if (parserErrorType === "entity.parse.failed") {
    status = 400;
    body = { error: { code: "INVALID_JSON", message: "Request body is not valid JSON." } };
  } else if (parserErrorType === "entity.too.large") {
    status = 413;
    body = { error: { code: "PAYLOAD_TOO_LARGE", message: "Request body is too large." } };
  } else {
    status = 500;
    body = {
      error: {
        code: "INTERNAL_ERROR",
        message: "Something went wrong. Please try again later.",
      },
    };
  }

  if (status >= 500) {
    req.log.error({ err }, "Request failed with a server error");
  }

  res.status(status).json(body);
};
