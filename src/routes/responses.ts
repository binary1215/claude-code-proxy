import { Router } from "express";
import { RESPONSES_ENABLED } from "../config.js";
import { relayResponses } from "../services/responsesRelay.js";
import { compactResponses } from "../services/responsesCompaction.js";

const router = Router();
router.post("/responses/compact", (req, res) => {
  if (!RESPONSES_ENABLED) {
    res.status(404).json({ error: { type: "invalid_request_error", code: "responses_disabled", message: "The Responses adapter is not enabled on this relay." } });
    return;
  }
  return compactResponses(req, res);
});
router.post("/responses", (req, res) => {
  if (!RESPONSES_ENABLED) {
    res.status(404).json({ error: { type: "invalid_request_error", code: "responses_disabled", message: "The Responses adapter is not enabled on this relay." } });
    return;
  }
  return relayResponses(req, res);
});
export default router;
