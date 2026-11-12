import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import { prepareResponsesRequest } from '../dist/services/responsesRequest.js';
import { ResponsesError } from '../dist/services/responsesTypes.js';
import { ResponsesStateCodec } from '../dist/services/responsesState.js';
import { convertNativeMessage } from '../dist/services/responsesStream.js';

// These are the documented exact IDs, not a family/prefix matcher. Unrecognized
// dates, aliases and later versions must keep the conservative legacy contract.
const modernModels = [
  'claude-fable-5-2', 'claude-fable-5-1', 'claude-fable-5',
  'claude-mythos-5-2', 'claude-mythos-5-1', 'claude-mythos-5',
  'claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7',
  'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-haiku-5-5',
];
const adaptiveOptInModels = ['claude-opus-4-6', 'claude-sonnet-4-6'];
const knownModels = [...modernModels, ...adaptiveOptInModels];
const legacyModels = [
  'claude-haiku-4-5', 'claude-haiku-4-5-20251001', 'synthetic-future-model',
  'claude-fable-5-2-20990101', 'claude-fable-5-20', 'claude-fable-5-3',
  'provider/claude-fable-5-2', 'CLAUDE-FABLE-5-2', 'claude-opus-4-6-20990101',
];
const alwaysOnModels = [
  'claude-fable-5-2', 'claude-fable-5-1', 'claude-fable-5',
  'claude-mythos-5-2', 'claude-mythos-5-1', 'claude-mythos-5',
  'claude-opus-5-5', 'claude-sonnet-5-5',
];
const disableCapableModels = [
  'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6',
  'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-haiku-5-5',
];
const efforts = ['low', 'medium', 'high', 'xhigh', 'max'];
const codec = new ResponsesStateCodec(randomBytes(32).toString('base64'), 600);
const contextFor = model => ({ model, principal: 'new-model-fixture', upstream: 'synthetic-loopback-upstream' });
const optionsFor = (model, overrides = {}) => ({
  codec, context: contextFor(model), defaultMaxTokens: 8192, defaultThinkingBudget: 1024, ...overrides,
});
const prepare = (model, extra = {}, overrides = {}) => prepareResponsesRequest(
  { model, input: 'Synthetic new-model request 한글🙂', store: false, ...extra }, optionsFor(model, overrides),
);
const fn = { type: 'function', name: 'local_lookup', strict: false, parameters: { type: 'object', properties: {} } };
function unsupported(model, extra, messagePattern = /thinking|effort|adaptive|budget|tool/i) {
  assert.throws(() => prepare(model, extra), error => error instanceof ResponsesError &&
    error.status === 400 && error.code === 'unsupported_parameter' && messagePattern.test(error.message), model);
}
function outsideOutputLimit(model, extra = {}) {
  assert.throws(() => prepare(model, { max_output_tokens: 128001, ...extra }), error =>
    error instanceof ResponsesError && error.status === 400, model);
}

test('exact modern IDs default to adaptive thinking independently of the legacy budget', () => {
  for (const model of modernModels) {
    for (const defaultThinkingBudget of [0, 1024, 65535]) {
      const native = prepare(model, { max_output_tokens: 16 }, { defaultThinkingBudget }).nativeBody;
      assert.equal(native.model, model);
      assert.equal(native.max_tokens, 16);
      assert.deepEqual(native.thinking, { type: 'adaptive' }, model);
      assert.equal(Object.hasOwn(native.thinking, 'budget_tokens'), false);
    }
    assert.deepEqual(prepare(model).nativeBody.thinking, { type: 'adaptive' }, model);
  }
});

