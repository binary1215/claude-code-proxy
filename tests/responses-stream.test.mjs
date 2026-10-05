import assert from 'node:assert/strict';
import test from 'node:test';
import { ResponsesStream, NativeSseDecoder, convertNativeMessage } from '../dist/services/responsesStream.js';

const model = 'claude-synthetic-fixture';
const fullUsage = { input_tokens: 10, cache_read_input_tokens: 3, cache_creation_input_tokens: 5, output_tokens: 0,
  cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 3 } };
function fixture() {
  const sealed = [];
  const options = { model, tools: new Map([
    ['native_fn', { nativeName: 'native_fn', name: 'inspect', namespace: 'functions', kind: 'function' }],
    ['native_custom', { nativeName: 'native_custom', name: 'apply_patch', namespace: 'functions', kind: 'custom' }],
  ]), seal(block, itemId) {
    sealed.push({ block: structuredClone(block), itemId });
    return `opaque_${Buffer.from(JSON.stringify({ block, itemId })).toString('base64')}`;
  } };
  return { stream: new ResponsesStream(options), options, sealed };
}
function start(usage = fullUsage, extra = {}) {
  return { type: 'message_start', message: { id: 'msg_native_fixture', type: 'message', role: 'assistant', model,
    content: [], stop_reason: null, stop_sequence: null, usage: structuredClone(usage), ...extra } };
}
const block = (index, content_block) => ({ type: 'content_block_start', index, content_block });
const delta = (index, value) => ({ type: 'content_block_delta', index, delta: value });
const stop = (index) => ({ type: 'content_block_stop', index });
const messageDelta = (reason = 'end_turn', usage = { output_tokens: 7 }) => ({ type: 'message_delta', delta: { stop_reason: reason, stop_sequence: null }, usage });
const messageStop = { type: 'message_stop' };
function run(stream, events) { return events.flatMap((event) => stream.push(event)); }
function completed(events) { return events.find((event) => event.type === 'response.completed')?.response; }
function assertFailure(events, code) {
  assert(!events.some((event) => event.type === 'response.completed' || event.type === 'response.incomplete'));
  const failure = events.at(-1);
  assert.equal(failure.type, 'response.failed');
  assert.equal(failure.response.status, 'failed');
  if (code) assert.equal(failure.response.error.code, code);
}

test('signed-empty, split signature, redacted: exact sealed blocks/order and done/completed identity', () => {
  const { stream, sealed } = fixture();
  const original = { type: 'thinking', thinking: '', cache_control: { type: 'ephemeral', ttl: '1h' },
    synthetic_extension: { count: 1 } };
  const redacted = { type: 'redacted_thinking', data: 'SYNTHETIC_REDACTED', cache_control: { type: 'ephemeral' } };
  const events = run(stream, [start(), block(0, original),
    delta(0, { type: 'thinking_delta', thinking: '' }),
    delta(0, { type: 'signature_delta', signature: 'SYNTHETIC_' }),
    delta(0, { type: 'signature_delta', signature: 'SIGNATURE' }), stop(0), block(1, redacted), stop(1),
    block(2, { type: 'text', text: '' }), delta(2, { type: 'text_delta', text: '漢글 🧪 done' }), stop(2),
    messageDelta(), messageStop]);
  stream.finish();
  assert.equal(stream.terminal, true);
  assert.deepEqual(sealed.map((value) => value.block), [{ ...original, signature: 'SYNTHETIC_SIGNATURE' }, redacted]);
  assert.deepEqual(original, { type: 'thinking', thinking: '', cache_control: { type: 'ephemeral', ttl: '1h' }, synthetic_extension: { count: 1 } });
  const done = events.filter((event) => event.type === 'response.output_item.done');
  assert.deepEqual(done.map((event) => event.output_index), [0, 1, 2]);
  assert.deepEqual(done.map((event) => event.item.type), ['reasoning', 'reasoning', 'message']);
  assert.deepEqual(done.slice(0, 2).map((event) => event.item.summary), [[], []]);
  for (let index = 0; index < done.length; index++) assert.deepEqual(done[index].item, completed(events).output[index]);
  for (let index = 0; index < 2; index++) {
    assert(done[index].item.encrypted_content);
    assert.equal(done[index].item.id, sealed[index].itemId);
  }
  assert.deepEqual(events.map((event) => event.sequence_number), events.map((_, index) => index));
  assert.deepEqual(events.slice(0, 2).map((event) => event.type), ['response.created', 'response.in_progress']);
  assert.equal(events[0].response.output.length, 0, 'Prior emitted snapshots must not mutate');
  const snapshot = stream.response;
  snapshot.output[0].encrypted_content = 'caller_mutation';
  assert.notEqual(stream.response.output[0].encrypted_content, 'caller_mutation');
});

