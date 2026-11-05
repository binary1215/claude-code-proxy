import { existsSync, readFileSync, statSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

export type RefreshState = "idle" | "refreshing" | "refreshed" | "retrying" | "login_required";
export interface RefreshRecord {
  state: RefreshState;
  checked_at: string;
  last_success_at: string | null;
  next_attempt_at: string | null;
  failures: number;
  successes: number;
  reason: string | null;
  access_digest: string | null;
  refresh_digest: string | null;
}
const states = new Set(["idle", "refreshing", "refreshed", "retrying", "login_required"]);
const reasons = new Set(["credential_missing", "refresh_unavailable", "login_rejected", "command_failed",
  "refresh_not_observed", "command_timeout", "account_changed", "login", "logout", "login_failed", "logout_failed"]);
export function readRefreshRecord(dir: string): RefreshRecord | null {
  try {
    const file = join(dir, ".proxy-auth-refresh.json");
    if (!existsSync(file) || statSync(file).size > 16384) return null;
    const value = JSON.parse(readFileSync(file, "utf8"));
    if (!states.has(value.state) || typeof value.checked_at !== "string" ||
        !Number.isSafeInteger(value.failures) || !Number.isSafeInteger(value.successes)) return null;
    return value as RefreshRecord;
  } catch { return null; }
}
export function saveRefreshRecord(dir: string, record: RefreshRecord): void {
  const file = join(dir, ".proxy-auth-refresh.json");
  const tmp = file + `.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
  renameSync(tmp, file);
}
/** Never expose internal fingerprints or raw CLI output to health/admin callers. */
export function publicRefreshStatus(dir: string): object | null {
  const r = readRefreshRecord(dir);
  if (!r) return null;
  const date = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
  return { state: r.state, checked_at: date(r.checked_at), last_success_at: date(r.last_success_at),
    next_attempt_at: date(r.next_attempt_at), failures: Math.max(0, r.failures), successes: Math.max(0, r.successes),
    reason: r.reason && reasons.has(r.reason) ? r.reason : null };
}