test('modern effort labels map exactly without redundant native options or changing the caller object', () => {
  for (const model of modernModels) {
    for (const effort of efforts) {
      const request = { model, input: 'Fixture', reasoning: { effort, summary: 'auto' }, store: false };
      const snapshot = structuredClone(request);
      const native = prepareResponsesRequest(request, optionsFor(model)).nativeBody;
      assert.deepEqual(native.thinking, { type: 'adaptive' }, `${model}/${effort}`);
      assert.deepEqual(native.output_config, { effort }, `${model}/${effort}`);
      assert.deepEqual(request, snapshot);
      const explicit = prepare(model, { reasoning: { effort }, anthropic: {
        thinking: { type: 'adaptive' }, output_config: { effort },
      } }).nativeBody;
      assert.deepEqual(explicit.thinking, native.thinking);
      assert.deepEqual(explicit.output_config, native.output_config);
    }
    unsupported(model, { reasoning: { effort: 'high' }, anthropic: { output_config: { effort: 'low' } } });
    unsupported(model, { reasoning: { effort: 'xhigh' }, anthropic: {
      thinking: { type: 'adaptive' }, output_config: { effort: 'max' },
    } });
    unsupported(model, { reasoning: { effort: 'unsupported-future-effort' } });
  }
});

test('known models accept the verified 128000 output boundary without raising unknown-model limits', () => {
  for (const model of knownModels) {
    assert.equal(prepare(model, { max_output_tokens: 128000 }).nativeBody.max_tokens, 128000, model);
    assert.equal(prepare(model, {}, { defaultMaxTokens: 128000 }).nativeBody.max_tokens, 128000, model);
    outsideOutputLimit(model);
  }
  for (const model of legacyModels) {
    assert.equal(prepare(model, { max_output_tokens: 65536 }).nativeBody.max_tokens, 65536, model);
    outsideOutputLimit(model, { max_output_tokens: 65537 });
    assert.throws(() => prepare(model, {}, { defaultMaxTokens: 128000 }), ResponsesError, model);
  }
});

test('4.6 models retain manual defaults and accept only their explicit adaptive effort vocabulary', () => {
  for (const model of adaptiveOptInModels) {
    assert.deepEqual(prepare(model).nativeBody.thinking, { type: 'enabled', budget_tokens: 1024 }, model);
    assert.deepEqual(prepare(model, { anthropic: { thinking: { type: 'enabled', budget_tokens: 2048 } } })
      .nativeBody.thinking, { type: 'enabled', budget_tokens: 2048 });
    for (const effort of ['low', 'medium', 'high', 'max']) {
      const native = prepare(model, { reasoning: { effort } }).nativeBody;
      assert.deepEqual(native.thinking, { type: 'adaptive' });
      assert.deepEqual(native.output_config, { effort });
    }
    unsupported(model, { reasoning: { effort: 'xhigh' } });
    unsupported(model, { anthropic: { thinking: { type: 'adaptive' }, output_config: { effort: 'xhigh' } } });
  }
});

test('legacy, unknown, dated and lookalike IDs keep bounded manual thinking and explicit effort requirements', () => {
  for (const model of legacyModels) {
    assert.deepEqual(prepare(model).nativeBody.thinking, { type: 'enabled', budget_tokens: 1024 }, model);
    assert.equal(prepare(model, {}, { defaultThinkingBudget: 0 }).nativeBody.thinking, undefined, model);
    assert.equal(prepare(model, { reasoning: { effort: 'none' } }).nativeBody.thinking, undefined, model);
    unsupported(model, { reasoning: { effort: 'high' } });
    const native = prepare(model, { reasoning: { effort: 'high' }, anthropic: {
      thinking: { type: 'adaptive' }, output_config: { effort: 'high' },
    } }).nativeBody;
    assert.deepEqual(native.thinking, { type: 'adaptive' });
    assert.deepEqual(native.output_config, { effort: 'high' });
    unsupported(model, { reasoning: { effort: 'xhigh' }, anthropic: {
      thinking: { type: 'adaptive' }, output_config: { effort: 'max' },
    } });
  }
});