test('thinking summary uses text only, signature fragments never become thinking text', () => {
  const { stream, sealed } = fixture();
  const events = run(stream, [start(), block(0, { type: 'thinking', thinking: 'initial ', signature: '' }),
    delta(0, { type: 'thinking_delta', thinking: 'Δ🧪' }),
    delta(0, { type: 'signature_delta', signature: 'secret-a' }),
    delta(0, { type: 'signature_delta', signature: '-b' }), stop(0), messageDelta(), messageStop]);
  const done = events.find((event) => event.type === 'response.output_item.done').item;
  assert.deepEqual(done.summary, [{ type: 'summary_text', text: 'initial Δ🧪' }]);
  assert.equal(sealed[0].block.signature, 'secret-a-b');
  assert.equal(sealed[0].block.thinking, 'initial Δ🧪');
  assert.equal(events.filter((event) => event.type === 'response.reasoning_summary_text.delta').map((event) => event.delta).join(''), 'initial Δ🧪');
  assert.deepEqual(done, completed(events).output[0]);
});

test('text standard events and truthful cumulative cache-inclusive usage', () => {
  const { stream } = fixture();
  const events = run(stream, [start(), block(0, { type: 'text', text: 'initial' }),
    delta(0, { type: 'text_delta', text: ' tail' }), stop(0), messageDelta(), messageStop]);
  const response = completed(events);
  assert.deepEqual(response.usage, { input_tokens: 18, output_tokens: 7, total_tokens: 25,
    input_tokens_details: { cached_tokens: 3, cache_write_tokens: 5 } });
  assert.deepEqual(response.anthropic_usage, { ...fullUsage, output_tokens: 7 });
  assert.equal(response.output[0].content[0].text, 'initial tail');
  assert.deepEqual(events.filter((event) => event.type.startsWith('response.output_text.')).map((event) => event.type),
    ['response.output_text.delta', 'response.output_text.delta', 'response.output_text.done']);
  assert.equal(events.find((event) => event.type === 'response.content_part.added').part.text, '');
  assert.equal(events.find((event) => event.type === 'response.content_part.done').part.text, 'initial tail');
  assert(!JSON.stringify(response.usage).includes('reasoning_tokens'));
  assert(!Object.hasOwn(response.usage, 'output_tokens_details'));
  assert(!JSON.stringify(response).includes('price'));
});

test('native function tool name/namespace restored; fragmented arguments and call ID exact', () => {
  const { stream } = fixture();
  const args = '{ "path":"漢字", "flag":true }';
  const events = run(stream, [start(), block(0, { type: 'tool_use', id: 'toolu_fixture', name: 'native_fn', input: {} }),
    delta(0, { type: 'input_json_delta', partial_json: args.slice(0, 12) }),
    delta(0, { type: 'input_json_delta', partial_json: args.slice(12) }), stop(0), messageDelta('tool_use'), messageStop]);
  const item = completed(events).output[0];
  assert.equal(item.type, 'function_call');
  assert.equal(item.call_id, 'toolu_fixture');
  assert.equal(item.name, 'inspect');
  assert.equal(item.namespace, 'functions');
  assert.equal(item.arguments, args);
  assert.equal(item.status, 'completed');
  assert.equal(events.filter((event) => event.type === 'response.function_call_arguments.delta').map((event) => event.delta).join(''), args);
  assert.equal(events.find((event) => event.type === 'response.function_call_arguments.done').arguments, args);
  assert.deepEqual(events.find((event) => event.type === 'response.output_item.done').item, item);
});

