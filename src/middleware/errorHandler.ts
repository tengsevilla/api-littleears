import type { ErrorRequestHandler, RequestHandler } from "express";
import { AppError } from "../lib/errors.js";
import { fail } from "../lib/response.js";

export const notFound: RequestHandler = (req, res) => {
  res.status(404).json(fail("NOT_FOUND", `Route not found: ${req.method} ${req.path}`));
};

// body-parser errors carry `type` and `status`.
function isBodyParserError(err: unknown): err is { type: string; status: number } {
  return typeof err === "object" && err !== null && "type" in err && "status" in err;
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof AppError) {
    return res.status(err.status).json(fail(err.code, err.message));
  }
  if (isBodyParserError(err)) {
    if (err.type === "entity.too.large") {
      return res.status(413).json(fail("PAYLOAD_TOO_LARGE", "Request body too large"));
    }
    if (err.type === "entity.parse.failed") {
      return res.status(400).json(fail("BAD_REQUEST", "Malformed JSON body"));
    }
  }
  // Log name + message only — never request bodies (may hold tokens or PII).
  console.error("Unhandled error:", err instanceof Error ? `${err.name}: ${err.message}` : err);
  res.status(500).json(fail("INTERNAL", "Internal server error"));
};
