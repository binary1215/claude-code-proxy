import type Database from "better-sqlite3";

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL,
      key_hash      TEXT NOT NULL UNIQUE,
      key_prefix    TEXT NOT NULL,
      is_revoked    INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      revoked_at    TEXT,
      last_used_at  TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);

    CREATE TABLE IF NOT EXISTS request_log (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      api_key_id      INTEGER REFERENCES api_keys(id),
      completion_id   TEXT NOT NULL,
      requested_model TEXT NOT NULL,
      resolved_model  TEXT NOT NULL,
      is_stream       INTEGER NOT NULL DEFAULT 0,
      input_tokens    INTEGER NOT NULL DEFAULT 0,
      output_tokens   INTEGER NOT NULL DEFAULT 0,
      total_cost_usd  REAL NOT NULL DEFAULT 0.0,
      duration_ms     INTEGER NOT NULL DEFAULT 0,
      status          TEXT NOT NULL DEFAULT 'pending',
      error_message   TEXT,
      prompt_preview  TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at    TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_request_log_api_key ON request_log(api_key_id);
    CREATE INDEX IF NOT EXISTS idx_request_log_created ON request_log(created_at);
  `);

  // Migration: add allow_builtin_tools column if it doesn't exist yet
  const keyCols = db
    .prepare("PRAGMA table_info(api_keys)")
    .all() as Array<{ name: string }>;
  if (!keyCols.some((c) => c.name === "allow_builtin_tools")) {
    db.exec(
      "ALTER TABLE api_keys ADD COLUMN allow_builtin_tools INTEGER NOT NULL DEFAULT 0"
    );
  }

  // Migration: add full_prompt and full_response columns for request detail view
  const logCols = db
    .prepare("PRAGMA table_info(request_log)")
    .all() as Array<{ name: string }>;
  if (!logCols.some((c) => c.name === "full_prompt")) {
    db.exec("ALTER TABLE request_log ADD COLUMN full_prompt TEXT");
  }
  if (!logCols.some((c) => c.name === "full_response")) {
    db.exec("ALTER TABLE request_log ADD COLUMN full_response TEXT");
  }

  // Migration: per-key rate limits, budget, model restrictions, system prompt, cache TTL
  // Re-read keyCols in case it was already read above (allow_builtin_tools migration)
  const keyColsV2 = db
    .prepare("PRAGMA table_info(api_keys)")
    .all() as Array<{ name: string }>;
  const keyColNames = new Set(keyColsV2.map((c) => c.name));

  if (!keyColNames.has("rate_limit_rpm")) {
    db.exec("ALTER TABLE api_keys ADD COLUMN rate_limit_rpm INTEGER DEFAULT NULL");
  }
  if (!keyColNames.has("rate_limit_tpm")) {
    db.exec("ALTER TABLE api_keys ADD COLUMN rate_limit_tpm INTEGER DEFAULT NULL");
  }
  if (!keyColNames.has("monthly_budget_usd")) {
    db.exec("ALTER TABLE api_keys ADD COLUMN monthly_budget_usd REAL DEFAULT NULL");
  }
  if (!keyColNames.has("allowed_models")) {
    db.exec("ALTER TABLE api_keys ADD COLUMN allowed_models TEXT DEFAULT NULL");
  }
  if (!keyColNames.has("system_prompt")) {
    db.exec("ALTER TABLE api_keys ADD COLUMN system_prompt TEXT DEFAULT NULL");
  }
  if (!keyColNames.has("cache_ttl_seconds")) {
    db.exec("ALTER TABLE api_keys ADD COLUMN cache_ttl_seconds INTEGER DEFAULT NULL");
  }

  // Migration: settings table for server configuration (OAuth token, etc.)
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Native upstreams do not report billed USD; missing usage must remain unknown.
  // Rebuild only the old NOT NULL schema, transactionally preserving every row.
  const usageCols = db.prepare("PRAGMA table_info(request_log)").all() as Array<{ name: string; notnull: number }>;
  if (usageCols.some(c => c.name === "input_tokens" && c.notnull === 1)) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE request_log_native (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          api_key_id INTEGER REFERENCES api_keys(id),
          completion_id TEXT NOT NULL, requested_model TEXT NOT NULL, resolved_model TEXT NOT NULL,
          is_stream INTEGER NOT NULL DEFAULT 0,
          input_tokens INTEGER, output_tokens INTEGER, total_cost_usd REAL,
          duration_ms INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending',
          error_message TEXT, prompt_preview TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')), completed_at TEXT,
          full_prompt TEXT, full_response TEXT
        );
        INSERT INTO request_log_native SELECT id, api_key_id, completion_id, requested_model, resolved_model,
          is_stream, input_tokens, output_tokens, total_cost_usd, duration_ms, status, error_message,
          prompt_preview, created_at, completed_at, full_prompt, full_response FROM request_log;
        DROP TABLE request_log;
        ALTER TABLE request_log_native RENAME TO request_log;
        CREATE INDEX idx_request_log_api_key ON request_log(api_key_id);
        CREATE INDEX idx_request_log_created ON request_log(created_at);
      `);
    })();
  }
  const nativeCols = new Set((db.prepare("PRAGMA table_info(request_log)").all() as Array<{ name: string }>).map(c => c.name));
  for (const column of ["cache_creation_input_tokens", "cache_read_input_tokens", "cache_creation_5m_tokens", "cache_creation_1h_tokens"]) {
    if (!nativeCols.has(column)) db.exec(`ALTER TABLE request_log ADD COLUMN ${column} INTEGER`);
  }
  if (!nativeCols.has("usage_complete")) db.exec("ALTER TABLE request_log ADD COLUMN usage_complete INTEGER NOT NULL DEFAULT 0");
  // Passive, allowlisted upstream diagnostics. Existing history remains unknown (NULL).
  for (const column of ["upstream_http_status", "upstream_error_type", "upstream_error_code",
    "upstream_request_id", "upstream_retry_after", "upstream_quota_headers", "upstream_auth_kind",
    "upstream_diagnostic", "upstream_body_observation"]) {
    if (!nativeCols.has(column)) db.exec(`ALTER TABLE request_log ADD COLUMN ${column} ${column === "upstream_http_status" ? "INTEGER" : "TEXT"}`);
  }
}
