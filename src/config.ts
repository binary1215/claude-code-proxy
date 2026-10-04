import { mkdirSync } from "fs";
import { dirname } from "path";

export const PORT = parseInt(process.env.PORT || "3456");
export const DATABASE_PATH = process.env.DATABASE_PATH || "./data/proxy.db";
export const ADMIN_API_SECRET = process.env.ADMIN_API_SECRET || "";
export const AUTH_DISABLED = process.env.AUTH_DISABLED === "true";
export const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
export const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 300_000);
if (!Number.isFinite(UPSTREAM_TIMEOUT_MS) || UPSTREAM_TIMEOUT_MS <= 0) {
  throw new Error("UPSTREAM_TIMEOUT_MS must be positive");
}
export const OLLAMA_URL = process.env.OLLAMA_URL || "http://ollama:11434";

// Ensure the database directory exists
mkdirSync(dirname(DATABASE_PATH), { recursive: true });
