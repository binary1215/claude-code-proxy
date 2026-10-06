import assert from 'node:assert/strict';
import test from 'node:test';
import { ResponsesStream, convertNativeMessage } from '../dist/services/responsesStream.js';

const model = 'claude-metadata-synthetic';
const usage = { input_tokens: 9, output_tokens: 0, cache_read_input_tokens: 13, cache_creation_input_tokens: 11,
  cache_creation: { ephemeral_5m_input_tokens: 11, ephemeral_1h_input_tokens: 0 } };
const container = { id: 'container_synthetic', expires_at: '2030-01-01T00:00:00Z', skills: [
  { type: 'anthropic', skill_id: 'skill_synthetic', version: '1' },
  { type: 'custom', skill_id: 'skill_other', version: 'latest' },
] };
const diagnostics = { cache_miss_reason: { type: 'system_changed', cache_missed_input_tokens: 7 } };
const stopDetails = { type: 'refusal', category: 'general_harms', explanation: 'SYNTHETIC_EXPLANATION_NOT_AN_ERROR_MESSAGE' };
function options() { return { model, tools: new Map(), seal: () => 'ccpr1.SYNTHETIC_ONLY' }; }
function fixture() { return new ResponsesStream(options()); }
function start(metadata = {}, initialUsage = usage) {
  return { type: 'message_start', message: { id: 'msg_synthetic_metadata', type: 'message', role: 'assistant', model,
    content: [], stop_reason: null, stop_sequence: null, usage: structuredClone(initialUsage), ...structuredClone(metadata) } };
}
function delta(metadata = {}, deltaUsage = { output_tokens: 7 }) {
  return { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null, ...structuredClone(metadata) }, usage: structuredClone(deltaUsage) };
}
const end = { type: 'message_stop' };
function addText(stream) {
  return [
    ...stream.push({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'SYNTHETIC_OUTPUT' } }),
    ...stream.push({ type: 'content_block_stop', index: 0 }),
  ];
}
function failed(events, code = 'invalid_upstream_metadata') {
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'response.failed');
  assert.equal(events[0].response.status, 'failed');
  assert.equal(events[0].response.error.code, code);
  assert(!JSON.stringify(events[0].response.error).includes('SYNTHETIC_EXPLANATION'));
}
function complete(stream, metadata = {}, finalUsage) {
  assert.deepEqual(stream.push(delta(metadata, finalUsage)), []);
  const terminal = stream.push(end);
  assert.equal(terminal.length, 1); assert.equal(terminal[0].type, 'response.completed');
  stream.finish(); return terminal[0].response;
}

test('explicit null metadata survives start and final response, absent metadata stays absent initially', () => {
  const stream = fixture();
  const metadata = { container: null, diagnostics: null, stop_details: null };
  const initial = stream.push(start(metadata));
  assert.deepEqual(initial[0].response.anthropic_metadata, metadata);
  assert.deepEqual(initial[1].response.anthropic_metadata, metadata);
  const response = complete(stream);
  assert.deepEqual(response.anthropic_metadata, { ...metadata, stop_reason: 'end_turn', stop_sequence: null });
  const absent = fixture().push(start())[0].response;
  assert.equal(Object.hasOwn(absent, 'anthropic_metadata'), false);
});

test('non-null start metadata and delta container update preserve values and immutable earlier snapshots', () => {
  const stream = fixture(), incoming = start({ container, diagnostics, stop_details: null });
  const initial = stream.push(incoming), original = structuredClone(initial);
  incoming.message.container.skills[0].version = 'caller-mutation';
  incoming.message.diagnostics.cache_miss_reason.cache_missed_input_tokens = 999;
  const replacement = { id: 'container_later', expires_at: '2031-01-01T00:00:00Z', skills: null };
  const response = complete(stream, { container: replacement, stop_details: null });
  assert.deepEqual(response.anthropic_metadata, { container: replacement, diagnostics, stop_details: null,
    stop_reason: 'end_turn', stop_sequence: null });
  assert.deepEqual(initial, original);
  assert.deepEqual(initial[0].response.anthropic_metadata.container, container);
  response.anthropic_metadata.container.id = 'returned-copy-mutation';
  assert.equal(stream.response.anthropic_metadata.container.id, 'container_later');
});