test('modern models reject manual budgets with an actionable policy error', () => {
  for (const model of modernModels) {
    unsupported(model, { anthropic: { thinking: { type: 'enabled', budget_tokens: 2048 } } },
      /adaptive|budget|enabled|manual/i);
    assert.throws(() => prepare(model, { anthropic: { thinking: { type: 'adaptive', budget_tokens: 2048 } } }),
      { code: 'unsupported_parameter', status: 400 });
  }
});

test('known adaptive display values include updates while unknown display and binding controls remain rejected', () => {
  for (const model of knownModels) {
    for (const display of ['summarized', 'omitted', 'updates']) {
      const native = prepare(model, { anthropic: { thinking: { type: 'adaptive', display } } }).nativeBody;
      assert.deepEqual(native.thinking, { type: 'adaptive', display });
    }
    for (const thinking of [
      { type: 'adaptive', display: 'unknown-display' }, { type: 'adaptive', block_binding: 'none' },
    ]) assert.throws(() => prepare(model, { anthropic: { thinking } }), { code: 'unsupported_parameter', status: 400 });
  }
  assert.throws(() => prepare('synthetic-future-model', {
    anthropic: { thinking: { type: 'adaptive', display: 'omitted' } },
  }), { code: 'unsupported_parameter', status: 400 });
});

test('always-on policies reject none and disabled instead of silently weakening thinking', () => {
  for (const model of alwaysOnModels) {
    unsupported(model, { reasoning: { effort: 'none' } }, /thinking|disabled|always|none|low/i);
    unsupported(model, { anthropic: { thinking: { type: 'disabled' } } }, /thinking|disabled|always|adaptive/i);
  }
});

test('known disable-capable models emit the actual disabled policy and enforce effort ceilings', () => {
  for (const model of disableCapableModels) {
    assert.deepEqual(prepare(model, { reasoning: { effort: 'none' } }).nativeBody.thinking, { type: 'disabled' }, model);
    assert.deepEqual(prepare(model, { anthropic: { thinking: { type: 'disabled' } } }).nativeBody.thinking,
      { type: 'disabled' }, model);
  }
  for (const model of ['claude-opus-5', 'claude-haiku-5-5']) {
    for (const effort of ['low', 'medium', 'high']) {
      const native = prepare(model, { reasoning: { effort }, anthropic: { thinking: { type: 'disabled' } } }).nativeBody;
      assert.deepEqual(native.thinking, { type: 'disabled' });
      assert.deepEqual(native.output_config, { effort });
    }
    for (const effort of ['xhigh', 'max']) {
      unsupported(model, { reasoning: { effort }, anthropic: { thinking: { type: 'disabled' } } });
      unsupported(model, { anthropic: { thinking: { type: 'disabled' }, output_config: { effort } } });
    }
  }
});

test('Sonnet 5.5 between_tools is literal, bounded through high, and never becomes disabled', () => {
  const model = 'claude-sonnet-5-5';
  assert.deepEqual(prepare(model, { anthropic: { thinking: { type: 'between_tools' } } }).nativeBody.thinking,
    { type: 'between_tools' });
  for (const effort of ['low', 'medium', 'high']) {
    const native = prepare(model, { reasoning: { effort }, anthropic: { thinking: { type: 'between_tools' } } }).nativeBody;
    assert.deepEqual(native.thinking, { type: 'between_tools' });
    assert.deepEqual(native.output_config, { effort });
  }
  for (const effort of ['xhigh', 'max']) {
    unsupported(model, { reasoning: { effort }, anthropic: { thinking: { type: 'between_tools' } } });
    unsupported(model, { anthropic: { thinking: { type: 'between_tools' }, output_config: { effort } } });
  }
  unsupported('claude-fable-5-2', { anthropic: { thinking: { type: 'between_tools' } } });
  unsupported('claude-haiku-5-5', { anthropic: { thinking: { type: 'between_tools' } } });
});

