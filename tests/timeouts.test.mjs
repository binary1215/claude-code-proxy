import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { after, test } from 'node:test';
import { randomBytes } from 'node:crypto';

// Isolated runner process: all network traffic stays at this local fake upstream.
process.env.DATABASE_PATH = ':memory:';
process.env.ADMIN_API_SECRET = randomBytes(24).toString('hex');
process.env.AUTH_DISABLED = 'false';
process.env.UPSTREAM_TIMEOUT_MS = '200';
process.env.ANTHROPIC_API_KEY = 'sk-ant-api-synthetic-timeout-only';
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
const closed = new Set();
const calls = [];
const startBytes = Buffer.from('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":11,"output_tokens":0}}}\n\n');
const upstream = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const scenario = JSON.parse(Buffer.concat(chunks))._test_scenario;
  calls.push(scenario);
  res.on('close', () => closed.add(scenario));
  if (scenario === 'no-headers') return; // Wait for the proxy's deadline, not a test-side abort.
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(startBytes);
  if (scenario === 'socket-abort') setTimeout(() => res.destroy(), 15);
});
upstream.listen(0, '127.0.0.1');
await once(upstream, 'listening');
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${upstream.address().port}`;
const { app } = await import('../dist/app.js');
const { db } = await import('../dist/db/connection.js');
const keys = await import('../dist/services/apiKeyService.js');
const { listTasks } = await import('../dist/services/taskTracker.js');
const key = keys.createApiKey('timeout-local-test');
keys.updateApiKey(key.id, { rate_limit_rpm: 200 });
// A trigger observes persistence finalization without mocking the implementation.
db.exec(`CREATE TEMP TABLE completion_audit (request_id INTEGER, status TEXT);
  CREATE TEMP TRIGGER audit_completion AFTER UPDATE OF status ON request_log
  WHEN NEW.status <> 'pending'
  BEGIN INSERT INTO completion_audit VALUES (NEW.id, NEW.status); END;`);
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

function request(scenario) {
  return new Promise((resolve, reject) => {
    const req = http.request(base + '/v1/messages', { method: 'POST', headers: {
      authorization: `Bearer ${key.key}`, 'content-type': 'application/json',
    } }, (res) => {
      const chunks = [];
      let ended = false;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve({ status: res.statusCode, body: Buffer.concat(chunks), ended });
      };
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => { ended = true; finish(); });
      res.on('aborted', finish);
      res.on('error', finish);
      res.on('close', finish);
    });
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('Local fixture request timed out')));
    req.end(JSON.stringify({ model: 'synthetic-timeout-model', max_tokens: 32,
      stream: scenario !== 'no-headers', messages: [{ role: 'user', content: 'local timeout fixture only' }],
      _test_scenario: scenario }));
  });
}
async function assertFinalizedOnce(scenario) {
  for (let i = 0; i < 100; i++) {
    if (closed.has(scenario) && listTasks().length === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(closed.has(scenario), 'upstream connection is closed');
  assert.deepEqual(listTasks(), []);
  // Allow late close/error/deadline callbacks; they must not finalize or cancel again.
  await new Promise((resolve) => setTimeout(resolve, 250));
  const row = db.prepare('SELECT * FROM request_log ORDER BY id DESC LIMIT 1').get();
  assert.equal(row.status, 'error');
  assert.equal(row.usage_complete, 0);
  assert.equal(row.total_cost_usd, null);
  assert.equal(row.error_message, 'upstream_error');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM completion_audit WHERE request_id = ?').get(row.id).count, 1);
  assert.equal(calls.filter((value) => value === scenario).length, 1);
  assert.deepEqual(listTasks(), []);
  return row;
}

test('upstream deadline before headers returns 502 and finalizes once as error', async () => {
  const response = await request('no-headers');
  assert.equal(response.status, 502);
  assert.equal(response.ended, true);
  assert.equal(JSON.parse(response.body).error.type, 'api_error');
  const row = await assertFinalizedOnce('no-headers');
  assert.equal(row.upstream_diagnostic, 'timeout');
  assert.equal(row.upstream_http_status, null);
  assert.equal(row.upstream_body_observation, 'not_received');
  assert.equal(row.input_tokens, null);
  assert.equal(row.output_tokens, null);
});

test('held SSE deadline disconnects without synthetic bytes and finalizes error/incomplete', async () => {
  const response = await request('held-sse');
  assert.equal(response.status, 200);
  assert.equal(response.ended, false);
  assert.deepEqual(response.body, startBytes);
  const row = await assertFinalizedOnce('held-sse');
  assert.equal(row.upstream_diagnostic, 'timeout');
  assert.equal(row.upstream_http_status, 200);
  assert.equal(row.upstream_body_observation, 'incomplete');
  assert.equal(row.input_tokens, 11);
  assert.equal(row.output_tokens, 0);
});

test('upstream socket abort cleans up task/history once, never overwrites error as cancelled', async () => {
  const response = await request('socket-abort');
  assert.equal(response.status, 200);
  assert.equal(response.ended, false);
  assert.deepEqual(response.body, startBytes);
  const row = await assertFinalizedOnce('socket-abort');
  assert.equal(row.upstream_diagnostic, 'network_error');
});
