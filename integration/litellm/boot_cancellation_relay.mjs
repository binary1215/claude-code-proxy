// Isolated real-application bootstrap for cancellation observations only.
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const fixture = new URL(process.argv[2] ?? '');
const deadline = Number(process.argv[3]);
if (process.argv.length !== 4 || fixture.protocol !== 'http:' || fixture.hostname !== '127.0.0.1'
    || !fixture.port || fixture.pathname !== '/' || fixture.username || fixture.password
    || fixture.search || fixture.hash || !Number.isSafeInteger(deadline) || deadline < 1000 || deadline > 30000) {
  throw new Error('INVALID_LOCAL_CANCELLATION_FIXTURE');
}
const allowed = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'PATHEXT', 'COMSPEC', 'TEMP', 'TMP',
  'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOME']);
for (const name of Object.keys(process.env)) if (!allowed.has(name.toUpperCase())) delete process.env[name];
Object.assign(process.env, {
  DATABASE_PATH: ':memory:', AUTH_DISABLED: 'false',
  ADMIN_API_SECRET: 'local-admin-' + randomBytes(24).toString('hex'),
  ANTHROPIC_BASE_URL: fixture.origin, ANTHROPIC_API_KEY: 'sk-ant-local-fake-only',
  UPSTREAM_TIMEOUT_MS: String(deadline), OLLAMA_URL: fixture.origin,
  RESPONSES_ENABLED: 'true', RESPONSES_STATE_KEY: randomBytes(32).toString('base64'),
  RESPONSES_MAX_OUTPUT_TOKENS: '8192', RESPONSES_THINKING_BUDGET_TOKENS: '1024',
  RESPONSES_STATE_TTL_SECONDS: '604800',
});
console.log = console.warn = console.error = () => {};
const { app } = await import('../../dist/app.js');
const { createApiKey } = await import('../../dist/services/apiKeyService.js');
const { db } = await import('../../dist/db/connection.js');
const key = createApiKey('isolated cancellation fixture').key;
const relay = await new Promise(resolve => {
  const server = app.listen(0, '127.0.0.1', () => resolve(server));
});
const probe = createServer((req, res) => {
  if (req.method !== 'GET' || req.url !== '/history' || req.headers.authorization !== 'Bearer ' + key) {
    res.writeHead(404); res.end(); return;
  }
  const rows = db.prepare('SELECT id, status, duration_ms, upstream_diagnostic FROM request_log ORDER BY id').all();
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ rows }));
});
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
process.stdout.write(JSON.stringify({ relay_port: relay.address().port, history_port: probe.address().port, local_key: key }) + '\n');
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  relay.closeAllConnections(); probe.closeAllConnections();
  relay.close(() => probe.close(() => { db.close(); process.exit(0); }));
  setTimeout(() => process.exit(1), 2000).unref();
};
process.on('SIGTERM', stop); process.on('SIGINT', stop);