test('forced tool choice follows each known adaptive policy and keeps conservative fallback guards', () => {
  const allowed = [
    'claude-fable-5', 'claude-mythos-5', 'claude-opus-5', 'claude-opus-4-8',
    'claude-opus-4-7', 'claude-sonnet-5', 'claude-haiku-5-5',
  ];
  for (const model of [...allowed, ...adaptiveOptInModels]) {
    for (const [choice, expected] of [
      ['required', { type: 'any', disable_parallel_tool_use: true }],
      [{ type: 'function', name: fn.name }, { type: 'tool', name: fn.name, disable_parallel_tool_use: true }],
    ]) {
      const native = prepare(model, { tools: [fn], tool_choice: choice, parallel_tool_calls: false,
        ...(adaptiveOptInModels.includes(model) ? { anthropic: { thinking: { type: 'adaptive' } } } : {}),
      }).nativeBody;
      assert.deepEqual(native.tool_choice, expected, model);
      assert.deepEqual(native.thinking, { type: 'adaptive' });
    }
  }
  for (const model of [
    'claude-fable-5-2', 'claude-fable-5-1', 'claude-mythos-5-2', 'claude-mythos-5-1',
    'claude-opus-5-5', 'claude-sonnet-5-5', ...adaptiveOptInModels, 'synthetic-future-model',
  ]) unsupported(model, { tools: [fn], tool_choice: 'required' });
  unsupported('claude-sonnet-5-5', { tools: [fn], tool_choice: 'required',
    anthropic: { thinking: { type: 'between_tools' } } });
  unsupported('synthetic-future-model', { tools: [fn], tool_choice: 'required',
    anthropic: { thinking: { type: 'adaptive' } } });
});

test('modern reasoning conversion and ID-less capsule replay preserve exact ordered native blocks', () => {
  const blocks = [
    { type: 'thinking', thinking: 'Synthetic signed reasoning 한글🙂', signature: 'exact-signature+/=',
      cache_control: { type: 'ephemeral', ttl: '1h' }, future_signed_extension: { keep: true } },
    { type: 'thinking', thinking: '', signature: 'exact-signed-empty+/=' },
    { type: 'redacted_thinking', data: 'exact-redacted+/=' },
    { type: 'text', text: 'Visible answer' },
  ];
  for (const model of modernModels) {
    const first = prepare(model);
    const native = { id: 'msg_new_model', type: 'message', role: 'assistant', model,
      content: blocks, stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 2, output_tokens: 3 } };
    const response = convertNativeMessage(native, { model, tools: first.tools,
      seal: (block, id) => codec.seal(block, first.stateContext, id) });
    const items = response.output.map(item => {
      const copy = structuredClone(item);
      if (copy.type === 'reasoning') delete copy.id;
      return copy;
    });
    const snapshot = structuredClone(items);
    const replay = prepare(model, { reasoning: { effort: 'xhigh' }, input: [
      { role: 'user', content: 'Start' }, ...items, { role: 'user', content: 'Continue' },
    ] });
    assert.deepEqual(replay.nativeBody.messages[1], { role: 'assistant', content: blocks }, model);
    assert.deepEqual(replay.nativeBody.thinking, { type: 'adaptive' });
    assert.deepEqual(items, snapshot);
    assert.equal(JSON.stringify(response.output).includes('exact-signature'), false);
  }
});

test('startup accepts the global 128000 ceiling while retaining the 65535 manual-budget ceiling', () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    ['SYSTEMROOT', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP'].includes(name.toUpperCase())));
  const configUrl = new URL('../dist/config.js', import.meta.url).href;
  const code = `import {RESPONSES_MAX_OUTPUT_TOKENS,RESPONSES_THINKING_BUDGET_TOKENS} from ${JSON.stringify(configUrl)}; console.log(JSON.stringify([RESPONSES_MAX_OUTPUT_TOKENS,RESPONSES_THINKING_BUDGET_TOKENS]));`;
  for (const [output, budget, valid] of [
    ['128000', '65535', true], ['128001', '1024', false], ['128000', '65536', false], ['8192', '8192', false],
  ]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      env: { ...env, DATABASE_PATH: ':memory:', RESPONSES_ENABLED: 'true',
        RESPONSES_MAX_OUTPUT_TOKENS: output, RESPONSES_THINKING_BUDGET_TOKENS: budget },
      encoding: 'utf8', timeout: 5000, windowsHide: true,
    });
    assert.ifError(result.error);
    if (valid) {
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout.trim()), [128000, 65535]);
    } else {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /supported integer range|thinking budget/i);
    }
  }
});

