import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  AsyncQueue, BROKER_ID, NativeEventTransformer, ToolBroker,
  createToolRegistry, embedInputSchema, nativeThinkingToSdk, sdkEnvironment, toMcpResult,
} from './helpers.mjs';
import { CliWorker, createCallerMcpServer } from './worker.mjs';

const tool = {
  name: 'caller.read_file', description: 'Read a remote file.',
  input_schema: {
    type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false,
  },
};
const makeRegistry = () => createToolRegistry([tool]);
const turn = () => new Promise(resolve => setImmediate(resolve));

test('embedding relocates schema JSON pointers without changing data or separate $id resources', () => {
  const original = {
    type: 'object',
    $defs: { node: { anyOf: [{ type: 'null' }, { $ref: '#' }] } },
    properties: {
      value: { $ref: '#/$defs/node' },
      external: { $id: 'https://example.invalid/schema', $defs: { own: { type: 'string' } }, $ref: '#/$defs/own' },
    },
    default: { $ref: '#/literal-data' }, examples: [{ $ref: '#/also-data' }],
  };
  const before = structuredClone(original);
  const embedded = embedInputSchema(original);
  assert.equal(embedded.properties.input.properties.value.$ref, '#/properties/input/$defs/node');
  assert.equal(embedded.properties.input.$defs.node.anyOf[1].$ref, '#/properties/input');
  assert.equal(embedded.properties.input.properties.external.$ref, '#/$defs/own');
  assert.deepEqual(embedded.properties.input.default, original.default);
  assert.deepEqual(embedded.properties.input.examples, original.examples);
  assert.deepEqual(original, before);
  assert.equal(embedded.additionalProperties, true);
});

