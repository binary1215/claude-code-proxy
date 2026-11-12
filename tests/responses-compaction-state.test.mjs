import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { ResponsesCompactionStateCodec } from '../dist/services/responsesCompactionState.js';
import { ResponsesStateCodec } from '../dist/services/responsesState.js';
import { prepareResponsesCompactionRequest, prepareResponsesRequest } from '../dist/services/responsesRequest.js';

const key = randomBytes(32).toString('base64');
const model = 'synthetic-compact-model';
const context = { model, principal: 'fixture-principal', upstream: 'fixture-upstream' };
const codec = new ResponsesStateCodec(key, 600);
const compactionCodec = new ResponsesCompactionStateCodec(key, 600);
const options = { codec, compactionCodec, context, defaultMaxTokens: 8192, defaultThinkingBudget: 1024 };
const message = (role, text) => ({ role, content: text });
const native = (role, ...content) => ({ role, content });
const text = value => ({ type: 'text', text: value });
const state = { messages: [native('user', text('Actual compacted context fixture')), native('assistant',
  { type: 'thinking', thinking: '', signature: 'signed-fixture+/=', cache_control: { type: 'ephemeral', ttl: '1h' } },
  { type: 'redacted_thinking', data: 'redacted-fixture+/=' }, text('Retained answer'))], historyTools: [] };
const item = (value = state, bound = context, id = 'cmp_fixture', selected = compactionCodec) => ({ type: 'compaction', id,
  encrypted_content: selected.seal(value, bound, id) });
const prepare = input => prepareResponsesRequest({ model, input }, options);

test('separate bounded compaction capsules restore exact native blocks after process restart and omit public ID', () => {
  const sealed = compactionCodec.seal(state, context, 'cmp_cold');
  assert(sealed.startsWith('ccpc1.'));
  assert(!sealed.includes('signed-fixture'));
  const fresh = new ResponsesCompactionStateCodec(key, 600);
  assert.deepEqual(fresh.open(sealed, context), { itemId: 'cmp_cold', state });
  assert.deepEqual(fresh.open(sealed, context, 'cmp_cold'), { itemId: 'cmp_cold', state });
  assert.notEqual(compactionCodec.seal(state, context, 'cmp_cold'), sealed);
  assert.throws(() => codec.open(sealed, context), { code: 'invalid_reasoning_state' });
  assert.throws(() => fresh.open(codec.seal(state.messages[1].content[0], context, 'rs_fixture'), context), { code: 'invalid_compaction_state' });
  const replay = prepareResponsesRequest({ model, input: [{ type: 'compaction', encrypted_content: sealed }, message('user', 'Continue')] }, { ...options, compactionCodec: fresh });
  assert.deepEqual(replay.nativeBody.messages, [...state.messages, native('user', text('Continue'))]);
  assert.equal(replay.nativeBody.system, undefined);
});

test('compaction rejects tampering, foreign ciphertext, identity changes, rotation and wrong item IDs', () => {
  const sealed = item().encrypted_content;
  for (const changed of [sealed.slice(0, -8) + 'ABCDEFGH', sealed + '=', 'gAAAAforeign', sealed.replace('ccpc1.', 'ccpr2.'), '', 'ccpc1.**']) {
    assert.throws(() => compactionCodec.open(changed, context), { code: 'invalid_compaction_state' });
  }
  for (const changed of [{ ...context, model: 'other' }, { ...context, principal: 'other' }, { ...context, upstream: 'other' }]) {
    assert.throws(() => compactionCodec.open(sealed, changed), { code: 'invalid_compaction_state' });
  }
  assert.throws(() => compactionCodec.open(sealed, context, 'cmp_other'), { code: 'invalid_compaction_state' });
  assert.throws(() => new ResponsesCompactionStateCodec(randomBytes(32).toString('base64'), 600).open(sealed, context), { code: 'invalid_compaction_state' });
  assert.throws(() => prepare([item(), message('user', 'Next')].map(value => value.type === 'compaction' ? { ...value, id: 'cmp_wrong' } : value)), { code: 'invalid_compaction_state' });
});