// Every HTTP request terminates at this synthetic loopback upstream. These
// fixtures establish adapter behavior, not real provider/model entitlement.
process.env.DATABASE_PATH = ':memory:';
process.env.AUTH_DISABLED = 'false';
process.env.ADMIN_API_SECRET = randomBytes(24).toString('hex');
process.env.UPSTREAM_AUTH_SOURCE = 'configured';
process.env.CLAUDE_AUTH_AUTO_REFRESH = 'false';
process.env.ANTHROPIC_API_KEY = 'sk-ant-api-new-models-synthetic-only';
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
process.env.RESPONSES_ENABLED = 'true';
process.env.RESPONSES_STATE_KEY = randomBytes(32).toString('base64');
process.env.RESPONSES_MAX_OUTPUT_TOKENS = '8192';
process.env.RESPONSES_THINKING_BUDGET_TOKENS = '1024';
process.env.RESPONSES_APPLY_PATCH_MODE = 'reject';
process.env.RESPONSES_DEVELOPER_MESSAGE_MODE = 'reject';
const received = [];
const updatesBeta = 'thinking-display-updates-2026-08-18';
const updatesBlocks = [
  { type: 'thinking', thinking: '', signature: 'synthetic-signed-empty-update-state' },
  { type: 'thinking', thinking: 'Synthetic progress update', signature: 'synthetic-signed-progress-state' },
  { type: 'text', text: 'Synthetic local result' },
];
const catalog = Buffer.from(` \n${JSON.stringify({ data: [...knownModels, 'claude-fable-6-unknown'].map(id =>
  ({ id, type: 'model', display_name: id, future_model_metadata: { untouched: true } })),
  has_more: true, first_id: knownModels[0], last_id: 'claude-fable-6-unknown', future_catalog_field: '한글🙂' }, null, 2)}\n`);