test('custom tools restore only decoded input, not native JSONwrapper fragments', () => {
  const { stream } = fixture();
  const input = '*** Begin Patch\n+漢字 🧪\n*** End Patch';
  const args = JSON.stringify({ input });
  const events = run(stream, [start(), block(0, { type: 'tool_use', id: 'toolu_custom', name: 'native_custom', input: {} }),
    delta(0, { type: 'input_json_delta', partial_json: args.slice(0, 10) }),
    delta(0, { type: 'input_json_delta', partial_json: args.slice(10) }), stop(0), messageDelta('tool_use'), messageStop]);
  const item = completed(events).output[0];
  assert.equal(item.type, 'custom_tool_call');
  assert.equal(item.name, 'apply_patch');
  assert.equal(item.namespace, 'functions');
  assert.equal(item.call_id, 'toolu_custom');
  assert.equal(item.input, input);
  assert.equal(item.status, 'completed');
  assert.equal(events.find((event) => event.type === 'response.custom_tool_call_input.delta').delta, input);
  assert.equal(events.find((event) => event.type === 'response.custom_tool_call_input.done').input, input);
  assert(!events.some((event) => event.type === 'response.function_call_arguments.delta'));
});

test('SSE decoder handles single-byte Unicode fragmentation, CRLF/CR/LF and multiline JSON', () => {
  const native = [start(), { type: 'ping' }, block(0, { type: 'thinking', thinking: '', signature: '' }),
    delta(0, { type: 'thinking_delta', thinking: '漢글 🧪' }), delta(0, { type: 'signature_delta', signature: 'sig' }),
    stop(0), messageDelta(), messageStop];
  for (const newline of ['\n', '\r\n', '\r']) {
    const text = native.map((event) => `: comment${newline}event: ${event.type}${newline}data: ${JSON.stringify(event).replace(',"delta"', `${newline}data: ,"delta"`)}${newline}${newline}`).join('');
    const decoder = new NativeSseDecoder();
    const decoded = [];
    for (const byte of Buffer.from(text)) decoded.push(...decoder.write(Buffer.from([byte])));
    decoded.push(...decoder.end());
    assert.deepEqual(decoded, native);
    const { stream } = fixture();
    const events = run(stream, decoded);
    stream.finish();
    assert.equal(completed(events).output[0].summary[0].text, '漢글 🧪');
  }
});

test('malformed SSE/UTF8/mismatched names/truncated frames fail closed with safe errors', () => {
  for (const bytes of [Buffer.from('data: [1]\n\n'), Buffer.from('data: {bad}\n\n'),
    Buffer.from('event: error\ndata: {"type":"message_stop"}\n\n'), Buffer.from([0xff])]) {
    const decoder = new NativeSseDecoder();
    assert.throws(() => decoder.write(bytes), (error) => error.code === 'invalid_upstream_event');
    assert.throws(() => decoder.write(Buffer.from('')), (error) => error.code === 'invalid_upstream_event');
  }
  for (const bytes of [Buffer.from('data: {"type":"message_stop"}\n'), Buffer.from('data: {"type":"message_stop"}'), Buffer.from([0xe6, 0xbc])]) {
    const decoder = new NativeSseDecoder();
    decoder.write(bytes);
    assert.throws(() => decoder.end(), (error) => ['incomplete_upstream_stream', 'invalid_upstream_event'].includes(error.code));
  }
});

test('unknown blocks/deltas/annotations and undeclared tool fail instead of dropping semantics', () => {
  const cases = [
    [block(0, { type: 'future_block', data: 'sentinel' })],
    [block(0, { type: 'text', text: '', citations: [] })],
    [block(0, { type: 'text', text: '' }), delta(0, { type: 'citations_delta', citation: {} })],
    [block(0, { type: 'redacted_thinking', data: 'redacted' }), delta(0, { type: 'signature_delta', signature: 'sig' })],
    [block(0, { type: 'tool_use', id: 't', name: 'undeclared', input: {} })],
    [{ type: 'future_event', data: 'sentinel' }],
  ];
  for (const native of cases) {
    const { stream } = fixture();
    const events = run(stream, [start(), ...native]);
    assertFailure(events);
    assert.equal(stream.terminal, true);
    assert.deepEqual(stream.fail('upstream_error', 'SENTINEL_SECRET'), []);
    assert.throws(() => stream.finish());
    assert(!JSON.stringify(stream.response.error).includes('sentinel'));
  }
});