test('null or omitted delta container retains prior non-null container and diagnostics', () => {
  for (const explicitNull of [false, true]) {
    const stream = fixture(); stream.push(start({ container, diagnostics }));
    const response = complete(stream, explicitNull ? { container: null } : {});
    assert.deepEqual(response.anthropic_metadata.container, container);
    assert.deepEqual(response.anthropic_metadata.diagnostics, diagnostics);
  }
});

test('null delta stop reason/sequence retain earlier measured final values', () => {
  const stream = fixture(); stream.push(start());
  stream.push(delta({ stop_reason: 'stop_sequence', stop_sequence: 'SYNTHETIC_STOP' }));
  assert.deepEqual(stream.push(delta({ stop_reason: null, stop_sequence: null })), []);
  const result = stream.push(end)[0].response;
  assert.equal(result.status, 'completed');
  assert.equal(result.anthropic_metadata.stop_reason, 'stop_sequence');
  assert.equal(result.anthropic_metadata.stop_sequence, 'SYNTHETIC_STOP');
  stream.finish();
});

test('all declared cache miss reason variants survive exactly, including nullable reason', () => {
  const reasons = [null, ...['model_changed', 'system_changed', 'tools_changed', 'messages_changed'].map(type =>
    ({ type, cache_missed_input_tokens: 0 })), { type: 'previous_message_not_found' }, { type: 'unavailable' }];
  for (const reason of reasons) {
    const stream = fixture(), value = { cache_miss_reason: reason };
    stream.push(start({ diagnostics: value }));
    assert.deepEqual(complete(stream).anthropic_metadata.diagnostics, value);
  }
});

test('container optional skills supports omitted, null, empty and maximum bounded list', () => {
  for (const skills of [undefined, null, [], Array.from({ length: 20 }, () => ({ type: 'custom', skill_id: 's', version: 'v' }))]) {
    const value = { id: 'c', expires_at: '2030-01-01T00:00:00Z', ...(skills === undefined ? {} : { skills }) };
    const stream = fixture(); stream.push(start({ container: value }));
    assert.deepEqual(complete(stream).anthropic_metadata.container, value);
  }
});

test('malformed containers, skills, oversized strings/metadata and unknown nested fields fail closed', () => {
  const cases = [[], 'container', {}, { id: 'c' }, { id: '', expires_at: 't' }, { id: 'c', expires_at: '' },
    { id: 1, expires_at: 't' }, { id: 'c', expires_at: 't', unknown: null },
    { id: 'c', expires_at: 't', skills: {} }, { id: 'c', expires_at: 't', skills: [null] },
    { id: 'c', expires_at: 't', skills: [{ type: 'other', skill_id: 's', version: 'v' }] },
    { id: 'c', expires_at: 't', skills: [{ type: 'custom', skill_id: 's' }] },
    { id: 'c', expires_at: 't', skills: [{ type: 'custom', skill_id: '', version: 'v' }] },
    { id: 'c', expires_at: 't', skills: [{ type: 'custom', skill_id: 's', version: 'v', extra: true }] },
    { id: 'x'.repeat(4097), expires_at: 't' },
    { id: 'c', expires_at: 't', skills: Array.from({ length: 21 }, () => ({ type: 'custom', skill_id: 's', version: 'v' })) },
    { id: 'c', expires_at: 't', skills: Array.from({ length: 5 }, () => ({ type: 'custom', skill_id: 's'.repeat(4000), version: 'v' })) },
  ];
  for (const value of cases) failed(fixture().push(start({ container: value })));
});

test('malformed or unknown diagnostics shapes fail instead of being dropped', () => {
  const cases = [[], {}, { cache_miss_reason: 'unknown' }, { cache_miss_reason: {} },
    { cache_miss_reason: { type: 'future_reason' } },
    { cache_miss_reason: { type: 'system_changed' } },
    { cache_miss_reason: { type: 'system_changed', cache_missed_input_tokens: -1 } },
    { cache_miss_reason: { type: 'system_changed', cache_missed_input_tokens: 0.5 } },
    { cache_miss_reason: { type: 'system_changed', cache_missed_input_tokens: Number.MAX_SAFE_INTEGER + 1 } },
    { cache_miss_reason: { type: 'system_changed', cache_missed_input_tokens: 1, extra: true } },
    { cache_miss_reason: { type: 'unavailable', cache_missed_input_tokens: 1 } },
    { cache_miss_reason: null, extra: true },
  ];
  for (const value of cases) failed(fixture().push(start({ diagnostics: value })));
});

