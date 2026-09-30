import type { Request, Response, NextFunction } from "express";
import { logOperationalError } from "../services/operationalLogger.js";

export function errorHandler(
  err: any,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  logOperationalError("unhandled_request_error", err);

  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    error: {
      message: status >= 500 ? "Internal server error" : "Invalid request",
      type: status >= 500 ? "server_error" : "invalid_request_error",
    },
  });
}
