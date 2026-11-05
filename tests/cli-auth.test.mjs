import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, unlinkSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { randomBytes } from 'node:crypto';

const dir = mkdtempSync(join(tmpdir(), 'proxy-cli-auth-'));
const path = join(dir, '.credentials.json');
const expiry = Date.now() + 3_600_000;
const firstToken = 'sk-ant-oat-synthetic-cli-first';
const nextToken = 'sk-ant-oat-synthetic-cli-rotated';
const refresh = 'SYNTHETIC_PRIVATE_REFRESH_DO_NOT_REPORT';
const nativeInput = { model: 'native-fixture', max_tokens: 32,
  messages: [{ role: 'user', content: 'fixture' }] };
function writeToken(token = firstToken, expiresAt = expiry) {
  writeFileSync(path + '.tmp', JSON.stringify({ claudeAiOauth: { accessToken: token,
    expiresAt, refreshToken: refresh, scopes: ['user:inference'] } }), { mode: 0o600 });
  renameSync(path + '.tmp', path);
}
process.env.DATABASE_PATH = ':memory:';
process.env.ADMIN_API_SECRET = randomBytes(24).toString('hex');
process.env.AUTH_DISABLED = 'false';
process.env.UPSTREAM_AUTH_SOURCE = 'claude_cli';
process.env.CLAUDE_CONFIG_DIR = dir;
process.env.CLAUDE_CODE_OAUTH_TOKEN = 'synthetic-env-must-not-be-used';
process.env.ANTHROPIC_API_KEY = 'synthetic-paid-key-must-not-be-used';
process.env.RESPONSES_ENABLED = 'true';
process.env.RESPONSES_STATE_KEY = randomBytes(32).toString('base64');
const received = [];
const upstream = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  received.push({ auth: req.headers.authorization, key: req.headers['x-api-key'],
    body: Buffer.concat(chunks).toString(), url: req.url });
  res.setHeader('content-type', 'application/json');
  if (req.url.includes('models')) return res.end('{"data":[],"has_more":false}');
  res.end(JSON.stringify({ id: 'msg_fixture', type: 'message', role: 'assistant', model: 'native-fixture',
    content: [{ type: 'text', text: 'synthetic only' }], stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 } }));
});
upstream.listen(0, '127.0.0.1');
await once(upstream, 'listening');
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${upstream.address().port}`;
process.env.OLLAMA_URL = process.env.ANTHROPIC_BASE_URL;
const { app } = await import('../dist/app.js');
const { db } = await import('../dist/db/connection.js');
const { createApiKey } = await import('../dist/services/apiKeyService.js');
const settings = await import('../dist/services/settingsService.js');
const { readClaudeCliCredentials } = await import('../dist/services/claudeCliCredentials.js');
const { upstreamStateScope } = await import('../dist/services/responsesState.js');
settings.setSetting('claude_oauth_token', 'synthetic-db-must-not-be-used');
const key = createApiKey('local-cli-auth-fixture');
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
const headers = { authorization: `Bearer ${key.key}`, 'content-type': 'application/json' };
async function call(route, body) {
  const response = await fetch(base + route, { method: body ? 'POST' : 'GET', headers,
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000) });
  return { status: response.status, body: await response.json() };
}
after(async () => {
  for (const instance of [server, upstream]) {
    instance.closeAllConnections();
    await new Promise(resolve => instance.close(resolve));
  }
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('missing login does not use existing database or env credentials on either route', async () => {
  assert.equal(settings.getUpstreamCredential(), null);
  assert.equal(settings.getTokenStatus().state, 'login_required');
  for (const route of ['/v1/messages', '/v1/responses']) {
    const result = await call(route, nativeInput);
    assert.equal(result.status, 503);
    assert.match(result.body.error.message, /claude-auth login/);
  }
  assert.equal(received.length, 0);
});

test('login immediately enables native and Responses HTTP calls; file rotation is observed', async () => {
  writeToken();
  const nativeBody = { model: 'native-fixture', max_tokens: 32,
    messages: [{ role: 'user', content: 'fixture' }], future_field: 'preserve' };
  assert.equal((await call('/v1/messages', nativeBody)).status, 200);
  assert.equal(received.at(-1).auth, `Bearer ${firstToken}`);
  assert.equal(received.at(-1).body, JSON.stringify(nativeBody));
  assert.equal(received.at(-1).key, undefined);
  assert.equal((await call('/v1/responses', { model: 'native-fixture', input: 'fixture' })).status, 200);
  assert.equal(received.at(-1).auth, `Bearer ${firstToken}`);
  const before = upstreamStateScope('fixture', settings.getUpstreamCredential());
  writeToken(nextToken);
  assert.equal((await call('/v1/models')).status, 200);
  assert.equal(received.at(-1).auth, `Bearer ${nextToken}`);
  assert.notEqual(upstreamStateScope('fixture', settings.getUpstreamCredential()), before,
    'Existing credential binding is intentionally not weakened during rotation');
});

test('status reports expiry but never access/refresh tokens or preview', async () => {
  const response = await fetch(base + '/api/admin/settings/token', {
    headers: { authorization: `Bearer ${process.env.ADMIN_API_SECRET}` } });
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.equal(status.state, 'ready');
  assert.equal(status.expires_at, new Date(expiry).toISOString());
  assert.equal(status.refresh_available, true);
  assert.equal(status.automatic_refresh, false);
  assert.equal(status.preview, null);
  for (const secret of [firstToken, nextToken, refresh]) assert.ok(!JSON.stringify(status).includes(secret));
});

test('expiry, partial writes and logout stop subsequent calls without stale fallback', async () => {
  const count = received.length;
  writeToken(firstToken, Date.now() - 1);
  assert.equal(settings.getTokenStatus().state, 'expired');
  assert.equal((await call('/v1/messages', nativeInput)).status, 503);
  writeFileSync(path, '{"claudeAiOauth":');
  assert.equal(settings.getTokenStatus().state, 'invalid');
  assert.equal((await call('/v1/responses', {})).status, 503);
  writeToken();
  assert.equal(settings.getUpstreamCredential().token, firstToken);
  unlinkSync(path);
  assert.equal(settings.getTokenStatus().state, 'login_required');
  assert.equal((await call('/v1/models')).status, 503);
  assert.equal(received.length, count);
});

test('invalid schema, empty store, non-ASCII token and bounded file have safe status', () => {
  for (const value of [null, {}, { claudeAiOauth: null }]) {
    writeFileSync(path, JSON.stringify(value));
    assert.equal(readClaudeCliCredentials(dir).status.state, 'login_required');
  }
  for (const oauth of [[], 'unexpected', { accessToken: firstToken },
    { accessToken: 'invalid\nheader', expiresAt: expiry },
    { accessToken: firstToken, expiresAt: Number.MAX_SAFE_INTEGER }]) {
    writeFileSync(path, JSON.stringify({ claudeAiOauth: oauth }));
    assert.equal(readClaudeCliCredentials(dir).status.state, 'invalid');
  }
  writeFileSync(path, 'x'.repeat(256 * 1024 + 1));
  assert.equal(readClaudeCliCredentials(dir).status.state, 'invalid');
});

test('admin token mutations cannot claim to log in or out of the CLI store', async () => {
  writeToken();
  for (const method of ['POST', 'DELETE']) {
    const response = await fetch(base + '/api/admin/settings/token', { method,
      headers: { authorization: `Bearer ${process.env.ADMIN_API_SECRET}`, 'content-type': 'application/json' },
      ...(method === 'POST' ? { body: JSON.stringify({ token: 'ignored-synthetic-token' }) } : {}) });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.type, 'credential_source_managed_by_cli');
    assert.equal(settings.getUpstreamCredential().token, firstToken);
  }
});