test('ordering, duplicate indices/call IDs/model fallback and missing signatures are rejected', () => {
  const cases = [
    [start(fullUsage, { model: 'different-model' })], [start(), start()],
    [start(), block(1, { type: 'text', text: '' })],
    [start(), block(0, { type: 'text', text: '' }), block(1, { type: 'text', text: '' })],
    [start(), block(0, { type: 'text', text: '' }), stop(1)],
    [start(), block(0, { type: 'text', text: '' }), stop(0), block(0, { type: 'text', text: '' })],
    [start(), block(0, { type: 'thinking', thinking: '' }), stop(0)],
    [start(), block(0, { type: 'thinking', thinking: '' }), delta(0, { type: 'signature_delta', signature: 'sig' }), delta(0, { type: 'thinking_delta', thinking: 'late' })],
    [start(), block(0, { type: 'tool_use', id: 'same', name: 'native_fn', input: {} }), stop(0), block(1, { type: 'tool_use', id: 'same', name: 'native_fn', input: {} })],
    [start(), messageStop], [start(), messageDelta('refusal')], [start(), messageDelta('tool_use'), messageStop],
  ];
  for (const native of cases) { const { stream } = fixture(); assertFailure(run(stream, native)); }
});

test('tool JSON must be object; custom shape exact; nonempty initial input cannot get JSON deltas', () => {
  for (const partialJSON of ['{', 'null', '[]', '"text"', '{"input":1}', '{"input":"ok","extra":"sentinel"}']) {
    const { stream } = fixture();
    const events = run(stream, [start(), block(0, { type: 'tool_use', id: 't', name: 'native_custom', input: {} }),
      delta(0, { type: 'input_json_delta', partial_json: partialJSON }), stop(0)]);
    assertFailure(events, 'malformed_tool_input');
  }
  const { stream } = fixture();
  assertFailure(run(stream, [start(), block(0, { type: 'tool_use', id: 't', name: 'native_fn', input: { x: 1 } }),
    delta(0, { type: 'input_json_delta', partial_json: '{}' })]), 'malformed_tool_input');
});

test('native error/truncation/fail once and malformed trailing events cannot become completion', () => {
  const { stream } = fixture();
  const events = run(stream, [start(), { type: 'error', error: { type: 'SENTINEL_TYPE', message: 'SENTINEL_SECRET' } }]);
  assertFailure(events, 'upstream_error');
  assert(!JSON.stringify(stream.response.error).includes('SENTINEL'));
  assert.deepEqual(stream.fail('SENTINEL_CODE', 'SENTINEL_SECRET'), []);
  const { stream: unfinished } = fixture();
  run(unfinished, [start(), block(0, { type: 'text', text: 'partial' }), stop(0), messageDelta()]);
  assert.throws(() => unfinished.finish(), (error) => error.code === 'incomplete_upstream_stream');
  assertFailure(unfinished.fail('incomplete_upstream_stream', 'SENTINEL_SECRET'));
  const { stream: unknown } = fixture();
  assertFailure(unknown.fail('SENTINEL_CODE', 'SENTINEL_SECRET'), 'upstream_error');
  const { stream: trailing } = fixture();
  run(trailing, [start(), messageDelta(), messageStop]);
  assert.deepEqual(trailing.push({ type: 'ping' }), []);
  assert.throws(() => trailing.push(messageStop), (error) => error.code === 'invalid_upstream_event');
  assert.throws(() => trailing.finish(), (error) => error.code === 'invalid_upstream_event');
});

test('max_tokens ends as incomplete only after native message_stop; no completion event', () => {
  const { stream } = fixture();
  const events = run(stream, [start(), block(0, { type: 'thinking', thinking: '', signature: 'sig' }), stop(0), messageDelta('max_tokens')]);
  assert(!events.some((event) => event.type === 'response.completed' || event.type === 'response.incomplete'));
  const ending = stream.push(messageStop);
  assert.equal(ending[0].type, 'response.incomplete');
  assert.equal(ending[0].response.status, 'incomplete');
  assert.deepEqual(ending[0].response.incomplete_details, { reason: 'max_output_tokens' });
  assert(ending[0].response.output[0].encrypted_content);
  stream.finish();
});