const upstream = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const bytes = Buffer.concat(chunks);
  const body = bytes.length ? JSON.parse(bytes.toString('utf8')) : undefined;
  received.push({ method: req.method, url: req.url, headers: req.headers, bytes, body });
  res.setHeader('content-type', 'application/json');
  if (req.url.startsWith('/v1/models')) return res.end(catalog);
  if (body?.thinking?.display === 'updates' && !String(req.headers['anthropic-beta']).split(',').map(s => s.trim()).includes(updatesBeta)) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error',
      message: 'thinking.adaptive.display requires the updates feature beta' } }));
  }
  if (req.url.startsWith('/v1/messages/count_tokens')) return res.end('{"input_tokens":7,"future_count":true}\n');
  res.end(JSON.stringify({ id: 'msg_synthetic_new_model', type: 'message', role: 'assistant', model: body.model,
    content: body?.thinking?.display === 'updates' ? updatesBlocks : [{ type: 'text', text: 'Synthetic local result' }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 2, output_tokens: 3 } }));
});
upstream.listen(0, '127.0.0.1');
await once(upstream, 'listening');
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${upstream.address().port}/v1/`;
let app;
try {
  ({ app } = await import('../dist/app.js'));
} catch (error) {
  // A startup error (for example a mismatched native Node ABI) must not leave
  // this local fixture listening and hide the original error behind a hang.
  upstream.closeAllConnections();
  await new Promise(resolve => upstream.close(resolve));
  throw error;
}
const { db } = await import('../dist/db/connection.js');
const keys = await import('../dist/services/apiKeyService.js');
const key = keys.createApiKey('new-models-loopback-fixture');
keys.updateApiKey(key.id, { rate_limit_rpm: 200 });
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
function request(path, payload, extraHeaders = {}) {
  const bytes = payload === undefined ? undefined : Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    const req = http.request(base + path, { method: bytes ? 'POST' : 'GET', headers: {
      authorization: `Bearer ${key.key}`,
      ...(bytes ? { 'content-type': 'application/json', 'content-length': bytes.length } : {}),
      ...extraHeaders,
    } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('Synthetic loopback deadline')));
    req.end(bytes);
  });
}
after(async () => {
  for (const instance of [server, upstream]) {
    instance.closeAllConnections();
    await new Promise((resolve, reject) => instance.close(error => error ? reject(error) : resolve()));
  }
  db.close();
});

test('native model catalog preserves modern/unknown IDs, metadata, pagination and exact bytes', async () => {
  const path = '/v1/models?limit=2&after_id=claude-fable-5-2';
  const before = received.length;
  const response = await request(path);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, catalog);
  assert.equal(received.length, before + 1);
  assert.equal(received.at(-1).url, path);
  assert.equal(received.at(-1).method, 'GET');
});

test('native Messages and count_tokens preserve modern and unknown model requests without policy rewriting', async () => {
  for (const model of ['claude-fable-5-2', 'claude-sonnet-5-5', 'claude-fable-6-unknown']) {
    const body = { model, max_tokens: 128000, messages: [{ role: 'user', content: 'Synthetic 한글🙂' }],
      thinking: { type: 'adaptive', future_thinking_field: 'native-only' }, output_config: { effort: 'max', future_effort: true },
      future_model_option: { keep: true } };
    const raw = Buffer.from(` \n${JSON.stringify(body, null, 2)}\n`);
    for (const path of ['/v1/messages', '/v1/messages/count_tokens']) {
      const before = received.length;
      const response = await request(path, raw);
      assert.equal(response.status, 200);
      assert.equal(received.length, before + 1);
      assert.equal(received.at(-1).url, path);
      assert.deepEqual(received.at(-1).bytes, raw, model);
      assert.equal(received.at(-1).headers.authorization, undefined);
      assert.equal(received.at(-1).headers['x-api-key'], process.env.ANTHROPIC_API_KEY);
    }
  }
});

test('HTTP Responses selects modern adaptive policy and rejects forbidden disabling before provider contact', async () => {
  const model = 'claude-fable-5-2';
  const before = received.length;
  const response = await request('/v1/responses', { model, input: 'Synthetic seed', store: false,
    max_output_tokens: 128000, reasoning: { effort: 'xhigh' } });
  assert.equal(response.status, 200, response.body.toString());
  assert.equal(JSON.parse(response.body).status, 'completed');
  assert.equal(received.length, before + 1);
  const native = received.at(-1).body;
  assert.equal(native.model, model);
  assert.equal(native.max_tokens, 128000);
  assert.deepEqual(native.thinking, { type: 'adaptive' });
  assert.deepEqual(native.output_config, { effort: 'xhigh' });
  for (const extra of [{ reasoning: { effort: 'none' } },
    { anthropic: { thinking: { type: 'enabled', budget_tokens: 2048 } } }]) {
    const failed = await request('/v1/responses', { model, input: 'Synthetic seed', store: false, ...extra });
    assert.equal(failed.status, 400);
    assert.equal(JSON.parse(failed.body).error.code, 'unsupported_parameter');
    assert.equal(received.length, before + 1);
  }
});

test('native updates supplies the required public beta with API-key auth and preserves raw system/history bytes', async () => {
  for (const thinking of [{ type: 'adaptive', display: 'updates' },
    { type: 'enabled', budget_tokens: 1024, display: 'updates' }]) {
    const body = { model: thinking.type === 'adaptive' ? 'claude-fable-5-2' : 'claude-haiku-4-5-20251001',
      max_tokens: 2048, thinking, system: [{ type: 'text', text: 'Caller system 한글🙂', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: 'Synthetic seed' }] };
    const raw = Buffer.from(` \n${JSON.stringify(body, null, 2)}\n`);
    const before = received.length;
    const response = await request('/v1/messages', raw);
    assert.equal(response.status, 200, response.body.toString());
    assert.equal(received.length, before + 1);
    const call = received.at(-1);
    assert.deepEqual(call.bytes, raw);
    assert.deepEqual(call.body.system, body.system);
    assert.deepEqual(call.body.thinking, thinking);
    assert.equal(call.headers['anthropic-beta'], updatesBeta);
    assert.equal(call.headers.authorization, undefined);
    assert.equal(call.headers['x-api-key'], process.env.ANTHROPIC_API_KEY);
  }
});

test('Responses updates works from body or native-options header and replays empty/progress signatures unchanged', async () => {
  const extension = { thinking: { type: 'adaptive', display: 'updates' } };
  const instructions = 'Caller instructions stay in their original order. 한글🙂';
  for (const source of ['body', 'header']) {
    const extra = source === 'body' ? { anthropic: extension } : {};
    const headers = source === 'header' ? { 'x-claude-proxy-native-options': JSON.stringify(extension) } : {};
    const body = { model: 'claude-fable-5-2', input: 'Synthetic seed', instructions, store: false,
      max_output_tokens: 1024, ...extra };
    const snapshot = structuredClone(body);
    const before = received.length;
    const first = await request('/v1/responses', body, headers);
    assert.equal(first.status, 200, first.body.toString());
    assert.equal(received.length, before + 1);
    const call = received.at(-1);
    assert.deepEqual(call.body.thinking, extension.thinking);
    assert.deepEqual(call.body.system, [{ type: 'text', text: instructions }]);
    assert.equal(call.headers['anthropic-beta'], updatesBeta);
    assert.equal(call.headers['x-claude-proxy-native-options'], undefined);
    assert.deepEqual(body, snapshot);
    const response = JSON.parse(first.body);
    assert.equal(response.status, 'completed');
    const reasoning = response.output.filter(item => item.type === 'reasoning');
    assert.equal(reasoning.length, 2);
    assert.ok(reasoning.every(item => typeof item.encrypted_content === 'string'));
    assert.ok(!JSON.stringify(response).includes('synthetic-signed-'));
    const replay = await request('/v1/responses', { ...body, input: [
      { role: 'user', content: 'Synthetic seed' }, ...response.output,
      { role: 'user', content: 'Continue the synthetic fixture' },
    ] }, headers);
    assert.equal(replay.status, 200, replay.body.toString());
    assert.equal(received.length, before + 2);
    assert.deepEqual(received.at(-1).body.messages[1], { role: 'assistant', content: updatesBlocks });
    assert.deepEqual(received.at(-1).body.system, call.body.system);
    assert.equal(received.at(-1).headers['anthropic-beta'], updatesBeta);
  }
});

test('feature beta merging retains caller flags without duplicates or enabling updates on other policies', async () => {
  for (const display of ['updates', 'summarized', 'omitted', undefined]) {
    const provided = display === 'updates' ? `future-beta-2099-01-01, ${updatesBeta}` : 'future-beta-2099-01-01';
    const response = await request('/v1/messages', { model: 'claude-fable-5-2', max_tokens: 1024,
      messages: [{ role: 'user', content: 'Synthetic seed' }], thinking: { type: 'adaptive', ...(display ? { display } : {}) } },
      { 'anthropic-beta': provided });
    assert.equal(response.status, 200, response.body.toString());
    const betas = received.at(-1).headers['anthropic-beta'].split(',').map(s => s.trim());
    assert.ok(betas.includes('future-beta-2099-01-01'));
    assert.equal(betas.filter(beta => beta === updatesBeta).length, display === 'updates' ? 1 : 0);
    assert.ok(!betas.some(beta => beta.startsWith('claude-code-')));
  }
});
