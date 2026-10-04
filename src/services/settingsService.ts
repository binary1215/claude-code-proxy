import { db } from "../db/connection.js";

// In-memory credential cache, invalidated by the admin API.
let cachedToken: string | null = null;
let cacheLoaded = false;

export function getSetting(key: string): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).run(key, value);

  // Invalidate cache when token changes
  if (key === "claude_oauth_token") {
    cachedToken = value;
    cacheLoaded = true;
  }
}

export function deleteSetting(key: string): void {
  db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  if (key === "claude_oauth_token") {
    cachedToken = null;
    cacheLoaded = true;
  }
}

/**
 * Get the configured upstream credential.
 * Priority: database setting > CLAUDE_CODE_OAUTH_TOKEN env var > ANTHROPIC_API_KEY env var
 */
export function getOAuthToken(): string | null {
  if (!cacheLoaded) {
    cachedToken = getSetting("claude_oauth_token");
    cacheLoaded = true;
  }
  return cachedToken || process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY || null;
}

export function getUpstreamCredential(): { token: string; kind: "oauth" | "api_key" } | null {
  const token = getOAuthToken();
  if (!token) return null;
  const fromDatabase = Boolean(cachedToken);
  const oauth = fromDatabase ? token.startsWith("sk-ant-oat") : Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN);
  return { token, kind: oauth ? "oauth" : "api_key" };
}

/**
 * Get token status info for admin display (never expose the full token).
 */
export function getTokenStatus(): { configured: boolean; source: string; preview: string | null } {
  const preview = (token: string) => token.length >= 24 ? token.slice(0, 8) + "..." + token.slice(-4) : "[configured]";
  const dbToken = getSetting("claude_oauth_token");
  if (dbToken) {
    return {
      configured: true,
      source: "database",
      preview: preview(dbToken),
    };
  }

  const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY;
  if (envToken) {
    return {
      configured: true,
      source: "environment",
      preview: preview(envToken),
    };
  }

  return { configured: false, source: "none", preview: null };
}
