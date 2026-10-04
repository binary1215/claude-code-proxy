import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { after, test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';

// Every upstream request in this suite terminates at this loopback fake server.
// There is no SDK mock, subprocess, deployment or real provider credential.
process.env.DATABASE_PATH = ':memory:';
process.env.ADMIN_API_SECRET = randomBytes(24).toString('hex');
process.env.AUTH_DISABLED = 'false';
process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat-synthetic-environment-only';
delete process.env.ANTHROPIC_API_KEY;

const privateText = 'PRIVATE_PROMPT_TOOL_RESULT_AND_REASONING_SENTINEL';
const received = [];
const closedStreams = new Set();
const usage = {
  input_tokens: 11, output_tokens: 7, cache_creation_input_tokens: 100,
  cache_read_input_tokens: 55,
  cache_creation: { ephemeral_5m_input_tokens: 30, ephemeral_1h_input_tokens: 70 },
};
const nativeReply = {
  id: 'msg_fake_native', type: 'message', role: 'assistant', model: 'synthetic-native-model',
  content: [
    { type: 'thinking', thinking: `생각🙂 ${privateText}`, signature: 'opaque-signature+/=한글' },
    { type: 'redacted_thinking', data: 'opaque-redacted+/=' },
    { type: 'tool_use', id: 'tool_unchanged', name: 'caller_tool', input: { path: privateText } },
    { type: 'future_content', opaque: { version: 9, value: '보존' } },
  ],
  stop_reason: 'tool_use', stop_sequence: null, usage, future_response: { preserved: true },
};
const replyBytes = Buffer.from(`  ${JSON.stringify(nativeReply)}\n`, 'utf8');
const errorBytes = Buffer.from(JSON.stringify({ type: 'error', error: {
  type: 'invalid_request_error', message: `Invalid signature in thinking block: ${privateText}`,
} }));
const unknown429Bytes = Buffer.from(JSON.stringify({ type: 'error', error: {
  type: 'rate_limit_error', message: privateText,
} }));
const sseEvent = (name, value) => `event: ${name}\r\ndata: ${JSON.stringify(value)}\r\n\r\n`;
const streamStart = sseEvent('message_start', { type: 'message_start', message: {
  ...nativeReply, content: [], usage: { ...usage, output_tokens: 0 },
} });
const streamBytes = Buffer.from(
  ': untouched comment\r\n\r\n' + streamStart +
  sseEvent('content_block_start', { type: 'content_block_start', index: 0,
    content_block: { type: 'thinking', thinking: '', signature: '' } }) +
  sseEvent('content_block_delta', { type: 'content_block_delta', index: 0,
    delta: { type: 'thinking_delta', thinking: `생각🙂 ${privateText}` } }) +
  sseEvent('content_block_delta', { type: 'content_block_delta', index: 0,
    delta: { type: 'signature_delta', signature: 'opaque-signature+/=한글' } }) +
  sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }) +
  sseEvent('content_block_start', { type: 'content_block_start', index: 1,
    content_block: nativeReply.content[1] }) +
  sseEvent('future_event', { type: 'future_event', nested: { retain: '🙂' } }) +
  sseEvent('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } }) +
  sseEvent('message_stop', { type: 'message_stop' }), 'utf8');
const oversizedStreamBytes = Buffer.from(streamStart +
  sseEvent('future_event', { type: 'future_event', opaque: 'x'.repeat(1024 * 1024 + 1) }) +
  sseEvent('message_delta', { type: 'message_delta', usage: { output_tokens: 7 } }) +
  sseEvent('message_stop', { type: 'message_stop' }));
const diagnosticsLimitThenError = Buffer.from(streamStart +
  sseEvent('future_event', { type: 'future_event', opaque: 'x'.repeat(70 * 1024) }) +
  sseEvent('error', { type: 'error', error: { type: privateText, code: privateText, message: privateText } }));

