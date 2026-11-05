import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { credentialStateBinding } from "./claudeCliSession.js";

export type CliAuthState = "login_required" | "ready" | "expired" | "invalid" | "unreadable";
export interface CliAuthStatus {
  configured: boolean;
  source: "claude_cli";
  preview: null;
  state: CliAuthState;
  expires_at: string | null;
  refresh_available: boolean;
  automatic_refresh: boolean;
}

/** Local file readiness only; this does not validate account access with Anthropic. */
export function readClaudeCliCredentials(
  configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
  now = Date.now(),
): { credential: { token: string; kind: "oauth"; stateIdentity?: string } | null; status: CliAuthStatus } {
  const status: CliAuthStatus = { configured: false, source: "claude_cli", preview: null,
    state: "login_required", expires_at: null, refresh_available: false,
    automatic_refresh: process.env.CLAUDE_AUTH_AUTO_REFRESH === "true" };
  const result = { credential: null as { token: string; kind: "oauth"; stateIdentity?: string } | null, status };
  let fd: number | undefined;
  try {
    fd = openSync(join(configDir, ".credentials.json"), "r");
    const maxBytes = 256 * 1024;
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) { status.state = "invalid"; return result; }
    // Read a bounded snapshot, with no retained credential cache across requests.
    const buffer = Buffer.alloc(maxBytes + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = readSync(fd, buffer, bytes, buffer.length - bytes, null);
      if (!count) break;
      bytes += count;
    }
    if (bytes > maxBytes) { status.state = "invalid"; return result; }
    let parsed;
    try { parsed = JSON.parse(buffer.subarray(0, bytes).toString("utf8")); }
    catch { status.state = "invalid"; return result; }
    const oauth = parsed?.claudeAiOauth;
    if (!oauth) return result; // CLI logout can leave an empty credential store.
    const { accessToken, expiresAt, refreshToken } = oauth;
    if (typeof accessToken !== "string" || !accessToken || accessToken.length > 16384 ||
        /[^\x21-\x7e]/.test(accessToken) || !Number.isSafeInteger(expiresAt) ||
        expiresAt <= 0 || expiresAt > 8.64e15) {
      status.state = "invalid";
      return result;
    }
    status.expires_at = new Date(expiresAt).toISOString();
    status.refresh_available = typeof refreshToken === "string" && refreshToken.length > 0;
    if (expiresAt <= now) { status.state = "expired"; return result; }
    status.state = "ready";
    status.configured = true;
    const stateIdentity = status.automatic_refresh ? credentialStateBinding(configDir, accessToken) : undefined;
    result.credential = { token: accessToken, kind: "oauth", ...(stateIdentity ? { stateIdentity } : {}) };
    return result;
  } catch (error) {
    status.state = (error as NodeJS.ErrnoException).code === "ENOENT" ? "login_required" : "unreadable";
    return result;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
