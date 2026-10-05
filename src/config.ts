import { mkdirSync } from "fs";
import { dirname } from "path";

export const PORT = parseInt(process.env.PORT || "3456");
export const DATABASE_PATH = process.env.DATABASE_PATH || "./data/proxy.db";
export const ADMIN_API_SECRET = process.env.ADMIN_API_SECRET || "";
export const AUTH_DISABLED = process.env.AUTH_DISABLED === "true";
export const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
export const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 300_000);
if (!Number.isSafeInteger(UPSTREAM_TIMEOUT_MS) || UPSTREAM_TIMEOUT_MS <= 0 || UPSTREAM_TIMEOUT_MS > 2_147_483_647) {
  throw new Error("UPSTREAM_TIMEOUT_MS must be an integer between 1 and 2147483647");
}
export const OLLAMA_URL = process.env.OLLAMA_URL || "http://ollama:11434";

// Opt-in only: existing native deployments do not acquire a new protocol route.
export const RESPONSES_ENABLED = process.env.RESPONSES_ENABLED === "true";
export const RESPONSES_STATE_KEY = process.env.RESPONSES_STATE_KEY || "";
function responsesInteger(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} is outside its supported integer range`);
  }
  return value;
}
export const RESPONSES_STATE_TTL_SECONDS = responsesInteger("RESPONSES_STATE_TTL_SECONDS", 604800, 60, 2592000);
export const RESPONSES_MAX_OUTPUT_TOKENS = responsesInteger("RESPONSES_MAX_OUTPUT_TOKENS", 8192, 1, 65536);
export const RESPONSES_THINKING_BUDGET_TOKENS = responsesInteger("RESPONSES_THINKING_BUDGET_TOKENS", 1024, 0, 65535);
if (RESPONSES_ENABLED && (RESPONSES_THINKING_BUDGET_TOKENS > 0 && RESPONSES_THINKING_BUDGET_TOKENS < 1024 ||
    RESPONSES_THINKING_BUDGET_TOKENS >= RESPONSES_MAX_OUTPUT_TOKENS)) {
  throw new Error("Responses thinking budget must be zero or at least 1024 and below maximum output tokens");
}

// Ensure the database directory exists
mkdirSync(dirname(DATABASE_PATH), { recursive: true });
