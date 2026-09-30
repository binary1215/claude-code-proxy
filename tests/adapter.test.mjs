import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, before, mock, test } from 'node:test';
import { randomBytes } from 'node:crypto';

// No real credential, SDK subprocess, Anthropic request or installed service.
process.env.DATABASE_PATH = ':memory:';
process.env.ADMIN_API_SECRET = randomBytes(24).toString('hex');
process.env.AUTH_DISABLED = 'false';
process.env.ALLOW_SERVER_SIDE_TOOLS = 'false';
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
delete process.env.ANTHROPIC_API_KEY;

const secretText = 'PRIVATE_SOURCE_AND_TOOL_ARGUMENT_SENTINEL';
let scenario = 'text';
const sdkCalls = [];
mock.module('@anthropic-ai/claude-agent-sdk', {
  namedExports: {
    tool: (name, description, schema, handler) => ({ name, description, schema, handler }),
    createSdkMcpServer: (config) => config,
    query: (params) => {
      sdkCalls.push(params);
      const current = scenario;
      const generator = (async function* () {
        if (current === 'version-error') {
          params.options.stderr?.(`API Error: 400 {"error":{"type":"invalid_request_error","details":{"error_code":"claude_code_version_too_old"}}} ${secretText}`);
          throw new Error('Claude Code process exited with code 1');
        }
        params.options.stderr?.(`diagnostic ${secretText}`);
        if (params.options.includePartialMessages) {
          for (const event of [
            { type: 'message_start', message: { id: 'sdk-id', model: 'sdk-model', role: 'assistant', content: [] } },
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `reply ${secretText}` } },
            { type: 'content_block_stop', index: 0 },
            { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } },
            { type: 'message_stop' },
          ]) yield { type: 'stream_event', event };
        }
        const content = current === 'tools' ? [
          { type: 'tool_use', id: 'tool_a', name: 'mcp__proxy__read_code', input: { path: secretText } },
          { type: 'tool_use', id: 'tool_b', name: 'mcp__proxy__search_code', input: { query: '한글' } },
        ] : [{ type: 'text', text: `reply ${secretText}` }];
        yield { type: 'assistant', message: { content } };
        if (current === 'error') throw new Error(`rate_limit_error ${secretText}`);
        if (current === 'tools') {
          yield { type: 'user', message: { content: [] } };
          yield { type: 'assistant', message: { content: [{ type: 'text', text: 'sentinel second turn must be ignored' }] } };
        }
        yield { type: 'result', subtype: 'success', usage: { input_tokens: 11, output_tokens: 7 }, total_cost_usd: 0.01 };
      })();
      generator.interrupt = async () => {};
      return generator;
    },
  },
});

const { app } = await import('../dist/app.js');
const { db } = await import('../dist/db/connection.js');
const keys = await import('../dist/services/apiKeyService.js');
const history = await import('../dist/services/historyService.js');
const { trackedQuery } = await import('../dist/services/sdkBridge.js');
const { listTasks } = await import('../dist/services/taskTracker.js');
const settings = await import('../dist/services/settingsService.js');
const { logOperationalError } = await import('../dist/services/operationalLogger.js');
let server, base, backendKey;

before(async () => {
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  console.log(JSON.stringify({ pid: process.pid, ppid: process.ppid, cwd: process.cwd(), port: server.address().port, sdk: 'mock' }));
});
after(async () => {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  db.close();
});