test('usage missing stays null; malformed/decreasing/unsafe native counts fail', () => {
  const { stream } = fixture();
  run(stream, [start({ input_tokens: 10, output_tokens: 0 }), messageDelta(), messageStop]);
  assert.equal(stream.response.usage, null);
  assert.deepEqual(stream.response.anthropic_usage, { input_tokens: 10, output_tokens: 7 });
  for (const count of [-1, 1.5, '3', null, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const { stream: bad } = fixture();
    assertFailure(bad.push(start({ ...fullUsage, input_tokens: count })), 'invalid_upstream_usage');
  }
  const { stream: decreasing } = fixture();
  assertFailure(run(decreasing, [start({ ...fullUsage, output_tokens: 4 }), messageDelta('end_turn', { output_tokens: 3 })]), 'invalid_upstream_usage');
  const { stream: overflow } = fixture();
  assertFailure(overflow.push(start({ ...fullUsage, input_tokens: Number.MAX_SAFE_INTEGER })), 'invalid_upstream_usage');
});

test('event/block/total/framing/count bounds fail without a fabricated success', () => {
  const { stream } = fixture();
  stream.push(start());
  assertFailure(stream.push(block(0, { type: 'text', text: 'x'.repeat(1024 * 1024) })), 'upstream_limit_exceeded');
  const { stream: fragment } = fixture();
  run(fragment, [start(), block(0, { type: 'thinking', thinking: '' })]);
  let events;
  for (let index = 0; index < 11 && !fragment.terminal; index++) events = fragment.push(delta(0, { type: 'thinking_delta', thinking: 'x'.repeat(100_000) }));
  assertFailure(events, 'upstream_limit_exceeded');
  const emptyLines = new NativeSseDecoder();
  assert.throws(() => emptyLines.write(Buffer.from('data:\n'.repeat(180_000))), (error) => error.code === 'upstream_limit_exceeded');
  const huge = new NativeSseDecoder();
  assert.throws(() => huge.write(Buffer.alloc(8 * 1024 * 1024 + 1)), (error) => error.code === 'upstream_limit_exceeded');
  const { stream: many } = fixture();
  many.push(start());
  for (let index = 0; index < 512; index++) run(many, [block(index, { type: 'text', text: '' }), stop(index)]);
  assertFailure(many.push(block(512, { type: 'text', text: '' })), 'upstream_limit_exceeded');
  const { stream: total } = fixture();
  total.push(start());
  let finalEvents;
  for (let index = 0; index < 18 && !total.terminal; index++) {
    finalEvents = total.push(block(index, { type: 'text', text: 'x'.repeat(500_000) }));
    if (!total.terminal) total.push(stop(index));
  }
  assertFailure(finalEvents, 'upstream_limit_exceeded');
});

test('codec exceptions/invalid opaque are sanitized and never emit reasoning done or completion', () => {
  for (const seal of [() => { throw new Error('SENTINEL_CREDENTIAL'); }, () => '', () => ({ secret: 'SENTINEL_CREDENTIAL' })]) {
    const { options } = fixture();
    const stream = new ResponsesStream({ ...options, seal });
    const events = run(stream, [start(), block(0, { type: 'thinking', thinking: '', signature: 'sig' }), stop(0)]);
    assertFailure(events, 'reasoning_state_error');
    assert(!events.some((event) => event.type === 'response.output_item.done'));
    assert(!JSON.stringify(stream.response.error).includes('SENTINEL_CREDENTIAL'));
  }
});

test('nonstream conversion shares exact reasoning/tool/usage semantics and rejects unsupported blocks', () => {
  const { options, sealed } = fixture();
  const message = { id: 'msg_native_fixture', type: 'message', role: 'assistant', model, stop_reason: 'tool_use', stop_sequence: null,
    content: [{ type: 'thinking', thinking: '', signature: 'sig', cache_control: { type: 'ephemeral' } },
      { type: 'redacted_thinking', data: 'redacted' }, { type: 'text', text: 'hello' },
      { type: 'tool_use', id: 'call1', name: 'native_custom', input: { input: 'custom text' } }], usage: { ...fullUsage, output_tokens: 7 } };
  const before = structuredClone(message);
  const result = convertNativeMessage(message, options);
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.output.map((item) => item.type), ['reasoning', 'reasoning', 'message', 'custom_tool_call']);
  assert.deepEqual(sealed.map((entry) => entry.block), message.content.slice(0, 2));
  assert.equal(result.output[3].input, 'custom text');
  assert.equal(result.output[3].namespace, 'functions');
  assert.deepEqual(message, before);
  assert.throws(() => convertNativeMessage({ ...message, content: [{ type: 'future' }] }, options));
});