const upstream = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  let parsed = {};
  try { parsed = JSON.parse(body.toString('utf8')); } catch { /* GET has no body */ }
  received.push({ method: req.method, url: req.url, headers: req.headers, body });
  const scenario = parsed._test_scenario;
  res.setHeader('request-id', 'upstream-request-id');
  res.setHeader('x-native-response', 'untouched');
  if (scenario === 'diagnostic-429') {
    res.writeHead(429, { 'content-type': 'application/json',
      'request-id': 'req_011abcdefghijklmnopqrstuv', 'retry-after': '30',
      'anthropic-ratelimit-unified-5h-status': 'rejected',
      'anthropic-ratelimit-unified-5h-reset': '2000000000',
      'anthropic-ratelimit-unified-5h-utilization': '0.95',
      'x-unknown-quota-secret': privateText,
    });
    return res.end(unknown429Bytes);
  }
  if (scenario === 'invalid-signature') {
    res.writeHead(400, { 'content-type': 'application/json' });
    return res.end(errorBytes);
  }
  if (scenario === 'redirect') {
    res.writeHead(307, { location: `http://127.0.0.1:${upstream.address().port}/must-not-follow` });
    return res.end('do not follow');
  }
  if (scenario === 'gzip') {
    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
    return res.end(gzipSync(replyBytes));
  }
  if (scenario === 'gzip-stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' });
    return res.end(gzipSync(streamBytes));
  }
  if (scenario === 'diagnostics-limit-error' || scenario === 'diagnostics-limit-error-429') {
    res.writeHead(scenario.endsWith('-429') ? 429 : 200, { 'content-type': 'text/event-stream' });
    return res.end(diagnosticsLimitThenError);
  }
  if (scenario === 'uppercase-sse-complete' || scenario === 'uppercase-sse-truncated') {
    res.writeHead(200, { 'content-type': 'Text/Event-Stream; Charset=UTF-8' });
    return res.end(scenario.endsWith('truncated') ? Buffer.from(streamStart) : streamBytes);
  }
  if (scenario === 'oversized-stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (let offset = 0; offset < oversizedStreamBytes.length; offset += 16384) {
      res.write(oversizedStreamBytes.subarray(offset, offset + 16384));
      await new Promise((resolve) => setImmediate(resolve));
    }
    return res.end();
  }
  if (scenario === 'hold') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(streamStart);
    res.on('close', () => closedStreams.add(parsed._test_id));
    return;
  }
  if (parsed.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const bytes = scenario === 'unknown-stream-error' ? Buffer.from(streamStart + sseEvent('error', {
      type: 'error', error: { type: privateText, code: privateText, message: privateText },
    })) : scenario === 'truncated' ? Buffer.from(streamStart) : scenario === 'stream-error' ?
      Buffer.from(streamStart + sseEvent('error', JSON.parse(errorBytes))) : streamBytes;
    // Tiny byte chunks split UTF-8 codepoints and JSON/SSE framing deliberately.
    for (let offset = 0; offset < bytes.length; offset += 7) {
      res.write(bytes.subarray(offset, offset + 7));
      await new Promise((resolve) => setImmediate(resolve));
    }
    return res.end();
  }
  res.setHeader('content-type', 'application/json');
  if (req.url.startsWith('/v1/messages/count_tokens')) return res.end(' {"input_tokens":123,"future_usage":true}\n');
  if (req.url.startsWith('/v1/models')) return res.end('{"data":[{"id":"upstream-native-model","type":"model"}],"has_more":false}');
  if (scenario === 'no-usage') {
    const { usage: _usage, ...replyWithoutUsage } = nativeReply;
    return res.end(JSON.stringify(replyWithoutUsage));
  }
  res.end(replyBytes);
});
upstream.listen(0, '127.0.0.1');
await once(upstream, 'listening');
const upstreamBase = `http://127.0.0.1:${upstream.address().port}`;
process.env.ANTHROPIC_BASE_URL = upstreamBase + '/v1/';

const { app } = await import('../dist/app.js');
const { db } = await import('../dist/db/connection.js');
const keys = await import('../dist/services/apiKeyService.js');
const settings = await import('../dist/services/settingsService.js');
const { listTasks } = await import('../dist/services/taskTracker.js');
const history = await import('../dist/services/historyService.js');
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
let proxyKey;
const auth = () => ({ authorization: `Bearer ${proxyKey.key}` });
const adminAuth = () => ({ authorization: `Bearer ${process.env.ADMIN_API_SECRET}` });
const messages = (extra = {}) => ({ model: 'synthetic-native-model', max_tokens: 100,
  messages: [{ role: 'user', content: privateText }], ...extra });