async function request(path, body, headers = {}) {
  return fetch(base + path, {
    method: body ? 'POST' : 'GET',
    signal: AbortSignal.timeout(5000),
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
const auth = () => ({ Authorization: `Bearer ${backendKey.key}` });
const tools = [
  { type: 'function', function: { name: 'read_code', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'search_code', parameters: { type: 'object', properties: { query: { type: 'string' } } } } },
];
const chat = (extra = {}) => ({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: secretText }], ...extra });
const messages = (extra = {}) => ({ model: 'claude-sonnet-4-6', max_tokens: 100, messages: [{ role: 'user', content: secretText }], ...extra });

test('fresh database rejects both API formats without provisioning', async () => {
  for (const path of ['/v1/models', '/v1/messages', '/v1/chat/completions']) {
    const res = await request(path, path.endsWith('models') ? undefined : messages());
    assert.equal(res.status, 401);
    if (path.endsWith('messages')) assert.equal((await res.json()).type, 'error');
  }
  assert.equal(sdkCalls.length, 0);
});

test('admin bootstrap is authenticated; provisioned keys use either header', async () => {
  assert.equal((await request('/api/admin/keys', { name: 'backend' })).status, 401);
  const res = await request('/api/admin/keys', { name: 'backend' }, { Authorization: `Bearer ${process.env.ADMIN_API_SECRET}` });
  assert.equal(res.status, 201);
  backendKey = await res.json();
  keys.updateApiKey(backendKey.id, { rate_limit_rpm: 200 });
  assert.equal((await request('/v1/models', undefined, auth())).status, 200);
  assert.equal((await request('/v1/models', undefined, { 'x-api-key': backendKey.key })).status, 200);
  assert.equal((await request('/v1/models', undefined, { Authorization: 'Bearer invalid' })).status, 401);
});

test('plain chat disables built-ins and SDK session persistence', async () => {
  const res = await request('/v1/chat/completions', chat(), auth());
  assert.equal(res.status, 200);
  assert.equal((await res.json()).choices[0].message.content, `reply ${secretText}`);
  const options = sdkCalls.at(-1).options;
  assert.deepEqual(options.tools, []);
  assert.deepEqual(options.settingSources, []);
  assert.equal(options.persistSession, false);
});

test('plain Anthropic text is preserved without granting built-ins', async () => {
  const res = await request('/v1/messages', messages(), auth());
  assert.equal(res.status, 200);
  assert.equal((await res.json()).content[0].text, `reply ${secretText}`);
  assert.deepEqual(sdkCalls.at(-1).options.tools, []);
});

test('plain text SSE forwards deltas in both formats and closes', async () => {
  let res = await request('/v1/chat/completions', chat({ stream: true }), auth());
  assert.equal(res.status, 200);
  let body = await res.text();
  assert.match(body, /PRIVATE_SOURCE_AND_TOOL_ARGUMENT_SENTINEL/);
  assert.match(body, /\[DONE\]/);
  res = await request('/v1/messages', messages({ stream: true }), auth());
  body = await res.text();
  assert.match(body, /event: content_block_delta/);
  assert.match(body, /event: message_stop/);
  const start = body.split('\n').find((line) => line.startsWith('data: '));
  assert.match(JSON.parse(start.slice(6)).message.id, /^msg_/);
  assert.equal(JSON.parse(start.slice(6)).message.model, 'claude-sonnet-4-6');
});

test('server tools and built-in header are blocked even for an enabled key', async () => {
  keys.updateApiKeyBuiltinTools(backendKey.id, true);
  const beforeCalls = sdkCalls.length;
  for (const type of ['code_execution_20260209', 'web_search_20260209', 'text_editor_20260209', 'unknown_20260209']) {
    const res = await request('/v1/messages', messages({ tools: [{ type, name: type }] }), auth());
    assert.equal(res.status, 403);
  }
  const res = await request('/v1/messages', messages(), { ...auth(), 'x-enable-builtin-tools': 'true' });
  assert.equal(res.status, 403);
  assert.equal(sdkCalls.length, beforeCalls);
});

test('Anthropic requests are rate-counted once, not once per router', async () => {
  const limitedKey = keys.createApiKey('rate-count-test');
  keys.updateApiKey(limitedKey.id, { rate_limit_rpm: 2 });
  const headers = { Authorization: `Bearer ${limitedKey.key}` };
  const beforeCalls = sdkCalls.length;
  assert.equal((await request('/v1/messages', messages(), headers)).status, 200);
  assert.equal((await request('/v1/messages', messages(), headers)).status, 200);
  assert.equal((await request('/v1/messages', messages(), headers)).status, 429);
  assert.equal(sdkCalls.length - beforeCalls, 2);
});

test('SDK boundary itself refuses explicit built-ins', () => {
  assert.throws(() => trackedQuery({ completionId: 'blocked', builtInTools: ['Bash'] }), /disabled/);
});

test('parallel OpenAI caller tools retain names, IDs and arguments', async () => {
  scenario = 'tools';
  const res = await request('/v1/chat/completions', chat({ tools }), auth());
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.choices[0].finish_reason, 'tool_calls');
  const calls = data.choices[0].message.tool_calls;
  assert.deepEqual(calls.map((t) => [t.id, t.function.name]), [['tool_a', 'read_code'], ['tool_b', 'search_code']]);
  assert.equal(JSON.parse(calls[0].function.arguments).path, secretText);
  assert.equal(data.choices[0].message.content, null);
  scenario = 'text';
  const followup = chat({ tools, messages: [
    { role: 'user', content: 'read and search' }, data.choices[0].message,
    { role: 'tool', tool_call_id: 'tool_a', content: 'read result' },
    { role: 'tool', tool_call_id: 'tool_b', content: 'search result' },
  ] });
  assert.equal((await request('/v1/chat/completions', followup, auth())).status, 200);
  assert.match(sdkCalls.at(-1).prompt, /id=tool_a/);
  assert.match(sdkCalls.at(-1).prompt, /id=tool_b/);
});

