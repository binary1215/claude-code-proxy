import type { Request, Response, NextFunction } from "express";

/** Fail closed on settings that the native transport cannot enforce. */
export function nativeConfigurationGuard(req: Request, res: Response, next: NextFunction): void {
  if (req.monthlyBudgetUsd != null || req.keySystemPrompt != null || req.cacheTtlSeconds != null) {
    res.status(409).json({ type: "error", error: {
      type: "invalid_request_error",
      message: "This key has removed SDK settings (budget, system prompt or cache TTL). Migrate budget enforcement to LiteLLM and send system/cache_control in requests, then clear those key settings through the admin API.",
    } });
    return;
  }
  next();
}