test('expiry, future state, malformed identity/history and decoded/wire bounds are explicit', () => {
  let now = 1_000_000;
  const timed = new ResponsesCompactionStateCodec(key, 60, () => now);
  const sealed = timed.seal(state, context, 'cmp_clock');
  now += 61_000;
  assert.throws(() => timed.open(sealed, context), { code: 'invalid_compaction_state' });
  now = 800_000;
  assert.throws(() => timed.open(sealed, context), { code: 'invalid_compaction_state' });
  for (const id of ['', null, 1, 'x'.repeat(257)]) assert.throws(() => timed.seal(state, context, id), { code: 'invalid_compaction_state' });
  for (const malformed of [{ messages: [] }, { messages: [native('system', text('Not an instruction'))] }, { messages: [native('user', 'not a block')] }]) {
    assert.throws(() => timed.seal(malformed, context, 'cmp_bad'), { code: 'invalid_compaction_state' });
  }
  assert.throws(() => timed.seal({ messages: [native('user', text('x'.repeat(7 * 1024 * 1024)))] }, context, 'cmp_large'), { code: 'compaction_state_too_large' });
  assert.throws(() => timed.open('ccpc1.' + 'A'.repeat(10 * 1024 * 1024), context), { code: 'invalid_compaction_state' });
  assert.throws(() => new ResponsesCompactionStateCodec('invalid', 600));
  assert.throws(() => new ResponsesCompactionStateCodec(key, 0));
});

test('newest capsule replaces earlier conversational history without opening superseded state or duplicating text', () => {
  const replay = prepare([message('user', 'Old full transcript'), { type: 'reasoning', encrypted_content: 'expired-old-state' },
    { type: 'compaction', encrypted_content: 'expired-old-capsule' }, message('assistant', 'Old discarded answer'), item(), message('user', 'New question')]);
  assert.deepEqual(replay.nativeBody.messages, [...state.messages, native('user', text('New question'))]);
  assert(!JSON.stringify(replay.nativeBody).includes('discarded'));
  const next = prepareResponsesCompactionRequest({ model, input: [item(), message('user', 'New question'), message('assistant', 'New answer')] }, options);
  const again = item({ messages: [native('user', text('Second actual reduced context fixture'))], historyTools: next.historyTools }, next.stateContext, 'cmp_again');
  const secondReplay = prepare([item(), message('user', 'New question'), again, message('user', 'Newest question')]);
  assert.deepEqual(secondReplay.nativeBody.messages, [native('user', text('Second actual reduced context fixture'), text('Newest question'))]);
});

test('canonical instruction items remain visible and bind unchanged effective instructions in hoist mode', () => {
  const hoist = { ...options, developerMessageMode: 'hoist' };
  const input = [message('system', 'System prefix'), message('user', 'Earlier request'),
    { type: 'message', id: 'developer_fixture', role: 'developer', content: [{ type: 'input_text', text: 'Keep constraints', cache_control: { type: 'ephemeral' } }] },
    message('assistant', 'Answer to compact')];
  const prepared = prepareResponsesCompactionRequest({ model, instructions: 'Separate instruction', input }, hoist);
  assert.deepEqual(prepared.instructionItems, [input[0], input[2]]);
  const output = [...prepared.instructionItems, item(state, prepared.stateContext)];
  const replay = prepareResponsesRequest({ model, instructions: 'Separate instruction', input: [...output, message('user', 'Continue')] }, hoist);
  assert.deepEqual(replay.nativeBody.system, prepared.nativeBody.system);
  assert.deepEqual(replay.nativeBody.messages, [...state.messages, native('user', text('Continue'))]);
  for (const changed of [undefined, 'Changed instruction']) {
    assert.throws(() => prepareResponsesRequest({ model, instructions: changed ?? null, input: [...output, message('user', 'Continue')] }, hoist), { code: 'invalid_compaction_state' });
  }
  assert.throws(() => prepareResponsesRequest({ model, instructions: 'Separate instruction', input: [output[1], output[2], message('user', 'Continue')] }, hoist), { code: 'invalid_compaction_state' });
  assert.equal(replay.nativeBody.system.some(block => block.text.includes('Actual compacted')), false);
  assert.throws(() => prepare([message('user', 'Old'), message('system', 'Late system'), item(), message('user', 'Continue')]), { code: 'unsupported_parameter' });
});