test('Anthropic caller tools and follow-up results are accepted', async () => {
  scenario = 'tools';
  const anthTools = tools.map((t) => ({ name: t.function.name, input_schema: t.function.parameters }));
  const res = await request('/v1/messages', messages({ tools: anthTools }), auth());
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.stop_reason, 'tool_use');
  assert.deepEqual(data.content.map((b) => [b.id, b.name]), [['tool_a', 'read_code'], ['tool_b', 'search_code']]);
  scenario = 'text';
  const res2 = await request('/v1/messages', messages({ tools: anthTools, messages: [
    { role: 'user', content: 'read and search' },
    { role: 'assistant', content: data.content },
    { role: 'user', content: data.content.map((b) => ({ type: 'tool_result', tool_use_id: b.id, content: 'result' })) },
  ] }), auth());
  assert.equal(res2.status, 200);
  assert.match(sdkCalls.at(-1).prompt, /id=tool_a/);
});

test('buffered SSE has tool calls / Anthropic stop events', async () => {
  scenario = 'tools';
  let res = await request('/v1/chat/completions', chat({ tools, stream: true }), auth());
  assert.equal(res.status, 200);
  let sse = await res.text();
  assert.match(sse, /tool_calls/);
  assert.match(sse, /\[DONE\]/);
  res = await request('/v1/messages', messages({ stream: true, tools: tools.map((t) => ({ name: t.function.name, input_schema: t.function.parameters })) }), auth());
  sse = await res.text();
  assert.match(sse, /event: message_stop/);
  assert.match(sse, /"id":"tool_a"/);
  scenario = 'text';
});

test('upstream failure is classified without raw DB or console logs', async () => {
  scenario = 'error';
  const captured = [];
  const logger = mock.method(console, 'error', (...args) => captured.push(args));
  try {
    const res = await request('/v1/chat/completions', chat(), auth());
    assert.equal(res.status, 429);
    assert.equal((await res.json()).error.type, 'rate_limit_error');
    const log = db.prepare('SELECT * FROM request_log ORDER BY id DESC LIMIT 1').get();
    assert.equal(log.error_message, 'rate_limit_error');
    assert.ok(!JSON.stringify(log).includes(secretText));
    assert.ok(!JSON.stringify(captured).includes(secretText));
    logOperationalError('test_failure', Object.assign(new Error(secretText), { upstreamText: secretText }));
    assert.ok(!JSON.stringify(captured).includes(secretText));
  } finally { logger.mock.restore(); scenario = 'text'; }
});

test('outdated bundled CLI returns 400 in both formats without raw stored diagnostics', async () => {
  scenario = 'version-error';
  const captured = [];
  const logger = mock.method(console, 'error', (...args) => captured.push(args));
  try {
    for (const [path, body] of [['/v1/chat/completions', chat()], ['/v1/messages', messages()]]) {
      const res = await request(path, body, auth());
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.error.type, 'invalid_request_error');
      assert.match(data.error.message, /claude_code_version_too_old/);
      const row = db.prepare('SELECT * FROM request_log ORDER BY id DESC LIMIT 1').get();
      assert.equal(row.error_message, 'invalid_request_error');
      assert.ok(!JSON.stringify(row).includes(secretText));
    }
    assert.ok(!JSON.stringify(captured).includes(secretText));
    assert.deepEqual(listTasks(), []);
  } finally { logger.mock.restore(); scenario = 'text'; }
});

