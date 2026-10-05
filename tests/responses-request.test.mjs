import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareResponsesRequest } from '../dist/services/responsesRequest.js';
import { ResponsesError } from '../dist/services/responsesTypes.js';
import { convertNativeMessage } from '../dist/services/responsesStream.js';

const model = 'native-model-no-alias';
const context = { model, principal: 'synthetic-principal', upstream: 'synthetic-upstream' };
const states = new Map();
let serial = 0;
const codec = {
  seal(block, bound, itemId) {
    const token = `synthetic-state-${++serial}`;
    states.set(token, { block: structuredClone(block), context: JSON.stringify(bound), itemId });
    return token;
  },
  open(token, bound, itemId) {
    const state = states.get(token);
    if (!state || state.context !== JSON.stringify(bound) || state.itemId !== itemId) throw new Error('Synthetic state authentication failed');
    return structuredClone(state.block);
  },
};
const options = { codec, context, defaultMaxTokens: 8192, defaultThinkingBudget: 1024 };
const fn = (name = 'lookup') => ({ type: 'function', name, parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false }, strict: false });
const message = (role, text) => ({ role, content: text });
const call = (id = 'call_one', name = 'lookup', extra = {}) => ({ type: 'function_call', call_id: id, name, arguments: '{"city":"Seoul"}', ...extra });
const output = (id = 'call_one', extra = {}) => ({ type: 'function_call_output', call_id: id, output: 'Local tool result', ...extra });
const request = (extra = {}) => ({ model, store: false, input: 'Hello 한글🙂', ...extra });
const prepare = value => prepareResponsesRequest(value, options);
const reasoning = (id, block) => ({ type: 'reasoning', id, encrypted_content: codec.seal(block, context, id), summary: [{ type: 'summary_text', text: 'Not authoritative prompt content' }] });

function bad(value, code, status = 400) {
  assert.throws(() => prepare(value), error => error instanceof ResponsesError && error.status === status && (!code || error.code === code));
}

