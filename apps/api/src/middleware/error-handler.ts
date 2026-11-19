import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { mapDatabaseError } from "../lib/database-errors.js";
import { AppError, type ErrorResponseBody } from "../lib/errors.js";

/** Errors raised by express.json() (body-parser) carry a `type` field. */
function bodyParserErrorType(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "type" in err && typeof err.type === "string") {
    return err.type;
  }
  return undefined;
}

function appErrorBody(err: AppError): ErrorResponseBody {
  return {
    error: {
      code: err.code,
      message: err.message,
      ...(err.details === undefined ? {} : { details: err.details }),
    },
  };
}

/**
 * Central error handler. Must be registered last.
 * - AppError                 → its own status/code/message
 * - ZodError (validation)    → 400 VALIDATION_ERROR with the failing fields
 * - DB constraint violations → 409 / 422 via mapDatabaseError (raw PostgreSQL text never leaks)
 * - Bad JSON / size          → 400 / 413
 * - Anything else            → 500 with a generic message (details only in server logs)
 */
export const errorHandler: ErrorRequestHandler = (err: unknown, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }

  let status: number;
  let body: ErrorResponseBody;

  const parserErrorType = bodyParserErrorType(err);
  const databaseError = err instanceof AppError ? null : mapDatabaseError(err);

  if (err instanceof AppError) {
    status = err.statusCode;
    body = appErrorBody(err);
  } else if (err instanceof ZodError) {
    status = 400;
    body = {
      error: {
        code: "VALIDATION_ERROR",
        message: "The request is invalid.",
        details: err.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
    };
  } else if (databaseError) {
    status = databaseError.statusCode;
    body = appErrorBody(databaseError);
    if (databaseError.code === "PRICING_INVARIANT_VIOLATED") {
      // Should be impossible: the API computes every amount. Treat as a bug.
      req.log.error({ err }, "Database rejected API-computed booking amounts");
    } else {
      req.log.warn({ code: databaseError.code }, "Database constraint violation");
    }
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
