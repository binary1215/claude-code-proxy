import { createHash, randomBytes } from "node:crypto";
import { closeSync, fstatSync, fsyncSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Digest-only observations. Expiry may be in the past while refresh remains possible. */
export interface AuthSnapshot {
  accessDigest: string;
  refreshDigest: string | null;
  accountDigest: string | null;
  expiresAt: number;
  refreshAvailable: boolean;
}

interface SessionRecord {
  version: 1;
  sessionId: string;
  accessDigest: string;
  refreshDigest: string | null;
  accountDigest: string | null;
}

const FILE = ".proxy-auth-session.json";
const DIGEST = /^[0-9a-f]{64}$/;
const MAX_JSON_BYTES = 256 * 1024;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** No parse/IO exception or original file content escapes a read-only observation. */
function readJson(file: string, maxBytes = MAX_JSON_BYTES): unknown {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    const bytes = Buffer.alloc(maxBytes + 1);
    let used = 0;
    while (used < bytes.length) {
      const count = readSync(fd, bytes, used, bytes.length - used, null);
      if (!count) break;
      used += count;
    }
    if (used > maxBytes) return null;
    return JSON.parse(bytes.subarray(0, used).toString("utf8"));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* The observation remains unavailable. */ }
    }
  }
}

function token(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 16384 && !/[^\x21-\x7e]/.test(value);
}

function accountDigest(configDir: string): string | null {
  const config = readJson(join(configDir, ".claude.json"));
  const account = record(config) ? config.oauthAccount : null;
  if (!record(account)) return null;
  const { accountUuid, organizationUuid } = account;
  if (typeof accountUuid !== "string" || !accountUuid || accountUuid.length > 1024 ||
      typeof organizationUuid !== "string" || !organizationUuid || organizationUuid.length > 1024) return null;
  return hash(JSON.stringify(["claude-cli-account-v1", accountUuid, organizationUuid]));
}

export function readAuthSnapshot(configDir: string): AuthSnapshot | null {
  const raw = readJson(join(configDir, ".credentials.json"));
  const oauth = record(raw) ? raw.claudeAiOauth : null;
  if (!record(oauth) || !token(oauth.accessToken) || typeof oauth.expiresAt !== "number" ||
      !Number.isSafeInteger(oauth.expiresAt) || oauth.expiresAt <= 0 || oauth.expiresAt > 8.64e15) return null;
  const refreshDigest = token(oauth.refreshToken) ? hash(oauth.refreshToken) : null;
  return { accessDigest: hash(oauth.accessToken), refreshDigest, accountDigest: accountDigest(configDir),
    expiresAt: oauth.expiresAt, refreshAvailable: refreshDigest !== null };
}

function readSession(configDir: string): SessionRecord | null {
  const value = readJson(join(configDir, FILE), 4096);
  if (!record(value) || value.version !== 1 || typeof value.sessionId !== "string" || !DIGEST.test(value.sessionId) ||
      typeof value.accessDigest !== "string" || !DIGEST.test(value.accessDigest) ||
      !(value.refreshDigest === null || typeof value.refreshDigest === "string" && DIGEST.test(value.refreshDigest)) ||
      !(value.accountDigest === null || typeof value.accountDigest === "string" && DIGEST.test(value.accountDigest))) return null;
  return value as unknown as SessionRecord;
}

function sameCredential(session: SessionRecord, snapshot: AuthSnapshot): boolean {
  return session.accessDigest === snapshot.accessDigest && session.refreshDigest === snapshot.refreshDigest &&
    session.accountDigest === snapshot.accountDigest;
}

function validSnapshot(snapshot: AuthSnapshot): boolean {
  return DIGEST.test(snapshot.accessDigest) &&
    (snapshot.refreshDigest === null || DIGEST.test(snapshot.refreshDigest)) &&
    (snapshot.accountDigest === null || DIGEST.test(snapshot.accountDigest)) &&
    Number.isSafeInteger(snapshot.expiresAt) && snapshot.expiresAt > 0 && snapshot.expiresAt <= 8.64e15 &&
    snapshot.refreshAvailable === (snapshot.refreshDigest !== null);
}

/** Mutation callers hold the shared CLI flock; request handlers never call this. */
function writeSession(configDir: string, snapshot: AuthSnapshot, sessionId = randomBytes(32).toString("hex")): void {
  if (!validSnapshot(snapshot)) throw new Error("Invalid authentication snapshot.");
  const value: SessionRecord = { version: 1, sessionId, accessDigest: snapshot.accessDigest,
    refreshDigest: snapshot.refreshDigest, accountDigest: snapshot.accountDigest };
  const destination = join(configDir, FILE);
  const temporary = join(configDir, `${FILE}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(value));
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, destination);
  } catch {
    throw new Error("Unable to persist CLI authentication session.");
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* Preserve the primary write failure. */ }
    }
    try { unlinkSync(temporary); } catch { /* Absent after successful rename. */ }
  }
}

export function observeAuthSession(configDir: string, snapshot: AuthSnapshot): void {
  const current = readSession(configDir);
  if (current && sameCredential(current, snapshot)) return;
  writeSession(configDir, snapshot);
}

/** Only an observed, successful same-account refresh carries a prior session forward. */
export function acceptAuthRefresh(configDir: string, before: AuthSnapshot, after: AuthSnapshot): boolean {
  const current = readSession(configDir);
  const preserve = current !== null && sameCredential(current, before) && before.accountDigest !== null &&
    before.accountDigest === after.accountDigest && before.accessDigest !== after.accessDigest &&
    after.expiresAt > before.expiresAt && after.expiresAt > Date.now();
  writeSession(configDir, after, preserve ? current.sessionId : undefined);
  return preserve;
}

export function clearAuthSession(configDir: string): void {
  try { unlinkSync(join(configDir, FILE)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Unable to clear CLI authentication session.");
  }
}

/** Read-only binding check. A mismatched/missing record falls back to ordinary token binding. */
export function credentialStateBinding(configDir: string, accessToken: string): string | undefined {
  if (!token(accessToken)) return undefined;
  const current = readSession(configDir);
  if (!current || !current.accountDigest || current.accessDigest !== hash(accessToken) ||
      current.accountDigest !== accountDigest(configDir)) return undefined;
  return `cli-session:${current.sessionId}:${current.accountDigest}`;
}