test('start cannot contain final refusal and delta cannot move diagnostics to an undeclared placement', () => {
  failed(fixture().push(start({ stop_details: stopDetails })));
  for (const value of [null, diagnostics]) {
    const stream = fixture(); stream.push(start());
    failed(stream.push(delta({ diagnostics: value })), 'unsupported_upstream_event');
  }
  for (const metadata of [{ container: null, unknown: null }, { context_management: null }]) {
    failed(fixture().push(start(metadata)), 'unsupported_upstream_event');
  }
});

test('malformed final stop details fail closed with safe metadata error', () => {
  for (const value of [[], {}, { type: 'refusal' }, { type: 'other', category: null, explanation: null },
    { type: 'refusal', category: 'unknown', explanation: null }, { type: 'refusal', category: null, explanation: 5 },
    { type: 'refusal', category: null, explanation: 'x'.repeat(4097) }, { ...stopDetails, extra: true }]) {
    const stream = fixture(); stream.push(start()); failed(stream.push(delta({ stop_details: value })));
  }
});

test('refusal emits failed at message_stop before marking stopped, preserving output, metadata and usage', () => {
  for (const category of [null, 'cyber', 'bio', 'frontier_llm', 'reasoning_extraction', 'general_harms']) {
    const stream = fixture(), details = { ...stopDetails, category, explanation: category === null ? null : stopDetails.explanation };
    const events = stream.push(start({ container, diagnostics, stop_details: null }));
    events.push(...addText(stream));
    assert.deepEqual(stream.push(delta({ stop_reason: 'refusal', stop_details: details })), []);
    assert.equal(stream.terminal, false); assert.equal(stream.response.status, 'in_progress');
    const terminal = stream.push(end); failed(terminal, 'provider_refusal'); events.push(...terminal);
    assert.equal(stream.terminal, true);
    assert.equal(events.filter(event => ['response.completed', 'response.incomplete'].includes(event.type)).length, 0);
    const response = terminal[0].response;
    assert.deepEqual(response.output, events.filter(event => event.type === 'response.output_item.done').map(event => event.item));
    assert.equal(response.output[0].content[0].text, 'SYNTHETIC_OUTPUT');
    assert.deepEqual(response.anthropic_metadata, { container, diagnostics, stop_details: details, stop_reason: 'refusal', stop_sequence: null });
    assert.deepEqual(response.anthropic_usage, { ...usage, output_tokens: 7 });
    assert.deepEqual(stream.fail('upstream_error', 'do-not-copy'), []);
    assert.throws(() => stream.finish(), error => error.code === 'incomplete_upstream_stream');
  }
});

test('refusal reason alone or refusal details alone cannot become successful completion', () => {
  for (const metadata of [{ stop_reason: 'refusal' }, { stop_details: stopDetails }]) {
    const stream = fixture(); stream.push(start()); addText(stream); stream.push(delta(metadata));
    failed(stream.push(end), 'provider_refusal');
  }
});

test('late refusal preserves already emitted tool output but cannot retract a client action', () => {
  const stream = new ResponsesStream({ ...options(), tools: new Map([
    ['lookup', { nativeName: 'lookup', name: 'lookup', kind: 'function' }],
  ]) });
  stream.push(start());
  stream.push({ type: 'content_block_start', index: 0, content_block: {
    type: 'tool_use', id: 'tool_synthetic', name: 'lookup', input: {}, caller: { type: 'direct' },
  } });
  const done = stream.push({ type: 'content_block_stop', index: 0 }).find(event => event.type === 'response.output_item.done');
  assert.equal(done.item.type, 'function_call');
  stream.push(delta({ stop_reason: 'refusal', stop_details: stopDetails }));
  const terminal = stream.push(end); failed(terminal, 'provider_refusal');
  assert.deepEqual(terminal[0].response.output, [done.item]);
});