test('native events preserve opaque thinking/signatures and unwrap only buffered tool JSON', () => {
  const registry = makeRegistry();
  const entry = registry.byOriginal.get(tool.name);
  const broker = new ToolBroker(registry, () => {}, error => { throw error; });
  const transformer = new NativeEventTransformer(registry, broker);
  const thinking = { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'opaque+signature' }, future: true };
  assert.equal(transformer.transform(thinking)[0], thinking);
  const start = { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'native_id', name: entry.native, input: {} } };
  assert.deepEqual(transformer.transform(start), [{ ...start, content_block: { ...start.content_block, name: tool.name } }]);
  assert.deepEqual(transformer.transform({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"input":{"path":' } }), []);
  assert.deepEqual(transformer.transform({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"café/文件"}}' } }), []);
  const stop = { type: 'content_block_stop', index: 2 };
  assert.deepEqual(transformer.transform(stop), [
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":"café/文件"}' } }, stop,
  ]);
  broker.deliver({ tool_use_id: 'native_id', content: 'remote result' });
  const hook = broker.preToolUse({ tool_name: entry.native, tool_use_id: 'native_id', tool_input: { input: { path: 'café/文件' } } });
  assert.equal(hook.hookSpecificOutput.updatedInput[BROKER_ID], 'native_id');
  assert.deepEqual(hook.hookSpecificOutput.updatedInput.input, { path: 'café/文件' });
  broker.close();
});

test('identical concurrent calls are fulfilled by exact ID and preserve real MCP isError', async () => {
  const registry = makeRegistry();
  const entry = registry.byOriginal.get(tool.name);
  const emitted = [];
  let broker;
  broker = new ToolBroker(registry, message => emitted.push(message), () => broker.close());
  const a = broker.preToolUse({ tool_name: entry.native, tool_use_id: 'a', tool_input: { input: { path: 'same' } } }).hookSpecificOutput.updatedInput;
  const b = broker.preToolUse({ tool_name: entry.native, tool_use_id: 'b', tool_input: { input: { path: 'same' } } }).hookSpecificOutput.updatedInput;
  const resultA = broker.call(entry.local, a);
  const resultB = broker.call(entry.local, b);
  broker.deliver({ tool_use_id: 'b', content: 'error from b', is_error: true });
  broker.deliver({ tool_use_id: 'a', content: 'success from a', is_error: false });
  assert.deepEqual(await resultA, { content: [{ type: 'text', text: 'success from a' }], isError: false });
  assert.deepEqual(await resultB, { content: [{ type: 'text', text: 'error from b' }], isError: true });
  assert.deepEqual(emitted.map(message => message.tool_use_id), ['a', 'b']);
  assert.throws(() => broker.deliver({ tool_use_id: 'b', content: 'duplicate' }), { code: 'unknown_tool_result' });
  assert.throws(() => broker.deliver({ tool_use_id: 'unknown', content: 'unmatched' }), { code: 'unknown_tool_result' });
  broker.close();
});

test('real low-level MCP transport preserves schema and caller errors without invoking tools locally', async () => {
  const registry = makeRegistry();
  const entry = registry.byOriginal.get(tool.name);
  const broker = new ToolBroker(registry, () => {}, () => broker.close());
  const server = createCallerMcpServer(registry, broker);
  const client = new Client({ name: 'local-protocol-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const listed = await client.listTools();
    assert.deepEqual(listed.tools[0].inputSchema.properties.input, tool.input_schema);
    assert.equal(listed.tools[0]._meta['anthropic/maxResultSizeChars'], 500000);
    const args = broker.preToolUse({ tool_name: entry.native, tool_use_id: 'mcp_id', tool_input: { input: { path: 'remote' } } }).hookSpecificOutput.updatedInput;
    const pending = client.callTool({ name: entry.local, arguments: args });
    await turn();
    broker.deliver({ tool_use_id: 'mcp_id', content: [{ type: 'text', text: 'caller failure' }], is_error: true });
    const result = await pending;
    assert.equal(result.isError, true);
    assert.deepEqual(result.content, [{ type: 'text', text: 'caller failure' }]);
  } finally { broker.close(); await client.close(); await server.close(); }
});

test('unsupported tool content is explicit and native base64 images map without a text placeholder', () => {
  assert.deepEqual(toMcpResult([{ type: 'image', source: { type: 'base64', data: 'aGVsbG8=', media_type: 'image/png' } }]), {
    content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }], isError: false,
  });
  assert.throws(() => toMcpResult([{ type: 'document', source: { type: 'text', data: 'document' } }]), { code: 'unsupported_tool_result' });
  assert.throws(() => toMcpResult([{ type: 'text', text: 'data', opaque: true }]), { code: 'unsupported_tool_result' });
});

test('worker auth environment is replaced, not merged; store mode reads no token overrides', () => {
  const base = { configDir: '/isolated', upstream: 'http://127.0.0.1:1234', maxTokens: 4096, credential: { kind: 'api_key', token: 'test-only-placeholder' } };
  const inherited = { PATH: '/bin', ANTHROPIC_API_KEY: 'must-not-inherit', ANTHROPIC_AUTH_TOKEN: 'must-not-inherit', CLAUDE_CODE_OAUTH_TOKEN: 'must-not-inherit', DEBUG: 'must-not-inherit', CLAUDE_CONFIG_DIR: '/old' };
  const api = sdkEnvironment(base, inherited);
  assert.equal(api.ANTHROPIC_API_KEY, base.credential.token);
  assert.equal(api.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(api.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(api.DEBUG, undefined);
  assert.equal(api.CLAUDE_CONFIG_DIR, '/isolated');
  assert.equal(api.CLAUDE_CODE_MAX_RETRIES, '0');
  const oauth = sdkEnvironment({ ...base, credential: { kind: 'oauth', token: 'oauth-placeholder' } }, inherited);
  assert.equal(oauth.ANTHROPIC_API_KEY, undefined);
  assert.equal(oauth.CLAUDE_CODE_OAUTH_TOKEN, 'oauth-placeholder');
  const store = sdkEnvironment({ ...base, authMode: 'cli_store' }, inherited);
  assert.equal(store.ANTHROPIC_API_KEY, undefined);
  assert.equal(store.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(store.ANTHROPIC_AUTH_TOKEN, undefined);
  const proxy = sdkEnvironment({ ...base, authMode: 'proxy', credential: { token: 'internal-session-nonce' } }, inherited);
  assert.equal(proxy.ANTHROPIC_AUTH_TOKEN, 'internal-session-nonce');
  assert.equal(proxy.ANTHROPIC_API_KEY, undefined);
  assert.equal(proxy.CLAUDE_CODE_OAUTH_TOKEN, undefined);
});

test('thinking maps the documented native budget only and rejects unsupported updates display', () => {
  assert.deepEqual(nativeThinkingToSdk({ type: 'enabled', budget_tokens: 2048, display: 'omitted' }), { type: 'enabled', budgetTokens: 2048, display: 'omitted' });
  assert.deepEqual(nativeThinkingToSdk({ type: 'adaptive' }), { type: 'adaptive' });
  assert.throws(() => nativeThinkingToSdk({ type: 'adaptive', display: 'updates' }), { code: 'unsupported_options' });
  assert.throws(() => nativeThinkingToSdk({ type: 'disabled', budget_tokens: 1 }), { code: 'unsupported_options' });
});

function fakeSdk() {
  const events = new AsyncQueue();
  const state = { events, settings: [], closed: false };
  state.factory = argument => {
    state.argument = argument;
    return {
      [Symbol.asyncIterator]: () => events,
      initializationResult: async () => ({}),
      applyFlagSettings: async settings => { state.settings.push(settings); },
      close: () => { state.closed = true; events.close(); },
    };
  };
  return state;
}
const configuration = () => ({
  type: 'start', model: 'test-model', system: 'Caller system instructions.', tools: [tool],
  credential: { kind: 'api_key', token: 'local-test-placeholder' },
  upstream: 'http://127.0.0.1:1234', maxTokens: 4096,
  cwd: process.cwd(), configDir: process.cwd(),
});

test('worker configures the genuine preset, isolates tools/settings, and relays only native stream events', async () => {
  const fake = fakeSdk();
  const emitted = [];
  const worker = new CliWorker({ emit: message => emitted.push(message), queryFactory: fake.factory });
  await worker.handle(configuration());
  assert.deepEqual(emitted, [{ type: 'ready' }]);
  const { options, prompt } = fake.argument;
  assert.deepEqual(options.systemPrompt, { type: 'preset', preset: 'claude_code', append: 'Caller system instructions.' });
  assert.deepEqual(options.tools, []);
  assert.deepEqual(options.settingSources, []);
  assert.equal(options.persistSession, false);
  assert.equal(options.strictMcpConfig, true);
  assert.equal(options.includePartialMessages, true);
  await worker.handle({ type: 'prompt', content: [{ type: 'text', text: 'User content.' }] });
  assert.deepEqual((await prompt.next()).value, { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'User content.' }] }, parent_tool_use_id: null, client_composed: true });
  await worker.handle({ type: 'options', request_id: 'request-1', effort: 'high' });
  assert.deepEqual(fake.settings, [{ effortLevel: 'high' }]);
  const event = { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'original thinking' } };
  fake.events.push({ type: 'assistant', message: { content: [{ type: 'text', text: 'ignore per-block envelope' }] } });
  fake.events.push({ type: 'stream_event', event });
  fake.events.push({ type: 'result', subtype: 'success', is_error: false, session_id: 'session-id' });
  await turn();
  assert.deepEqual(emitted, [{ type: 'ready' }, { type: 'options_applied', request_id: 'request-1' }, { type: 'native_event', event }, { type: 'turn_result', success: true, session_id: 'session-id' }]);
  await worker.handle({ type: 'prompt', content: 'Second user turn.' });
  assert.equal((await prompt.next()).value.message.content, 'Second user turn.');
  worker.close();
  assert.equal(fake.closed, true);
});

test('cancellation closes the genuine engine before a pending handler rejects and leaks no raw error', async () => {
  const fake = fakeSdk();
  const emitted = [];
  const worker = new CliWorker({ emit: message => emitted.push(message), queryFactory: fake.factory });
  await worker.handle(configuration());
  const entry = worker.broker.registry.byOriginal.get(tool.name);
  const args = worker.broker.preToolUse({ tool_name: entry.native, tool_use_id: 'cancel_id', tool_input: { input: { path: 'remote' } } }).hookSpecificOutput.updatedInput;
  const abort = new AbortController();
  const pending = worker.broker.call(entry.local, args, abort.signal);
  const rejection = assert.rejects(pending, () => { assert.equal(fake.closed, true); return true; });
  abort.abort();
  await rejection;
  const error = emitted.at(-1);
  assert.equal(error.type, 'error');
  assert.equal(error.code, 'tool_cancelled');
  assert.ok(!JSON.stringify(emitted).includes('local-test-placeholder'));
});

test('mixed tool-turn user instructions queue with next priority without starting another turn', async () => {
  const fake = fakeSdk();
  const worker = new CliWorker({ emit: () => {}, queryFactory: fake.factory });
  const config = configuration();
  config.cliPath = process.execPath;
  await worker.handle(config);
  assert.equal(fake.argument.options.pathToClaudeCodeExecutable, process.execPath);
  await assert.rejects(worker.handle({ type: 'prompt', content: 'No active turn.', appendToToolTurn: true }), { code: 'no_active_tool_turn' });
  await worker.handle({ type: 'prompt', content: 'First user input.' });
  const { prompt } = fake.argument;
  await prompt.next();
  const entry = worker.broker.registry.byOriginal.get(tool.name);
  const args = worker.broker.preToolUse({ tool_name: entry.native, tool_use_id: 'mixed_id', tool_input: { input: { path: 'remote' } } }).hookSpecificOutput.updatedInput;
  const toolResult = worker.broker.call(entry.local, args);
  await worker.handle({ type: 'prompt', content: [{ type: 'text', text: 'Use the returned result with this extra instruction.' }], appendToToolTurn: true });
  assert.equal(worker.turnInProgress, true);
  assert.deepEqual((await prompt.next()).value, {
    type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Use the returned result with this extra instruction.' }] },
    parent_tool_use_id: null, client_composed: true, priority: 'next',
  });
  await assert.rejects(worker.handle({ type: 'prompt', content: 'Ordinary new prompt.' }), { code: 'turn_in_progress' });
  await worker.handle({ type: 'tool_result', tool_use_id: 'mixed_id', content: 'Actual remote output.' });
  assert.equal((await toolResult).content[0].text, 'Actual remote output.');
  assert.equal(worker.turnInProgress, true);
  fake.events.push({ type: 'result', subtype: 'success', is_error: false, session_id: 'same-session' });
  await turn();
  assert.equal(worker.turnInProgress, false);
  worker.close();
});

test('retry/fallback SDK notices terminate rather than silently continuing', async () => {
  for (const subtype of ['api_retry', 'model_refusal_fallback']) {
    const fake = fakeSdk();
    const emitted = [];
    const worker = new CliWorker({ emit: message => emitted.push(message), queryFactory: fake.factory });
    await worker.handle(configuration());
    fake.events.push({ type: 'system', subtype, error: 'raw sensitive provider diagnostic' });
    await turn();
    assert.equal(worker.closed, true);
    assert.equal(fake.closed, true);
    assert.equal(emitted.at(-1).code, subtype === 'api_retry' ? 'retry_disabled' : 'fallback_disabled');
    assert.ok(!JSON.stringify(emitted).includes('raw sensitive'));
  }
});
