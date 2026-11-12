import { Router, type Request, type Response } from "express";
import { relayNative } from "../services/nativeRelay.js";
import { relayCli } from "../services/cliRelay.js";
import { CLAUDE_INFERENCE_BACKEND } from "../config.js";

const router = Router();
async function messages(req: Request, res: Response, countTokens: boolean): Promise<void> {
  const body = req.body;
  if (!req.rawBody || !body || typeof body.model !== "string" || !body.model.trim() ||
      !Array.isArray(body.messages) || (!countTokens && (!Number.isInteger(body.max_tokens) || body.max_tokens <= 0)) ||
      (body.stream !== undefined && typeof body.stream !== "boolean")) {
    res.status(400).json({ type: "error", error: { type: "invalid_request_error",
      message: "Expected JSON with model, messages array and (for Messages) positive integer max_tokens; stream must be boolean." } });
    return;
  }
  if (req.allowedModels?.length && !req.allowedModels.includes(body.model)) {
    res.status(403).json({ type: "error", error: { type: "permission_error", message: "Model is not permitted for this key." } });
    return;
  }
  if (CLAUDE_INFERENCE_BACKEND === "cli") {
    if (countTokens) {
      res.status(501).json({ type: "error", error: { type: "invalid_request_error", code: "cli_count_tokens_unavailable",
        message: "CLI owns its expanded prompt; raw Messages token counting would not measure that context. Use the HTTP backend for this endpoint." } });
      return;
    }
    return relayCli(req, res, body);
  }
  return relayNative(req, res, countTokens ? "/messages/count_tokens" : "/messages");
}
router.post("/messages", (req, res) => messages(req, res, false));
router.post("/messages/count_tokens", (req, res) => messages(req, res, true));
router.get("/models", (req, res) => relayNative(req, res, "/models"));
export default router;
