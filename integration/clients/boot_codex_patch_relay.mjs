// Local-only actual application bootstrap. No existing credentials or persistent DB.
import { randomBytes } from 'node:crypto';
let fixture;
try { fixture = new URL(process.argv[2] ?? ''); } catch { process.exit(1); }
if (fixture.protocol !== 'http:' || fixture.hostname !== '127.0.0.1' || !fixture.port
    || fixture.username || fixture.password || fixture.pathname !== '/' || fixture.search || fixture.hash) process.exit(1);
const allowed = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'PATHEXT', 'COMSPEC', 'TEMP', 'TMP',
  'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']);
for (const name of Object.keys(process.env)) if (!allowed.has(name.toUpperCase())) delete process.env[name];
Object.assign(process.env, {
  DATABASE_PATH: ':memory:', AUTH_DISABLED: 'false',
  ADMIN_API_SECRET: 'local-fixture-admin-' + randomBytes(24).toString('hex'),
  ANTHROPIC_BASE_URL: fixture.origin, ANTHROPIC_API_KEY: 'sk-ant-local-fake-only',
  UPSTREAM_TIMEOUT_MS: '20000', OLLAMA_URL: fixture.origin,
  RESPONSES_ENABLED: 'true', RESPONSES_STATE_KEY: randomBytes(32).toString('base64'),
  RESPONSES_MAX_OUTPUT_TOKENS: '8192', RESPONSES_THINKING_BUDGET_TOKENS: '1024',
  RESPONSES_STATE_TTL_SECONDS: '604800', RESPONSES_APPLY_PATCH_MODE: 'validated',
});
console.log = console.warn = console.error = () => {};
try {
  const { app } = await import('../../dist/app.js');
  const { createApiKey } = await import('../../dist/services/apiKeyService.js');
  const { db } = await import('../../dist/db/connection.js');
  const key = createApiKey('isolated coding-tool fixture').key;
  const server = app.listen(0, '127.0.0.1', () => {
    process.stdout.write(JSON.stringify({ local_relay_port: server.address().port, local_relay_key: key }) + '\n');
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true; server.closeAllConnections();
    server.close(() => { db.close(); process.exit(0); });
    setTimeout(() => process.exit(1), 3000).unref();
  };
  server.on('error', stop); process.once('SIGTERM', stop); process.once('SIGINT', stop);
} catch { process.stderr.write('LOCAL_RELAY_START_FAILED\n'); process.exitCode = 1; }
