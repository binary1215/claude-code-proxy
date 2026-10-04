import type { Request, Response, NextFunction } from "express";
import { logOperationalError } from "../services/operationalLogger.js";

export function errorHandler(
  err: any,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  logOperationalError("unhandled_request_error", err);

  if (res.headersSent) { res.destroy(); return; }
  const candidate = err.status || err.statusCode;
  const status = Number.isInteger(candidate) && candidate >= 400 && candidate <= 599 ? candidate : 500;
  res.status(status).json({
    type: "error",
    error: {
      message: status >= 500 ? "Internal server error" : "Invalid request",
      type: status >= 500 ? "server_error" : "invalid_request_error",
    },
  });
}
