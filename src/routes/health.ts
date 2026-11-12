import { Router } from "express";
import { db } from "../db/connection.js";
import { getTaskCount } from "../services/taskTracker.js";
import { getTokenStatus } from "../services/settingsService.js";
import { OLLAMA_URL, CLAUDE_INFERENCE_BACKEND } from "../config.js";
import { cliSessionCount } from "../services/cliSessions.js";

const router = Router();

router.get("/health", async (_req, res) => {
  let dbStatus = "ok";
  try {
    db.pragma("quick_check");
  } catch {
    dbStatus = "error";
  }

  const token = getTokenStatus();

  let ollamaStatus = "unknown";
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    ollamaStatus = r.ok ? "ok" : "error";
  } catch {
    ollamaStatus = "unreachable";
  }

  res.json({
    status: "ok",
    backend: CLAUDE_INFERENCE_BACKEND === "cli" ? "official-claude-cli" : "native-anthropic-http",
    inference_backend: CLAUDE_INFERENCE_BACKEND,
    ...(CLAUDE_INFERENCE_BACKEND === "cli" ? { cli_sessions: cliSessionCount() } : {}),
    db_status: dbStatus,
    active_tasks: getTaskCount(),
    token_configured: token.configured,
    token_source: token.source,
    ...("state" in token ? { token_state: token.state, token_expires_at: token.expires_at,
      automatic_token_refresh: token.automatic_refresh, auth_refresh: token.refresh } : {}),
    ollama_status: ollamaStatus,
  });
});

export default router;