test('compaction accepts assistant-ended history without tools and preserves pending function/custom identities for replay', () => {
  const assistantEnded = prepareResponsesCompactionRequest({ model, input: [message('user', 'Ask'), message('assistant', 'Answer')] }, options);
  assert.equal(assistantEnded.nativeBody.messages.at(-1).role, 'assistant');
  const calls = [{ type: 'function_call', name: 'lookup', call_id: 'call_fn', arguments: '{"path":"fixture"}' },
    { type: 'custom_tool_call', name: 'apply_patch', namespace: 'functions', call_id: 'call_custom', input: 'raw fixture' }];
  const pending = prepareResponsesCompactionRequest({ model, input: [message('user', 'Ask'), ...calls] }, options);
  assert.equal(pending.tools.size, 0);
  assert.equal(pending.nativeBody.tools, undefined);
  assert.equal(pending.historyTools.length, 2);
  const compacted = item({ messages: pending.nativeBody.messages, historyTools: pending.historyTools });
  assert.throws(() => prepare([compacted]), { code: 'invalid_tool_history' });
  assert.throws(() => prepare([compacted, message('user', 'Skip results')]), { code: 'invalid_tool_history' });
  assert.throws(() => prepare([compacted, { type: 'function_call_output', call_id: 'call_custom', output: 'Wrong kind' }]), { code: 'invalid_tool_history' });
  const outputs = [{ type: 'function_call_output', call_id: 'call_fn', output: 'Found' },
    { type: 'custom_tool_call_output', call_id: 'call_custom', output: 'Applied', is_error: false }];
  const replay = prepare([compacted, ...outputs, message('user', 'Continue')]);
  assert.deepEqual(replay.nativeBody.messages.slice(0, 2), pending.nativeBody.messages);
  assert.equal(replay.nativeBody.messages[2].content[0].tool_use_id, 'call_fn');
  assert.equal(replay.nativeBody.messages[2].content[1].tool_use_id, 'call_custom');
  assert.equal(replay.tools.size, 0);
  const complete = prepareResponsesCompactionRequest({ model, input: [compacted, ...outputs, message('assistant', 'Done')] }, options);
  const final = item({ messages: complete.nativeBody.messages, historyTools: complete.historyTools }, context, 'cmp_complete');
  assert.deepEqual(prepare([final, message('user', 'Next')]).nativeBody.messages.slice(0, -1), complete.nativeBody.messages);
});

test('compaction retains existing supported-request validation and rejects malformed replay histories', () => {
  assert.throws(() => prepareResponsesCompactionRequest({ model, input: 'History', stream: true }, options), { code: 'unsupported_parameter' });
  assert.throws(() => prepareResponsesCompactionRequest({ model, input: 'History', previous_response_id: 'server_state' }, options), { code: 'unsupported_parameter' });
  assert.throws(() => prepareResponsesRequest({ model, input: [item(), message('user', 'Next')] }, { ...options, compactionCodec: undefined }), { code: 'invalid_compaction_state' });
  const orphan = item({ messages: [native('user', { type: 'tool_result', tool_use_id: 'missing', content: 'Invalid' })] });
  assert.throws(() => prepare([orphan, message('user', 'Next')]), { code: 'invalid_tool_history' });
  const missingBinding = item({ messages: [native('assistant', { type: 'tool_use', id: 'unbound', name: 'lookup', input: {} })] });
  assert.throws(() => prepare([missingBinding, { type: 'function_call_output', call_id: 'unbound', output: 'Invalid' }]), { code: 'invalid_tool_history' });
});