test('native model, string input, default bounded thinking; no persistence or metadata in prompt', () => {
  const prepared = prepare(request({ client_metadata: { opaque_session_id: 'DO_NOT_PROMPT_ID' }, prompt_cache_key: 'DO_NOT_PROMPT_CACHE_KEY', include: ['reasoning.encrypted_content'], text: { format: { type: 'text' } }, reasoning: { summary: 'auto' }, stream: true }));
  assert.equal(prepared.model, model);
  assert.equal(prepared.stream, true);
  assert.deepEqual(prepared.nativeBody, { model, max_tokens: 8192, stream: true, thinking: { type: 'enabled', budget_tokens: 1024 }, messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello 한글🙂' }] }] });
  assert.equal(prepared.tools.size, 0);
  bad(request({ model: 'changed-native-model' }), 'invalid_reasoning_state', 409);
});

test('only initial system/developer prefix; instructions and per-block native cache TTL retained', () => {
  const cache = { type: 'ephemeral', ttl: '1h' };
  const prepared = prepare(request({ instructions: 'First system', input: [message('system', 'Second'), { role: 'developer', content: [{ type: 'input_text', text: 'Third', cache_control: cache }] }, { role: 'user', content: [{ type: 'input_text', text: 'Go', cache_control: { type: 'ephemeral', ttl: '5m' } }] }], anthropic: { cache_control: cache } }));
  assert.deepEqual(prepared.nativeBody.system, [{ type: 'text', text: 'First system' }, { type: 'text', text: 'Second' }, { type: 'text', text: 'Third', cache_control: cache }]);
  assert.deepEqual(prepared.nativeBody.messages[0].content[0].cache_control, { type: 'ephemeral', ttl: '5m' });
  assert.deepEqual(prepared.nativeBody.cache_control, cache);
  bad(request({ input: [message('user', 'Go'), message('developer', 'Never relocate')] }), 'unsupported_parameter');
  bad(request({ input: [message('user', 'Go'), message('system', 'Never relocate')] }), 'unsupported_parameter');
});

test('signed-empty, nonempty, redacted and assistant text preserve exact ordered original blocks', () => {
  const blocks = [
    { type: 'thinking', thinking: 'Opaque thought🙂', signature: 'signed-one+/=', cache_control: { type: 'ephemeral', ttl: '1h' }, native_future_extension: 'retained-authenticated-state' },
    { type: 'thinking', thinking: '', signature: 'signed-empty-one+/=' },
    { type: 'thinking', thinking: '', signature: 'signed-empty-two+/=' },
    { type: 'redacted_thinking', data: 'redacted+/=' },
  ];
  const input = [message('user', 'Go'), ...blocks.map((block, i) => reasoning(`rs_${i}`, block)), { type: 'message', role: 'assistant', id: 'msg_local', status: 'completed', content: [{ type: 'output_text', text: 'Visible', annotations: [], logprobs: [] }] }, message('user', 'Continue')];
  const prepared = prepare(request({ input }));
  assert.deepEqual(prepared.nativeBody.messages[1], { role: 'assistant', content: [...blocks, { type: 'text', text: 'Visible' }] });
  assert.equal(JSON.stringify(prepared.nativeBody).includes('Not authoritative prompt content'), false);
  assert.equal(JSON.stringify(prepared.nativeBody).includes('rs_0'), false);
});

test('reasoning codec failures never substitute summary and errors never echo private content', () => {
  const block = { type: 'thinking', thinking: 'PRIVATE_THOUGHT', signature: 'sig' };
  const state = reasoning('rs_auth', block);
  for (const item of [{ ...state, encrypted_content: 'PRIVATE_TAMPERED_TOKEN' }, { ...state, id: 'rs_changed' }, { ...state, encrypted_content: null }, { type: 'reasoning', id: 'rs_missing', summary: state.summary }]) {
    bad(request({ input: [message('user', 'Go'), item] }), undefined, typeof item.encrypted_content === 'string' ? 409 : 400);
    try { prepare(request({ input: [message('user', 'Go'), item] })); } catch (error) { assert.equal(error.message.includes('PRIVATE'), false); }
  }
  assert.throws(() => prepareResponsesRequest(request({ input: [message('user', 'Go'), state] }), { ...options, context: { ...context, principal: 'other' } }), ResponsesError);
  assert.throws(() => prepareResponsesRequest(request({ input: [message('user', 'Go'), state] }), { ...options, context: { ...context, upstream: 'other' } }), ResponsesError);
  bad(request({ input: [message('user', 'Go'), state, state] }), 'invalid_reasoning_state');
  assert.equal(prepare(request({ input: [message('user', 'Go'), { ...state, content: null }, message('user', 'Continue')] })).nativeBody.messages[1].content[0].signature, 'sig');
  for (const invalid of [{ type: 'thinking', thinking: '', signature: '' }, { type: 'redacted_thinking', data: '' }, { type: 'text', text: 'Cannot become reasoning' }]) bad(request({ input: [message('user', 'Go'), reasoning('rs_invalid', invalid)] }), 'invalid_reasoning_state');
});

test('function calls merge with assistant blocks; results retain order/error/cache without execution', () => {
  const first = reasoning('rs_before', { type: 'thinking', thinking: '', signature: 'sig-empty' });
  const interleaved = reasoning('rs_interleaved', { type: 'thinking', thinking: 'between tool and text', signature: 'sig-interleaved' });
  const after = reasoning('rs_after_tool', { type: 'thinking', thinking: 'after', signature: 'sig-after' });
  const prepared = prepare(request({ tools: [fn()], input: [message('user', 'Go'), first, call('call_a'), interleaved, message('assistant', 'Calling more'), call('call_b'), output('call_b', { is_error: true, cache_control: { type: 'ephemeral', ttl: '1h' } }), output('call_a', { is_error: false }), after, message('assistant', 'Done'), message('user', 'Continue')] }));
  const messages = prepared.nativeBody.messages;
  assert.deepEqual(messages[1].content.map(block => block.type), ['thinking', 'tool_use', 'thinking', 'text', 'tool_use']);
  assert.deepEqual(messages[1].content[1], { type: 'tool_use', id: 'call_a', name: 'lookup', input: { city: 'Seoul' } });
  assert.deepEqual(messages[2].content.map(block => block.tool_use_id), ['call_b', 'call_a']);
  assert.equal(messages[2].content[0].is_error, true);
  assert.equal(messages[2].content[1].is_error, false);
  assert.deepEqual(messages[2].content[0].cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.deepEqual(messages[3].content.map(block => block.type), ['thinking', 'text']);
});

test('namespace tools flatten deterministically and restore exact binding; custom text wraps input', () => {
  const tools = [{ type: 'namespace', name: 'functions', description: 'Namespace context', tools: [fn('lookup'), { type: 'custom', name: 'run_text', description: 'Free text', format: { type: 'text' } }] }, fn('lookup')];
  const prepared = prepare(request({ tools, input: [message('user', 'Go'), call('call_ns', 'lookup', { namespace: 'functions' }), output('call_ns'), { type: 'custom_tool_call', namespace: 'functions', call_id: 'call_custom', name: 'run_text', input: 'opaque script\n🙂' }, { type: 'custom_tool_call_output', call_id: 'call_custom', output: [{ type: 'input_text', text: 'Done' }] }] }));
  const native = prepared.nativeBody.tools;
  assert.match(native[0].name, /^ns_[0-9a-f]{60}$/);
  assert.equal(native[2].name, 'lookup');
  assert.deepEqual(prepared.tools.get(native[0].name), { nativeName: native[0].name, name: 'lookup', namespace: 'functions', kind: 'function' });
  assert.equal(prepare(request({ tools })).nativeBody.tools[0].name, native[0].name);
  assert.deepEqual(native[1].input_schema, { type: 'object', properties: { input: { type: 'string' } }, required: ['input'], additionalProperties: false });
  assert.deepEqual(prepared.nativeBody.messages[3].content[0].input, { input: 'opaque script\n🙂' });
});

test('tool collisions and unsupported strict/grammar/server tools fail closed', () => {
  const namespace = { type: 'namespace', name: 'functions', tools: [fn()] };
  const flattened = prepare(request({ tools: [namespace] })).nativeBody.tools[0].name;
  for (const tools of [[fn(), fn()], [namespace, namespace], [namespace, fn(flattened)], [{ ...fn(), strict: true }], [{ type: 'web_search' }], [{ type: 'custom', name: 'grammar', format: { type: 'grammar', syntax: 'lark', definition: 'start: TEXT' } }], [{ type: 'namespace', name: 'nested', tools: [namespace] }]]) bad(request({ tools }), 'unsupported_tool');
  bad(request({ tools: [fn('n'.repeat(65))] }));
});

test('emitted function/custom call IDs replay at the same 256-character boundary', () => {
  for (const kind of ['function', 'custom']) {
    const definition = kind === 'function' ? fn() : { type: 'custom', name: 'lookup' };
    const tools = [definition];
    const prepared = prepare(request({ tools }));
    const translation = { model, tools: prepared.tools, seal: codec.seal };
    for (const length of [64, 65, 256]) {
      const callId = 'x'.repeat(length);
      const native = { id: 'msg_boundary', type: 'message', role: 'assistant', model,
        content: [{ type: 'tool_use', id: callId, name: 'lookup', input: kind === 'function' ? { city: 'Seoul' } : { input: 'read only' } }],
        stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
      const converted = convertNativeMessage(native, translation);
      const result = { type: kind === 'function' ? 'function_call_output' : 'custom_tool_call_output', call_id: callId, output: 'Done' };
      const replay = prepare(request({ tools, input: [message('user', 'Go'), ...converted.output, result] }));
      assert.deepEqual(replay.nativeBody.messages[1].content, native.content);
      assert.equal(replay.nativeBody.messages[2].content[0].tool_use_id, callId);
      const tooLong = 'x'.repeat(257);
      assert.throws(() => convertNativeMessage({ ...native, content: [{ ...native.content[0], id: tooLong }] }, translation), ResponsesError);
      bad(request({ tools, input: [message('user', 'Go'), { ...converted.output[0], call_id: tooLong }, { ...result, call_id: tooLong }] }));
      bad(request({ tools, input: [message('user', 'Go'), converted.output[0], { ...result, call_id: tooLong }] }));
    }
  }
});

test('tool history rejects orphan/duplicate/mismatched/incomplete/out-of-turn results', () => {
  const invalid = [
    [output()], [call()], [call(), output(), output()], [call(), call(), output()],
    [call(), { type: 'custom_tool_call_output', call_id: 'call_one', output: 'Wrong type' }],
    [call(), output('unknown')], [call(), message('user', 'Interrupted')],
    [call('call_a'), call('call_b'), output('call_a'), message('assistant', 'Incomplete parallel batch'), output('call_b')],
    [call('call_a'), call('call_b'), output('call_a'), call('call_c'), output('call_b'), output('call_c')],
    [call('call_a', 'missing'), output('call_a')],
    [call('call_a', 'lookup', { arguments: '[]' }), output('call_a')],
    [call('call_a', 'lookup', { arguments: 'not-json PRIVATE_ARGUMENTS' }), output('call_a')],
    [call('call_a'), output('call_a', { is_error: 'true' })],
  ];
  for (const history of invalid) bad(request({ tools: [fn()], input: [message('user', 'Go'), ...history] }));
});

test('native tool choice and parallel semantics explicitly map with thinking disabled', () => {
  for (const [choice, nativeType] of [['auto', 'auto'], ['required', 'any'], ['none', 'none']]) {
    const prepared = prepare(request({ tools: [fn()], reasoning: { effort: 'none' }, tool_choice: choice, parallel_tool_calls: false }));
    assert.deepEqual(prepared.nativeBody.tool_choice, { type: nativeType, ...(nativeType === 'none' ? {} : { disable_parallel_tool_use: true }) });
  }
  const prepared = prepare(request({ tools: [fn()], reasoning: { effort: 'none' }, tool_choice: { type: 'function', name: 'lookup' }, parallel_tool_calls: true }));
  assert.deepEqual(prepared.nativeBody.tool_choice, { type: 'tool', name: 'lookup', disable_parallel_tool_use: false });
  bad(request({ tools: [fn()], tool_choice: 'required' }), 'unsupported_parameter');
});

test('native explicit thinking policy has no guessed effort mapping and bounded token budget', () => {
  assert.equal(prepare(request({ reasoning: { effort: 'none' }, max_output_tokens: 16 })).nativeBody.thinking, undefined);
  assert.deepEqual(prepare(request({ anthropic: { thinking: { type: 'enabled', budget_tokens: 10_000 } }, max_output_tokens: 12_000 })).nativeBody.thinking, { type: 'enabled', budget_tokens: 10_000 });
  for (const effort of ['low', 'medium', 'high']) {
    const native = prepare(request({ reasoning: { effort, summary: 'detailed' }, anthropic: { thinking: { type: 'adaptive' }, output_config: { effort } } })).nativeBody;
    assert.deepEqual(native.thinking, { type: 'adaptive' });
    assert.deepEqual(native.output_config, { effort });
    bad(request({ reasoning: { effort } }), 'unsupported_parameter');
  }
  for (const extra of [
    { max_output_tokens: 1024 }, { max_output_tokens: 65_537 }, { max_output_tokens: null },
    { reasoning: { effort: 'xhigh' }, anthropic: { thinking: { type: 'adaptive' }, output_config: { effort: 'max' } } },
    { reasoning: { effort: 'none' }, anthropic: { thinking: { type: 'enabled', budget_tokens: 1024 } } },
    { anthropic: { thinking: { type: 'enabled', budget_tokens: 1023 } } },
    { anthropic: { thinking: { type: 'enabled', budget_tokens: 8192 } } },
    { reasoning: { effort: 'high' }, anthropic: { thinking: { type: 'adaptive' }, output_config: { effort: 'low' } } },
    { temperature: 0.5 }, { top_p: 0.9 },
  ]) bad(request(extra));
});

test('images are pure URL/base64 translation, not file access or fetch/detail emulation', () => {
  const input = [{ role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=', detail: 'auto', cache_control: { type: 'ephemeral', ttl: '1h' } }, { type: 'input_image', image_url: 'https://example.invalid/image.png' }] }];
  const native = prepare(request({ input })).nativeBody.messages[0].content;
  assert.deepEqual(native[0], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' }, cache_control: { type: 'ephemeral', ttl: '1h' } });
  assert.deepEqual(native[1], { type: 'image', source: { type: 'url', url: 'https://example.invalid/image.png' } });
  for (const block of [{ type: 'input_image', file_id: 'file_private' }, { type: 'input_image', image_url: 'http://example.invalid/x' }, { type: 'input_image', image_url: 'https://user:password@example.invalid/x' }, { type: 'input_image', image_url: 'data:image/svg+xml;base64,aGVsbG8=' }, { type: 'input_image', image_url: 'data:image/png;base64,A' }, { type: 'input_image', image_url: 'https://example.invalid/x', detail: 'high' }]) bad(request({ input: [{ role: 'user', content: [block] }] }));
});

test('unsupported semantic parameters and state/storage capabilities never silently degrade', () => {
  for (const extra of [{ store: true }, { previous_response_id: 'resp_private' }, { background: true }, { truncation: 'auto' }, { unknown_semantic_parameter: 'PRIVATE' }, { text: { format: { type: 'json_schema', schema: {} } } }, { text: { verbosity: 'low' } }, { include: ['message.output_text.logprobs'] }, { reasoning: { generate_summary: 'auto' } }, { metadata: { provider_state: 'private' } }, { anthropic: { unknown: true } }, { stream: 'true' }, { tools: [{ type: 'function', name: 'lookup', parameters: { type: 'array' } }] }]) bad(request(extra));
  bad(request({ input: [{ type: 'compaction', encrypted_content: 'opaque' }] }));
  bad(request({ input: [{ role: 'assistant', content: [{ type: 'refusal', refusal: 'No' }] }] }));
});

test('input objects, signed blocks, schemas and cache flags are not mutated', () => {
  const source = request({ tools: [{ ...fn(), cache_control: { type: 'ephemeral', ttl: '1h' } }], input: [message('user', 'Go'), call(), output()] });
  const snapshot = structuredClone(source);
  const prepared = prepare(source);
  prepared.nativeBody.tools[0].input_schema.properties.city.type = 'changed-local-output';
  assert.deepEqual(source, snapshot);
  assert.equal(source.tools[0].parameters.properties.city.type, 'string');
});

test('JSON argument keys cannot mutate prototypes and codec errors remain sanitized 409', () => {
  const prepared = prepare(request({ tools: [fn()], input: [message('user', 'Go'), call('call_safe', 'lookup', { arguments: '{"__proto__":{"polluted":"PRIVATE"},"city":"Seoul"}' }), output('call_safe')] }));
  const args = prepared.nativeBody.messages[1].content[0].input;
  assert.equal(Object.hasOwn(args, '__proto__'), true);
  assert.equal({}.polluted, undefined);
  const sealed = reasoning('rs_private_failure', { type: 'thinking', thinking: '', signature: 'sig' });
  assert.throws(() => prepareResponsesRequest(request({ input: [message('user', 'Go'), sealed] }), { ...options, codec: { ...codec, open() { throw new ResponsesError('invalid_reasoning_state', 'PRIVATE_CODEC_DETAIL', 409); } } }), error => error.status === 409 && error.code === 'invalid_reasoning_state' && !error.message.includes('PRIVATE'));
});