test('once final refusal details exist they cannot be cleared or changed by another delta', () => {
  for (const value of [null, { ...stopDetails, category: 'cyber' }]) {
    const stream = fixture(); stream.push(start()); stream.push(delta({ stop_reason: 'refusal', stop_details: stopDetails }));
    failed(stream.push(delta({ stop_reason: 'refusal', stop_details: value })), 'invalid_upstream_metadata');
  }
  const stream = fixture(); stream.push(start());
  stream.push(delta({ stop_reason: 'refusal', stop_details: stopDetails }));
  assert.deepEqual(stream.push(delta({ stop_reason: 'refusal', stop_details: {
    explanation: stopDetails.explanation, category: stopDetails.category, type: stopDetails.type,
  } })), []);
  failed(stream.push(end), 'provider_refusal');
});

test('nonstream preserves declared metadata and returns provider_refusal rather than fabricating success or throwing', () => {
  for (const refuse of [false, true]) {
    const message = { ...start({ container, diagnostics, stop_details: refuse ? stopDetails : null }).message,
      content: [{ type: 'text', text: 'SYNTHETIC_OUTPUT' }], stop_reason: refuse ? 'refusal' : 'end_turn', usage: { ...usage, output_tokens: 7 } };
    const before = structuredClone(message), response = convertNativeMessage(message, options());
    assert.deepEqual(message, before);
    assert.equal(response.status, refuse ? 'failed' : 'completed');
    assert.equal(response.error?.code ?? null, refuse ? 'provider_refusal' : null);
    assert.equal(response.output[0].content[0].text, 'SYNTHETIC_OUTPUT');
    assert.deepEqual(response.anthropic_metadata, { container, diagnostics, stop_details: refuse ? stopDetails : null,
      stop_reason: refuse ? 'refusal' : 'end_turn', stop_sequence: null });
  }
  assert.throws(() => convertNativeMessage({ ...start({ container: { bad: true } }).message,
    content: [], stop_reason: 'end_turn' }, options()), error => error.code === 'invalid_upstream_metadata');
});

test('nullable delta input/cache counters retain known cumulative measurements and truthful standard totals', () => {
  const stream = fixture(), initial = stream.push(start());
  const response = complete(stream, {}, { input_tokens: null, cache_read_input_tokens: null, cache_creation_input_tokens: null, output_tokens: 7 });
  assert.deepEqual(response.anthropic_usage, { ...usage, output_tokens: 7 });
  assert.deepEqual(response.usage, { input_tokens: 33, output_tokens: 7, total_tokens: 40,
    input_tokens_details: { cached_tokens: 13, cache_write_tokens: 11 } });
  assert.deepEqual(initial[0].response.anthropic_usage, usage);
});

test('nullable delta counters without prior measurements remain unknown, never synthesized zero', () => {
  const stream = fixture(); stream.push(start({}, { output_tokens: 0 }));
  const response = complete(stream, {}, { input_tokens: null, cache_read_input_tokens: null, cache_creation_input_tokens: null, output_tokens: 7 });
  assert.deepEqual(response.anthropic_usage, { output_tokens: 7 }); assert.equal(response.usage, null);
});

test('nullable delta usage details retain prior server-tool/detail values, without inventing absent values', () => {
  for (const present of [false, true]) {
    const extra = present ? { server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
      output_tokens_details: { reasoning_tokens: 3 } } : {};
    const initialUsage = { ...usage, ...extra };
    const stream = fixture(); stream.push(start({}, initialUsage));
    const response = complete(stream, {}, { output_tokens: 7, server_tool_use: null, output_tokens_details: null });
    assert.deepEqual(response.anthropic_usage, { ...initialUsage, output_tokens: 7 });
  }
});

test('initial null counters, null output, malformed counts and decreasing cumulative counters remain rejected', () => {
  const fields = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];
  for (const field of fields) {
    failed(fixture().push(start({}, { ...usage, [field]: null })), 'invalid_upstream_usage');
    for (const value of [-1, 0.5, '1', false, Number.MAX_SAFE_INTEGER + 1]) {
      const stream = fixture(); stream.push(start());
      failed(stream.push(delta({}, { [field]: value })), 'invalid_upstream_usage');
    }
    const stream = fixture(); stream.push(start({}, { ...usage, output_tokens: 8 }));
    failed(stream.push(delta({}, { [field]: 0 })), 'invalid_upstream_usage');
  }
  const stream = fixture(); stream.push(start());
  failed(stream.push(delta({}, { output_tokens: null })), 'invalid_upstream_usage');
});

