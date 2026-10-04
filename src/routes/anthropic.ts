import { Router, type Request, type Response } from "express";
import { relayNative } from "../services/nativeRelay.js";

const router = Router();
function messages(req: Request, res: Response, countTokens: boolean): void {
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
  relayNative(req, res, countTokens ? "/messages/count_tokens" : "/messages");
}
router.post("/messages", (req, res) => messages(req, res, false));
router.post("/messages/count_tokens", (req, res) => messages(req, res, true));
router.get("/models", (req, res) => relayNative(req, res, "/models"));
export default router;