const latestLog = () => db.prepare('SELECT * FROM request_log ORDER BY id DESC LIMIT 1').get();
async function until(predicate, description) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out: ${description}`);
}
function request(path, body, headers = auth()) {
  const bytes = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request(base + path, { method: bytes ? 'POST' : 'GET', headers: {
      ...(bytes ? { 'content-type': 'application/json', 'content-length': bytes.length } : {}), ...headers,
    } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('Local test request timeout')));
    req.end(bytes);
  });
}
function openHeldStream(id) {
  return new Promise((resolve, reject) => {
    const req = http.request(base + '/v1/messages', { method: 'POST', headers: {
      'content-type': 'application/json', ...auth(),
    } }, (res) => {
      res.on('error', () => {});
      res.once('data', () => resolve({ req, res }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('Local held-stream timeout')));
    req.end(JSON.stringify(messages({ stream: true, _test_scenario: 'hold', _test_id: id })));
  });
}
after(async () => {
  for (const instance of [server, upstream]) {
    instance.closeAllConnections();
    await new Promise((resolve, reject) => instance.close((err) => err ? reject(err) : resolve()));
  }
  db.close();
});

test('unprovisioned API and admin require their separate credentials', async () => {
  for (const path of ['/v1/messages', '/v1/messages/count_tokens', '/v1/models']) {
    assert.equal((await request(path, path.endsWith('models') ? undefined : messages(), {})).status, 401);
  }
  assert.equal((await request('/api/admin/keys', { name: 'test' }, {})).status, 401);
  assert.equal(received.length, 0);
  const provision = await request('/api/admin/keys', { name: 'native-local-test' }, adminAuth());
  assert.equal(provision.status, 201);
  proxyKey = JSON.parse(provision.body);
  keys.updateApiKey(proxyKey.id, { rate_limit_rpm: 300 });
  assert.equal((await request('/v1/messages', messages(), adminAuth())).status, 401);
  assert.equal((await request('/api/admin/tasks', undefined, auth())).status, 401);
});

test('raw request/reply and next-turn thinking, signature, redacted/tool/future blocks survive', async () => {
  const input = messages({
    system: [{ type: 'text', text: `시스템 ${privateText}`, cache_control: { type: 'ephemeral', ttl: '1h' } }],
    thinking: { type: 'enabled', budget_tokens: 2048, unknown_thinking: true },
    tools: [{ name: 'caller_tool', input_schema: { type: 'object', additionalProperties: true },
      cache_control: { type: 'ephemeral', ttl: '5m' }, future_tool: 'unchanged' },
      { type: 'web_search_20260209', name: 'web_search' },
      { type: 'code_execution_20260209', name: 'code_execution' }],
    tool_choice: { type: 'auto' }, metadata: { user_id: 'synthetic-caller', future_metadata: 'unchanged' },
    cache_control: { type: 'ephemeral', ttl: '1h' }, future_top_level: { preserve: '🙂한글' },
  });
  // Removed key-level SDK settings fail closed until deliberately cleared.
  keys.updateApiKey(proxyKey.id, { system_prompt: 'MUST_NOT_BE_INJECTED', cache_ttl_seconds: 17 });
  const beforeGuard = received.length;
  assert.equal((await request('/v1/messages', input)).status, 409);
  assert.equal(received.length, beforeGuard);
  keys.updateApiKey(proxyKey.id, { system_prompt: null, cache_ttl_seconds: null });
  const raw = Buffer.from(` \n${JSON.stringify(input, null, 2)}\n`);
  const headers = { ...auth(), 'x-api-key': proxyKey.key, 'anthropic-version': '2023-06-01',
    'anthropic-beta': 'future-beta-2099-01-01,interleaved-thinking-2025-05-14',
    'user-agent': 'synthetic-native-caller', 'x-request-id': 'caller-correlation-id' };
  const response = await request('/v1/messages', raw, headers);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, replyBytes);
  assert.equal(response.headers['request-id'], 'upstream-request-id');
  assert.equal(response.headers['x-native-response'], 'untouched');
  const call = received.at(-1);
  assert.deepEqual(call.body, raw);
  assert.equal(call.url, '/v1/messages');
  const forwardedBetas = call.headers['anthropic-beta'].split(',').map((value) => value.trim());
  for (const beta of headers['anthropic-beta'].split(',')) assert.ok(forwardedBetas.includes(beta));
  assert.ok(forwardedBetas.includes('oauth-2025-04-20'));
  assert.equal(call.headers['anthropic-version'], headers['anthropic-version']);
  assert.equal(call.headers['user-agent'], headers['user-agent']);
  assert.equal(call.headers.authorization, `Bearer ${process.env.CLAUDE_CODE_OAUTH_TOKEN}`);
  assert.equal(call.headers['x-api-key'], undefined);
  assert.ok(!JSON.stringify(call.headers).includes(proxyKey.key));
  const followup = messages({ tools: input.tools, messages: [input.messages[0],
    { role: 'assistant', content: JSON.parse(response.body).content },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool_unchanged',
      content: [{ type: 'text', text: privateText }], is_error: true,
      cache_control: { type: 'ephemeral', ttl: '1h' } }] },
  ] });
  const followupBytes = Buffer.from(JSON.stringify(followup));
  assert.equal((await request('/v1/messages', followupBytes)).status, 200);
  assert.deepEqual(received.at(-1).body, followupBytes);
});

test('native nonstream cache counters are persisted, unknown price remains NULL', async () => {
  assert.equal((await request('/v1/messages', messages())).status, 200);
  await until(() => latestLog().status !== 'pending', 'nonstream history completion');
  const row = latestLog();
  assert.equal(row.input_tokens, 11);
  assert.equal(row.output_tokens, 7);
  assert.equal(row.cache_creation_input_tokens, 100);
  assert.equal(row.cache_read_input_tokens, 55);
  assert.equal(row.cache_creation_5m_tokens, 30);
  assert.equal(row.cache_creation_1h_tokens, 70);
  assert.equal(row.usage_complete, 1);
  assert.equal(row.total_cost_usd, null);
});

test('raw SSE remains byte-identical through UTF-8/frame cuts and tracks final usage', async () => {
  const response = await request('/v1/messages', messages({ stream: true }));
  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /text\/event-stream/);
  assert.deepEqual(response.body, streamBytes);
  await until(() => latestLog().status !== 'pending', 'SSE history completion');
  const row = latestLog();
  assert.equal(row.status, 'success');
  assert.equal(row.input_tokens, 11);
  assert.equal(row.output_tokens, 7);
  assert.equal(row.cache_creation_5m_tokens, 30);
  assert.equal(row.cache_creation_1h_tokens, 70);
  assert.equal(row.cache_read_input_tokens, 55);
  assert.equal(row.usage_complete, 1);
  assert.equal(row.total_cost_usd, null);
  assert.deepEqual(listTasks(), []);
});

test('invalid signature HTTP 400 is returned verbatim once, without stripping or retry', async () => {
  const before = received.length;
  const body = Buffer.from(JSON.stringify(messages({ _test_scenario: 'invalid-signature',
    thinking: { type: 'enabled', budget_tokens: 1024 }, messages: [
      { role: 'assistant', content: nativeReply.content }, { role: 'user', content: privateText },
    ],
  })));
  const response = await request('/v1/messages', body);
  assert.equal(response.status, 400);
  assert.deepEqual(response.body, errorBytes);
  assert.equal(received.length - before, 1);
  assert.deepEqual(received.at(-1).body, body);
  await until(() => latestLog().status !== 'pending', 'error history completion');
  assert.equal(latestLog().status, 'error');
  assert.equal(latestLog().usage_complete, 0);
  assert.equal(latestLog().total_cost_usd, null);
  assert.equal(latestLog().upstream_http_status, 400);
  assert.equal(latestLog().upstream_error_type, 'invalid_request_error');
  assert.equal(latestLog().upstream_diagnostic, 'provider_error');
});

test('429 diagnostics preserve wire bytes and safe source facts, exposed through authenticated history/export', async () => {
  const before = received.length;
  const response = await request('/v1/messages', messages({ _test_scenario: 'diagnostic-429' }));
  assert.equal(response.status, 429);
  assert.deepEqual(response.body, unknown429Bytes);
  assert.equal(received.length - before, 1);
  assert.equal(response.headers['retry-after'], '30');
  await until(() => latestLog().status !== 'pending', '429 diagnostic history completion');
  const row = latestLog();
  assert.equal(row.upstream_http_status, 429);
  assert.equal(row.upstream_error_type, 'rate_limit_error');
  assert.equal(row.upstream_error_code, null);
  assert.equal(row.upstream_diagnostic, 'unknown_429');
  assert.equal(row.upstream_body_observation, 'observed');
  assert.equal(row.upstream_auth_kind, 'oauth');
  assert.equal(row.upstream_request_id, 'req_011abcdefghijklmnopqrstuv');
  assert.equal(row.upstream_retry_after, '30');
  assert.deepEqual(JSON.parse(row.upstream_quota_headers), {
    'anthropic-ratelimit-unified-5h-status': 'rejected',
    'anthropic-ratelimit-unified-5h-reset': 2000000000,
    'anthropic-ratelimit-unified-5h-utilization': 0.95,
  });
  assert.ok(!JSON.stringify(row).includes(privateText));
  const detail = await request(`/api/admin/history/${row.id}`, undefined, adminAuth());
  assert.equal(detail.status, 200);
  assert.equal(JSON.parse(detail.body).upstream_diagnostic, 'unknown_429');
  const list = await request('/api/admin/history', undefined, adminAuth());
  assert.equal(JSON.parse(list.body).rows.find((value) => value.id === row.id).upstream_http_status, 429);
  const exported = await request('/api/admin/history/export?format=csv', undefined, adminAuth());
  assert.match(exported.body.toString(), /upstream_http_status,upstream_error_type/);
  assert.ok(!exported.body.toString().includes(privateText));
});

test('redirect is returned instead of following it with upstream credentials', async () => {
  const before = received.length;
  const response = await request('/v1/messages', messages({ _test_scenario: 'redirect' }));
  assert.equal(response.status, 307);
  assert.match(response.headers.location, /must-not-follow$/);
  assert.equal(response.body.toString(), 'do not follow');
  assert.equal(received.length - before, 1);
});

test('encoded response bytes and content-encoding remain aligned', async () => {
  const response = await request('/v1/messages', messages({ _test_scenario: 'gzip' }));
  assert.equal(response.status, 200);
  assert.equal(response.headers['content-encoding'], 'gzip');
  assert.deepEqual(response.body, gzipSync(replyBytes));
  assert.deepEqual(gunzipSync(response.body), replyBytes);
});

test('compressed complete SSE is relayed intact and succeeds with unknown usage', async () => {
  const response = await request('/v1/messages', messages({ stream: true, _test_scenario: 'gzip-stream' }));
  assert.equal(response.status, 200);
  assert.equal(response.headers['content-encoding'], 'gzip');
  assert.deepEqual(response.body, gzipSync(streamBytes));
  assert.deepEqual(gunzipSync(response.body), streamBytes);
  await until(() => latestLog().status !== 'pending', 'compressed SSE history completion');
  assert.equal(latestLog().status, 'success');
  assert.equal(latestLog().usage_complete, 0);
  assert.equal(latestLog().input_tokens, null);
  assert.equal(latestLog().output_tokens, null);
  assert.equal(latestLog().total_cost_usd, null);
  assert.equal(latestLog().upstream_body_observation, 'compressed');
  assert.equal(latestLog().upstream_diagnostic, 'success');
});

test('complete SSE over observer event limit remains intact/successful, not falsely truncated', async () => {
  const response = await request('/v1/messages', messages({ stream: true, _test_scenario: 'oversized-stream' }));
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, oversizedStreamBytes);
  await until(() => latestLog().status !== 'pending', 'oversized SSE history completion');
  assert.equal(latestLog().status, 'success');
  assert.equal(latestLog().usage_complete, 0);
  assert.equal(latestLog().total_cost_usd, null);
  assert.equal(latestLog().upstream_body_observation, 'too_large');
  assert.equal(latestLog().upstream_diagnostic, 'success');
});

test('an error observed after the smaller diagnostics limit is never classified as success', async () => {
  for (const scenario of ['diagnostics-limit-error', 'diagnostics-limit-error-429']) {
    const before = received.length;
    const response = await request('/v1/messages', messages({ stream: true, _test_scenario: scenario }));
    assert.equal(response.status, scenario.endsWith('-429') ? 429 : 200);
    assert.deepEqual(response.body, diagnosticsLimitThenError);
    assert.equal(received.length - before, 1);
    await until(() => latestLog().status !== 'pending', 'over-limit error completion');
    const row = latestLog();
    assert.equal(row.status, 'error');
    assert.equal(row.upstream_body_observation, 'too_large');
    assert.equal(row.upstream_diagnostic, scenario.endsWith('-429') ? 'unknown_429' : 'provider_error');
    assert.equal(row.upstream_error_type, null);
    assert.equal(row.upstream_error_code, null);
    assert.ok(!JSON.stringify(row).includes(privateText));
  }
});

test('SSE MIME matching is case-insensitive for complete and truncated stream lifecycles', async () => {
  for (const scenario of ['uppercase-sse-complete', 'uppercase-sse-truncated']) {
    const truncated = scenario.endsWith('truncated');
    const response = await request('/v1/messages', messages({ stream: true, _test_scenario: scenario }));
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, truncated ? Buffer.from(streamStart) : streamBytes);
    await until(() => latestLog().status !== 'pending', 'case-insensitive SSE completion');
    const row = latestLog();
    assert.equal(row.status, truncated ? 'error' : 'success');
    assert.equal(row.usage_complete, truncated ? 0 : 1);
    assert.equal(row.upstream_diagnostic, truncated ? 'truncated_stream' : 'success');
    assert.equal(row.upstream_body_observation, truncated ? 'incomplete' : 'observed');
  }
});

test('upstream models/count_tokens and /v1 base normalization use native routes', async () => {
    const raw = Buffer.from(` ${JSON.stringify(messages({ future_count_field: { preserve: true } }))}\n`);
    const count = await request('/v1/messages/count_tokens', raw, { 'x-api-key': proxyKey.key });
    assert.equal(count.status, 200);
    assert.equal(count.body.toString(), ' {"input_tokens":123,"future_usage":true}\n');
    assert.equal(received.at(-1).url, '/v1/messages/count_tokens');
    assert.deepEqual(received.at(-1).body, raw);
    const models = await request('/v1/models?limit=1&after_id=opaque-id', undefined);
    assert.equal(models.status, 200);
    assert.equal(JSON.parse(models.body).data[0].id, 'upstream-native-model');
    assert.equal(received.at(-1).url, '/v1/models?limit=1&after_id=opaque-id');
    assert.equal(received.at(-1).method, 'GET');
});

test('database credentials override env; OAuth/API-key auth never includes caller credentials', async () => {
  for (const [token, expectedHeader, absentHeader] of [
    ['sk-ant-oat-synthetic-database-only', 'authorization', 'x-api-key'],
    ['sk-ant-api-synthetic-database-only', 'x-api-key', 'authorization'],
  ]) {
    settings.setSetting('claude_oauth_token', token);
    assert.equal((await request('/v1/messages', messages())).status, 200);
    const headers = received.at(-1).headers;
    assert.equal(headers[expectedHeader], expectedHeader === 'authorization' ? `Bearer ${token}` : token);
    assert.equal(headers[absentHeader], undefined);
    assert.ok(!JSON.stringify(headers).includes(proxyKey.key));
  }
  settings.deleteSetting('claude_oauth_token');
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-api-synthetic-environment-only';
  try {
    assert.equal((await request('/v1/messages', messages())).status, 200);
    assert.equal(received.at(-1).headers['x-api-key'], process.env.ANTHROPIC_API_KEY);
    assert.equal(received.at(-1).headers.authorization, undefined);
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat-synthetic-environment-only';
  }
});

test('legacy budget setting fails closed and authenticated admin can explicitly clear it', async () => {
  keys.updateApiKey(proxyKey.id, { monthly_budget_usd: 1 });
  const before = received.length;
  assert.equal((await request('/v1/messages', messages())).status, 409);
  assert.equal(received.length, before);
  const response = await fetch(base + `/api/admin/keys/${proxyKey.id}`, {
    method: 'PATCH', headers: { ...adminAuth(), 'content-type': 'application/json' },
    body: JSON.stringify({ monthly_budget_usd: null, system_prompt: null, cache_ttl_seconds: null }),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  assert.equal((await request('/v1/messages', messages())).status, 200);
});

test('malformed upstream credential fails closed before any network request', async () => {
  settings.setSetting('claude_oauth_token', 'synthetic-key\r\nx-injected-header: forbidden');
  const before = received.length;
  try {
    const response = await request('/v1/messages', messages());
    assert.equal(response.status, 503);
    assert.equal(received.length, before);
  } finally { settings.deleteSetting('claude_oauth_token'); }
});

test('non-ASCII credentials fail closed before a pending history/task or network request exists', async () => {
  const beforeCalls = received.length;
  const beforeRows = db.prepare('SELECT COUNT(*) AS count FROM request_log').get().count;
  settings.setSetting('claude_oauth_token', 'synthetic-invalid-emoji-🙂');
  try {
    const response = await request('/v1/messages', messages());
    assert.equal(response.status, 503);
    assert.equal(received.length, beforeCalls);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM request_log').get().count, beforeRows);
    assert.deepEqual(listTasks(), []);
  } finally { settings.deleteSetting('claude_oauth_token'); }
});

test('short configured credentials never appear in full in admin token status/preview', async () => {
  const originalOAuth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  try {
    for (const token of ['shortkey10', 'short-key-12345']) {
      const setResponse = await request('/api/admin/settings/token', { token }, adminAuth());
      assert.equal(setResponse.status, 200);
      assert.ok(!setResponse.body.toString().includes(token));
      const statusResponse = await request('/api/admin/settings/token', undefined, adminAuth());
      assert.equal(statusResponse.status, 200);
      const status = JSON.parse(statusResponse.body);
      assert.equal(status.configured, true);
      assert.equal(status.source, 'database');
      assert.ok(!statusResponse.body.toString().includes(token));
      settings.deleteSetting('claude_oauth_token');
      process.env.CLAUDE_CODE_OAUTH_TOKEN = token;
      const environmentStatus = await request('/api/admin/settings/token', undefined, adminAuth());
      assert.equal(JSON.parse(environmentStatus.body).source, 'environment');
      assert.ok(!environmentStatus.body.toString().includes(token));
    }
  } finally {
    settings.deleteSetting('claude_oauth_token');
    process.env.CLAUDE_CODE_OAUTH_TOKEN = originalOAuth;
  }
});

test('truncated SSE is forwarded unchanged but logged incomplete/error', async () => {
  const response = await request('/v1/messages', messages({ stream: true, _test_scenario: 'truncated' }));
  assert.deepEqual(response.body, Buffer.from(streamStart));
  await until(() => latestLog().status !== 'pending', 'truncated history completion');
  assert.equal(latestLog().status, 'error');
  assert.equal(latestLog().usage_complete, 0);
  assert.equal(latestLog().total_cost_usd, null);
  assert.deepEqual(listTasks(), []);
  assert.equal(latestLog().upstream_diagnostic, 'truncated_stream');
  assert.equal(latestLog().upstream_body_observation, 'incomplete');
});

test('native SSE error event remains unchanged and is not reported as success', async () => {
  const response = await request('/v1/messages', messages({ stream: true, _test_scenario: 'stream-error' }));
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, Buffer.from(streamStart + sseEvent('error', JSON.parse(errorBytes))));
  await until(() => latestLog().status !== 'pending', 'stream error history completion');
  assert.equal(latestLog().status, 'error');
  assert.equal(latestLog().usage_complete, 0);
  assert.equal(latestLog().total_cost_usd, null);
  assert.deepEqual(listTasks(), []);
  assert.equal(latestLog().upstream_error_type, 'invalid_request_error');
  assert.equal(latestLog().upstream_body_observation, 'observed');
});

test('unrecognized SSE error enums are discarded without misreporting the error event as success', async () => {
  const response = await request('/v1/messages', messages({ stream: true, _test_scenario: 'unknown-stream-error' }));
  assert.deepEqual(response.body, Buffer.from(streamStart + sseEvent('error', {
    type: 'error', error: { type: privateText, code: privateText, message: privateText },
  })));
  await until(() => latestLog().status !== 'pending', 'unknown SSE error history completion');
  const row = latestLog();
  assert.equal(row.status, 'error');
  assert.equal(row.upstream_http_status, 200);
  assert.equal(row.upstream_diagnostic, 'provider_error');
  assert.equal(row.upstream_error_type, null);
  assert.equal(row.upstream_error_code, null);
  assert.equal(row.upstream_body_observation, 'observed');
  assert.ok(!JSON.stringify(row).includes(privateText));
});

test('missing usage is unknown rather than fabricated zero tokens/cost', async () => {
  const response = await request('/v1/messages', messages({ _test_scenario: 'no-usage' }));
  assert.equal(response.status, 200);
  await until(() => latestLog().status !== 'pending', 'unknown usage history completion');
  const row = latestLog();
  assert.equal(row.usage_complete, 0);
  for (const column of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens',
    'cache_read_input_tokens', 'cache_creation_5m_tokens', 'cache_creation_1h_tokens', 'total_cost_usd']) {
    assert.equal(row[column], null, `${column} must remain unknown`);
  }
});

test('client disconnect aborts upstream and persists cancellation without content', async () => {
  const held = await openHeldStream('client-disconnect');
  await until(() => listTasks().length === 1, 'client task registration');
  assert.equal(listTasks()[0].prompt_preview, '');
  held.res.destroy();
  held.req.destroy();
  await until(() => closedStreams.has('client-disconnect') && listTasks().length === 0 &&
    latestLog().status !== 'pending', 'client cancellation propagation');
  assert.equal(latestLog().status, 'cancelled');
  assert.equal(latestLog().usage_complete, 0);
  assert.equal(latestLog().upstream_diagnostic, 'cancelled');
});

test('authenticated admin cancellation aborts active upstream and preserves cancelled status', async () => {
  const held = await openHeldStream('admin-cancel');
  await until(() => listTasks().length === 1, 'admin task registration');
  const [task] = listTasks();
  const response = await request(`/api/admin/tasks/${encodeURIComponent(task.id)}/cancel`, {}, adminAuth());
  assert.equal(response.status, 200);
  await until(() => closedStreams.has('admin-cancel') && latestLog().status !== 'pending', 'admin cancellation propagation');
  assert.equal(latestLog().status, 'cancelled');
  assert.equal(latestLog().usage_complete, 0);
  assert.deepEqual(listTasks(), []);
  assert.equal(latestLog().upstream_diagnostic, 'cancelled');
  held.res.destroy();
  held.req.destroy();
});

test('proxy rate-counts once and rejects legacy OpenAI chat without an upstream call', async () => {
  const limited = keys.createApiKey('rate-limit-local-test');
  keys.updateApiKey(limited.id, { rate_limit_rpm: 2 });
  const headers = { authorization: `Bearer ${limited.key}` };
  const before = received.length;
  assert.equal((await request('/v1/messages', messages(), headers)).status, 200);
  assert.equal((await request('/v1/messages', messages(), headers)).status, 200);
  assert.equal((await request('/v1/messages', messages(), headers)).status, 429);
  assert.equal(received.length - before, 2);
  const callsBeforeChat = received.length;
  const chat = await request('/v1/chat/completions', messages());
  assert.ok([404, 410, 501].includes(chat.status), `legacy chat status ${chat.status}`);
  assert.equal(received.length, callsBeforeChat);
});

test('history storage never retains bodies, opaque signatures, tool inputs or auth secrets', () => {
  const id = history.insertPendingRequest({ apiKeyId: proxyKey.id, completionId: 'legacy-storage',
    requestedModel: 'synthetic-native-model', resolvedModel: 'synthetic-native-model', isStream: false,
    fullPrompt: privateText, promptPreview: privateText });
  history.completeRequest(id, 'error', { fullResponse: privateText, errorMessage: privateText });
  const rows = db.prepare('SELECT * FROM request_log').all();
  for (const row of rows) {
    assert.equal(row.full_prompt, null);
    assert.equal(row.full_response, null);
    assert.equal(row.prompt_preview, null);
  }
  const saved = JSON.stringify(rows);
  for (const secret of [privateText, 'opaque-signature', 'opaque-redacted', proxyKey.key,
    'sk-ant-oat-synthetic', 'sk-ant-api-synthetic']) assert.ok(!saved.includes(secret));
});

test('revoked proxy key cannot invoke the upstream', async () => {
  keys.revokeApiKey(proxyKey.id);
  const before = received.length;
  assert.equal((await request('/v1/models')).status, 401);
  assert.equal(received.length, before);
});
