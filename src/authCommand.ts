import { spawn } from "node:child_process";
import { readAuthSnapshot, observeAuthSession, acceptAuthRefresh, clearAuthSession,
  type AuthSnapshot } from "./services/claudeCliSession.js";
import { readRefreshRecord, saveRefreshRecord, publicRefreshStatus, type RefreshRecord } from "./services/authRefreshStatus.js";

// This entry point is always run under the helper's cross-process flock.
const dir = process.env.CLAUDE_CONFIG_DIR;
if (!dir) throw new Error("CLAUDE_CONFIG_DIR is required");
const authDir: string = dir;
const action = process.argv[2];
const previous = readRefreshRecord(authDir);
const windowMs = 180_000; // Verified at two minutes; poll at most once per minute.
function record(state: RefreshRecord["state"], snapshot: AuthSnapshot | null,
  reason: string | null, failures = 0, success = false, delayMs: number | null = null): void {
  saveRefreshRecord(authDir, { state, checked_at: new Date().toISOString(),
    last_success_at: success ? new Date().toISOString() : previous?.last_success_at ?? null,
    next_attempt_at: delayMs === null ? null : new Date(Date.now() + delayMs).toISOString(),
    failures, successes: (previous?.successes ?? 0) + (success ? 1 : 0), reason,
    access_digest: snapshot?.accessDigest ?? null, refresh_digest: snapshot?.refreshDigest ?? null });
}
function cli(args: string[], interactive: boolean): Promise<{ code: number | null; timedOut: boolean; loggedIn?: boolean }> {
  const env = { ...process.env };
  for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR", "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR"]) delete env[key];
  env.DISABLE_AUTOUPDATER = "1";
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  return new Promise(resolve => {
    const child = spawn("claude", ["auth", ...args], { cwd: authDir, env,
      stdio: interactive ? "inherit" : ["ignore", "pipe", "ignore"] });
    let stdout = "";
    let timedOut = false;
    let forcedKill: NodeJS.Timeout | undefined;
    const timer = interactive ? undefined : setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forcedKill = setTimeout(() => child.kill("SIGKILL"), 1000);
    }, 60_000);
    child.stdout?.on("data", data => { if (stdout.length < 65536) stdout += data.toString().slice(0, 65536 - stdout.length); });
    child.once("error", () => { if (timer) clearTimeout(timer); resolve({ code: null, timedOut }); });
    child.once("close", code => {
      if (timer) clearTimeout(timer);
      if (forcedKill) clearTimeout(forcedKill);
      let loggedIn: boolean | undefined;
      try { const v = JSON.parse(stdout); if (typeof v.loggedIn === "boolean") loggedIn = v.loggedIn; } catch { /* no raw output retained */ }
      resolve({ code, timedOut, loggedIn });
    });
  });
}
async function main(): Promise<void> {
  if (action === "login" || action === "logout") {
    clearAuthSession(authDir);
    const args = action === "login" && process.env.CLAUDE_AUTH_EMAIL
      ? ["login", "--email", process.env.CLAUDE_AUTH_EMAIL] : [action];
    const result = await cli(args, true);
    const after = readAuthSnapshot(authDir);
    if (result.code === 0 && after) observeAuthSession(authDir, after);
    record(after ? "idle" : "login_required", after, result.code === 0 ? action : action === "login" ? "login_failed" : "logout_failed");
    process.exitCode = result.code ?? 1;
    return;
  }
  if (action !== "refresh") { process.exitCode = 2; return; }
  const before = readAuthSnapshot(authDir);
  if (!before) {
    clearAuthSession(authDir);
    record("login_required", null, "credential_missing");
    return;
  }
  // An uncoordinated external login/token change gets a new conversation scope.
  observeAuthSession(authDir, before);
  if (before.expiresAt > Date.now() + windowMs) {
    record("idle", before, null, 0, false, before.expiresAt - Date.now() - windowMs);
    return;
  }
  if (!before.refreshAvailable) { record("login_required", before, "refresh_unavailable"); return; }
  const sameCredential = previous?.access_digest === before.accessDigest && previous?.refresh_digest === before.refreshDigest;
  if (sameCredential && previous?.state === "login_required") return;
  if (sameCredential && previous?.state === "retrying" && previous.next_attempt_at && Date.parse(previous.next_attempt_at) > Date.now()) return;
  record("refreshing", before, null);
  const result = await cli(["status", "--json"], false);
  const after = readAuthSnapshot(authDir);
  // Exit 0 is not proof: official CLI also returns it after a transient 503.
  if (after && after.accessDigest !== before.accessDigest && after.expiresAt > before.expiresAt && after.expiresAt > Date.now()) {
    const preserved = acceptAuthRefresh(authDir, before, after);
    record("refreshed", after, preserved ? null : "account_changed", 0, true, Math.max(60_000, after.expiresAt - Date.now() - windowMs));
    return;
  }
  if (!after || result.loggedIn === false) {
    clearAuthSession(authDir);
    record("login_required", after, "login_rejected");
    return;
  }
  // The CLI may judge a still-usable token not due yet. Try again on the next tick.
  if (result.code === 0 && after.expiresAt > Date.now()) {
    record("idle", after, null, 0, false, 60_000);
    return;
  }
  const failures = (sameCredential ? previous?.failures ?? 0 : 0) + 1;
  record("retrying", after, result.timedOut ? "command_timeout" : result.code !== 0 ? "command_failed" : "refresh_not_observed",
    failures, false, Math.min(300_000, 30_000 * 2 ** Math.min(failures - 1, 4)));
}
main().then(() => { if (action === "refresh") console.log(JSON.stringify(publicRefreshStatus(authDir))); })
  .catch(() => { console.error("Claude authentication management failed; inspect auth volume access."); process.exitCode = 1; });