test('absent, null and empty native citations normalize only the no-annotation default', () => {
  for (const extra of [{}, { citations: null }, { citations: [] }]) {
    const stream = fixture(); stream.push(start());
    stream.push({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'TEXT', ...extra } });
    const done = stream.push({ type: 'content_block_stop', index: 0 })
      .find(event => event.type === 'response.output_item.done').item;
    const response = complete(stream);
    assert.deepEqual(response.output, [done]);
    assert.deepEqual(done.content, [{ type: 'output_text', text: 'TEXT', annotations: [], logprobs: [] }]);
    assert.equal(Object.hasOwn(done.content[0], 'citations'), false);
    const nonstream = convertNativeMessage({ ...start().message, content: [{ type: 'text', text: 'TEXT', ...extra }],
      stop_reason: 'end_turn' }, options());
    assert.deepEqual(nonstream.output[0].content, done.content);
  }
});

test('non-empty/malformed citations and citation deltas remain explicit unsupported failures', () => {
  for (const citations of [[{ type: 'char_location', document_index: 0 }], {}, 'citation', false, 1]) {
    const stream = fixture(); stream.push(start());
    failed(stream.push({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'TEXT', citations } }),
      'unsupported_upstream_block');
  }
  const stream = fixture(); stream.push(start());
  stream.push({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  failed(stream.push({ type: 'content_block_delta', index: 0, delta: { type: 'citations_delta', citation: {} } }),
    'unsupported_upstream_delta');
});

test('explicit direct caller/null toolset preserve function/custom identity and payload without extension leakage', () => {
  for (const kind of ['function', 'custom']) for (const extra of [{}, { caller: { type: 'direct' } },
    { toolset_name: null }, { caller: { type: 'direct' }, toolset_name: null }]) {
    const binding = { nativeName: 'native_fixture', name: 'fixture', namespace: 'functions', kind };
    const value = kind === 'function' ? { key: '漢字', number: 7 } : { input: 'raw custom\n漢字' };
    const native = { type: 'tool_use', id: 'call_exact_fixture', name: 'native_fixture', input: value, ...extra };
    const configured = { ...options(), tools: new Map([['native_fixture', binding]]) };
    const stream = new ResponsesStream(configured); stream.push(start());
    stream.push({ type: 'content_block_start', index: 0, content_block: structuredClone(native) });
    const done = stream.push({ type: 'content_block_stop', index: 0 }).find(event => event.type === 'response.output_item.done').item;
    const response = complete(stream, { stop_reason: 'tool_use' });
    assert.deepEqual(response.output, [done]);
    assert.equal(done.type, kind === 'function' ? 'function_call' : 'custom_tool_call');
    assert.equal(done.call_id, native.id); assert.equal(done.name, 'fixture'); assert.equal(done.namespace, 'functions');
    assert.equal(done.status, 'completed');
    assert.equal(Object.hasOwn(done, 'caller'), false); assert.equal(Object.hasOwn(done, 'toolset_name'), false);
    if (kind === 'function') assert.equal(done.arguments, JSON.stringify(value)); else assert.equal(done.input, value.input);
    const converted = convertNativeMessage({ ...start().message, content: [native], stop_reason: 'tool_use' }, configured).output[0];
    const { id: _streamId, ...streamFields } = done, { id: _convertedId, ...convertedFields } = converted;
    assert.deepEqual(convertedFields, streamFields);
  }
});

test('server callers, malformed direct caller and non-null toolsets cannot become client tool calls', () => {
  for (const extra of [{ caller: null }, { caller: {} }, { caller: 'direct' },
    { caller: { type: 'code_execution_20250825', tool_id: 'server_tool' } },
    { caller: { type: 'direct', extra: true } }, { toolset_name: '' }, { toolset_name: 'server_set' }]) {
    const configured = { ...options(), tools: new Map([['native_fixture', { nativeName: 'native_fixture', name: 'fixture', kind: 'function' }]]) };
    const stream = new ResponsesStream(configured); stream.push(start());
    failed(stream.push({ type: 'content_block_start', index: 0,
      content_block: { type: 'tool_use', id: 'call', name: 'native_fixture', input: {}, ...extra } }), 'unsupported_upstream_block');
    assert.equal(stream.response.output.length, 0);
  }
});