test('history storage boundary discards content even from legacy writers', () => {
  const id = history.insertPendingRequest({ apiKeyId: backendKey.id, completionId: 'legacy', requestedModel: 'sonnet', resolvedModel: 'sonnet', isStream: false, fullPrompt: secretText, promptPreview: secretText });
  history.completeRequest(id, 'error', { fullResponse: secretText, errorMessage: secretText });
  const row = history.getRequestDetail(id);
  assert.equal(row.full_prompt, null);
  assert.equal(row.full_response, null);
  assert.equal(row.prompt_preview, null);
  assert.equal(row.error_message, 'upstream_error');
  const allRows = db.prepare('SELECT * FROM request_log').all();
  assert.ok(!JSON.stringify(allRows).includes(secretText));
});

test('upstream SSE errors close both responses rather than hanging', async () => {
  scenario = 'error';
  const captured = [];
  const logger = mock.method(console, 'error', (...args) => captured.push(args));
  try {
    let res = await request('/v1/chat/completions', chat({ stream: true }), auth());
    let body = await res.text();
    assert.match(body, /"type":"rate_limit_error"/);
    assert.match(body, /\[DONE\]/);
    res = await request('/v1/messages', messages({ stream: true }), auth());
    body = await res.text();
    assert.match(body, /event: error/);
    assert.match(body, /rate_limit_error/);
    assert.ok(!JSON.stringify(captured).includes(secretText));
    assert.deepEqual(listTasks(), []);
  } finally { logger.mock.restore(); scenario = 'text'; }
});

test('active-task preview never contains prompt content', async () => {
  const { generator } = trackedQuery({ completionId: 'active-preview', prompt: secretText, requestedModel: 'sonnet', resolvedModel: 'sonnet', isStreaming: false, apiKeyId: backendKey.id, apiKeyName: 'backend' });
  assert.equal(listTasks()[0].prompt_preview, '');
  for await (const message of generator) { /* consume mocked SDK */ }
  assert.deepEqual(listTasks(), []);
});

test('credential storage and SDK environment mapping preserve auth only', async () => {
  settings.setSetting('claude_oauth_token', 'sk-ant-oat-synthetic-test-only');
  assert.equal(settings.getOAuthToken(), 'sk-ant-oat-synthetic-test-only');
  assert.equal(settings.getTokenStatus().source, 'database');
  for (const [token, expectedEnv, excludedEnv] of [
    ['sk-ant-oat-synthetic-test-only', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'],
    ['sk-ant-api-synthetic-test-only', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
  ]) {
    settings.setSetting('claude_oauth_token', token);
    const { generator } = trackedQuery({ completionId: expectedEnv, prompt: secretText, requestedModel: 'sonnet', resolvedModel: 'sonnet', isStreaming: false, apiKeyId: backendKey.id, apiKeyName: 'backend' });
    for await (const message of generator) { /* mocked SDK only */ }
    assert.equal(sdkCalls.at(-1).options.env[expectedEnv], token);
    assert.equal(sdkCalls.at(-1).options.env[excludedEnv], undefined);
    assert.ok(!JSON.stringify(db.prepare('SELECT * FROM request_log').all()).includes(token));
  }
  settings.deleteSetting('claude_oauth_token');
  assert.equal(settings.getOAuthToken(), null);
});

test('revoked backend key is denied', async () => {
  keys.revokeApiKey(backendKey.id);
  assert.equal((await request('/v1/models', undefined, auth())).status, 401);
});

test('environment OAuth token is forwarded; database override remains explicit', async () => {
  const envToken = 'sk-ant-oat-synthetic-environment-only';
  process.env.CLAUDE_CODE_OAUTH_TOKEN = envToken;
  try {
    assert.equal(settings.getOAuthToken(), envToken);
    assert.equal(settings.getTokenStatus().source, 'environment');
    const { generator } = trackedQuery({ completionId: 'env-auth-test', prompt: 'mock only', requestedModel: 'sonnet', resolvedModel: 'sonnet', isStreaming: false, apiKeyId: null, apiKeyName: null });
    for await (const message of generator) { /* mocked SDK only */ }
    assert.equal(sdkCalls.at(-1).options.env.CLAUDE_CODE_OAUTH_TOKEN, envToken);
    assert.equal(settings.getSetting('claude_oauth_token'), null);
    settings.setSetting('claude_oauth_token', 'sk-ant-oat-synthetic-db-override');
    assert.equal(settings.getOAuthToken(), 'sk-ant-oat-synthetic-db-override');
    settings.deleteSetting('claude_oauth_token');
    assert.equal(settings.getOAuthToken(), envToken);
  } finally {
    settings.deleteSetting('claude_oauth_token');
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  }
});
