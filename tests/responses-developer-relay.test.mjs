import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { after, test } from 'node:test';

Object.assign(process.env, { DATABASE_PATH: ':memory:', AUTH_DISABLED: 'false', ADMIN_API_SECRET: randomBytes(24).toString('hex'),
  ANTHROPIC_API_KEY: 'sk-ant-hoist-synthetic-only', RESPONSES_ENABLED: 'true', RESPONSES_STATE_KEY: randomBytes(32).toString('base64'),
  RESPONSES_DEVELOPER_MESSAGE_MODE: 'hoist', RESPONSES_APPLY_PATCH_MODE: 'reject', UPSTREAM_TIMEOUT_MS: '2000' });
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
const model = 'hoist-http-fixture';
const blocks = [{ type: 'thinking', thinking: 'Synthetic', signature: 'fake-signature' },
  { type: 'thinking', thinking: '', signature: 'fake-empty-signature' }, { type: 'redacted_thinking', data: 'fake-redacted' }, { type: 'text', text: 'Done' }];
const calls = [];
const upstream = http.createServer(async (req, res) => {
  const parts = []; for await (const part of req) parts.push(part);
  const body = JSON.parse(Buffer.concat(parts)); calls.push(body);
  assert.equal(req.headers['x-api-key'], 'sk-ant-hoist-synthetic-only');
  const value = { id: 'msg_hoist', type: 'message', role: 'assistant', model, content: blocks, stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value));
});
upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${upstream.address().port}`;
const { app } = await import('../dist/app.js');
const { db } = await import('../dist/db/connection.js');
const { createApiKey } = await import('../dist/services/apiKeyService.js');
const key = createApiKey('hoist fixture').key;
const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
after(async () => { for (const s of [server, upstream]) { s.closeAllConnections(); await new Promise(resolve => s.close(resolve)); } db.close(); });
const input = [{ role: 'user', content: 'Summary' }, { role: 'developer', content: 'Late instruction' }, { role: 'user', content: 'Next' }];
async function request(items, extra = {}) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/responses`, { method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
    body: JSON.stringify({ model, input: items, instructions: 'Base', stream: false, store: false, ...extra }) });
  return { status: response.status, body: await response.json() };
}

test('real relay seals hoist scope; same-prefix replay succeeds and changed prefixes never contact upstream', async () => {
  const first = await request(input);
  assert.equal(first.status, 200); assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].system, [{ type: 'text', text: 'Base' }, { type: 'text', text: 'Late instruction' }]);
  const history = [...input, ...first.body.output, { role: 'user', content: 'Continue' }];
  const second = await request(history);
  assert.equal(second.status, 200); assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].system, calls[0].system);
  assert.deepEqual(calls[1].messages[1].content, blocks);
  for (const [items, extra] of [
    [[...history, { role: 'developer', content: 'Changed' }], {}],
    [history, { instructions: 'Changed base' }],
    [history.filter(i => i.role !== 'developer'), {}],
    [[...history, { role: 'developer', content: 'Late instruction' }], {}],
  ]) {
    const failed = await request(items, extra);
    assert.equal(failed.status, 409); assert.equal(failed.body.error.code, 'invalid_reasoning_state');
    assert.equal(calls.length, 2);
  }
  const fresh = await request([...input, { role: 'developer', content: 'Changed' }]);
  assert.equal(fresh.status, 200); assert.equal(calls.length, 3);
  // Fixture counters are not evidence of real prompt-cache hits or costs.
  assert.equal(first.body.usage.input_tokens_details.cached_tokens, 0);
});
