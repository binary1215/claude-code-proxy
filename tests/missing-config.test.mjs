import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { after, test } from 'node:test';
import { randomBytes } from 'node:crypto';

// Separate runner process: missing credentials must fail before even a local upstream call.
process.env.DATABASE_PATH = ':memory:';
process.env.ADMIN_API_SECRET = randomBytes(24).toString('hex');
process.env.AUTH_DISABLED = 'false';
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
delete process.env.ANTHROPIC_API_KEY;
let upstreamCalls = 0;
let lastUpstreamPath;
const upstream = http.createServer((req, res) => {
  upstreamCalls++;
  lastUpstreamPath = req.url;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{"data":[],"has_more":false}');
});
upstream.listen(0, '127.0.0.1');
await once(upstream, 'listening');
// A local root URL also covers the other supported base URL form.
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${upstream.address().port}`;
const { app } = await import('../dist/app.js');
const { db } = await import('../dist/db/connection.js');
const keys = await import('../dist/services/apiKeyService.js');
const key = keys.createApiKey('missing-config-local-test');
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
after(async () => {
  for (const instance of [server, upstream]) {
    instance.closeAllConnections();
    await new Promise((resolve, reject) => instance.close((err) => err ? reject(err) : resolve()));
  }
  db.close();
});

test('missing upstream credentials fail closed for native routes without contact', async () => {
  for (const path of ['/v1/messages', '/v1/messages/count_tokens', '/v1/models']) {
    const response = await fetch(base + path, { method: path.endsWith('models') ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${key.key}`, 'content-type': 'application/json' },
      ...(path.endsWith('models') ? {} : { body: JSON.stringify({ model: 'synthetic-native-model',
        max_tokens: 32, messages: [{ role: 'user', content: 'local fixture only' }] }) }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 503);
    const error = await response.json();
    assert.equal(error.type, 'error');
    assert.ok(error.error?.type);
  }
  assert.equal(upstreamCalls, 0);
});

test('root base URL is normalized to upstream /v1 once credentials are supplied', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-api-synthetic-root-url-only';
  try {
    const response = await fetch(base + '/v1/models', {
      headers: { authorization: `Bearer ${key.key}` }, signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    await response.arrayBuffer();
    assert.equal(upstreamCalls, 1);
    assert.equal(lastUpstreamPath, '/v1/models');
  } finally { delete process.env.ANTHROPIC_API_KEY; }
});
