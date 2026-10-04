import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { runMigrations } from '../dist/db/migrations.js';

test('legacy history/key/settings migration preserves rows, permits NULL usage and is idempotent', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE api_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE, key_prefix TEXT NOT NULL,
        is_revoked INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
        revoked_at TEXT, last_used_at TEXT
      );
      CREATE TABLE request_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, api_key_id INTEGER REFERENCES api_keys(id),
        completion_id TEXT NOT NULL, requested_model TEXT NOT NULL, resolved_model TEXT NOT NULL,
        is_stream INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0, total_cost_usd REAL NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending',
        error_message TEXT, prompt_preview TEXT, created_at TEXT NOT NULL, completed_at TEXT,
        full_prompt TEXT, full_response TEXT
      );
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
      INSERT INTO api_keys VALUES (7, 'existing-key', 'synthetic-hash', 'test-prefix', 0,
        '2026-01-02 03:04:05', NULL, NULL);
      INSERT INTO request_log VALUES (42, 7, 'legacy-completion', 'legacy-model', 'legacy-model',
        1, 100, 50, 0.125, 123, 'success', NULL, NULL,
        '2026-01-02 03:04:05', '2026-01-02 03:04:06', NULL, NULL);
      INSERT INTO settings VALUES ('claude_oauth_token', 'synthetic-existing-setting', '2026-01-02 03:04:05');
    `);
    const oldRow = db.prepare('SELECT * FROM request_log WHERE id = 42').get();
    runMigrations(db);
    const migrated = db.prepare('SELECT * FROM request_log WHERE id = 42').get();
    for (const [column, value] of Object.entries(oldRow)) assert.equal(migrated[column], value);
    assert.equal(migrated.usage_complete, 0);
    for (const column of ['cache_creation_input_tokens', 'cache_read_input_tokens',
      'cache_creation_5m_tokens', 'cache_creation_1h_tokens']) assert.equal(migrated[column], null);
    assert.equal(db.prepare('SELECT name FROM api_keys WHERE id = 7').get().name, 'existing-key');
    assert.equal(db.prepare('SELECT value FROM settings WHERE key = ?').get('claude_oauth_token').value,
      'synthetic-existing-setting');
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    runMigrations(db);
    assert.deepEqual(db.prepare('SELECT * FROM request_log WHERE id = 42').get(), migrated);
    db.prepare(`INSERT INTO request_log (api_key_id, completion_id, requested_model, resolved_model,
      input_tokens, output_tokens, total_cost_usd) VALUES (7, 'native-unknown', 'native', 'native', NULL, NULL, NULL)`).run();
    const native = db.prepare('SELECT * FROM request_log ORDER BY id DESC LIMIT 1').get();
    assert.ok(native.id > 42);
    assert.equal(native.input_tokens, null);
    assert.equal(native.output_tokens, null);
    assert.equal(native.total_cost_usd, null);
    runMigrations(db);
    assert.deepEqual(db.prepare('SELECT * FROM request_log WHERE id = ?').get(native.id), native);
  } finally { db.close(); }
});
