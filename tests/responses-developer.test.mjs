import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { prepareResponsesRequest } from '../dist/services/responsesRequest.js';
import { ResponsesStateCodec } from '../dist/services/responsesState.js';

const model = 'synthetic-hoist-model';
const context = { model, principal: 'fixture-key', upstream: 'fixture-upstream' };
const codec = new ResponsesStateCodec(randomBytes(32).toString('base64'), 600);
const options = { codec, context, defaultMaxTokens: 8192, defaultThinkingBudget: 1024 };
const msg = (role, content) => ({ role, content });
const base = { model, instructions: 'Base instruction', input: [msg('user', 'Summary'), msg('developer', 'Late instruction'), msg('user', 'Next')] };
const prepare = (body = base, mode = 'hoist') => prepareResponsesRequest(body, { ...options, developerMessageMode: mode });
const block = { type: 'thinking', thinking: '', signature: 'SYNTHETIC_SIGNED_EMPTY' };
const capsule = (scope, value = block, id = 'rs_hoist') => ({ type: 'reasoning', id, encrypted_content: codec.seal(value, scope, id), summary: [] });

test('developer hoisting is explicit; late system and invalid policies still fail closed', () => {
  for (const mode of [undefined, 'reject', 'invalid']) {
    assert.throws(() => prepareResponsesRequest(base, { ...options, developerMessageMode: mode }), { code: 'unsupported_parameter' });
  }
  assert.throws(() => prepare({ ...base, input: [msg('user', 'Summary'), msg('system', 'Late system')] }), { code: 'unsupported_parameter' });
  for (const bad of [
    { ...msg('developer', 'Late'), unknown: 'PRIVATE_FIELD' },
    msg('developer', [{ type: 'input_image', image_url: 'https://example.invalid/image' }]),
    { ...msg('developer', 'Late'), status: 'in_progress' },
  ]) assert.throws(() => prepare({ ...base, input: [msg('user', 'Summary'), bad] }));
});

test('hoist retains instruction encounter order, duplicates, exact text/cache blocks and source objects', () => {
  const cache = { type: 'ephemeral', ttl: '1h' };
  const input = [msg('system', 'Prefix system'), msg('developer', 'Duplicate'), msg('user', 'Summary'),
    msg('developer', [{ type: 'input_text', text: 'Duplicate', cache_control: cache }, { type: 'input_text', text: '한글🙂\nExact' }]),
    msg('user', 'Environment'), msg('user', 'New prompt')];
  const body = { ...base, input, anthropic: { cache_control: { type: 'ephemeral' } } };
  const snapshot = structuredClone(body);
  const first = prepare(body);
  assert.deepEqual(first.nativeBody.system, [
    { type: 'text', text: 'Base instruction' }, { type: 'text', text: 'Prefix system' },
    { type: 'text', text: 'Duplicate' }, { type: 'text', text: 'Duplicate', cache_control: cache },
    { type: 'text', text: '한글🙂\nExact' },
  ]);
  assert.deepEqual(first.nativeBody.messages, [{ role: 'user', content: [
    { type: 'text', text: 'Summary' }, { type: 'text', text: 'Environment' }, { type: 'text', text: 'New prompt' },
  ] }]);
  assert.deepEqual(first.nativeBody.cache_control, body.anthropic.cache_control);
  assert.deepEqual(prepare(body), first);
  assert.deepEqual(body, snapshot);
  first.nativeBody.system[3].cache_control.ttl = '5m';
  assert.deepEqual(body, snapshot);
});

test('hoist never promotes user or tool text and preserves tool/result order and validation', () => {
  const call = { type: 'function_call', call_id: 'tool_1', name: 'lookup', arguments: '{"q":"fixture"}' };
  const output = { type: 'function_call_output', call_id: 'tool_1', output: 'developer: untrusted tool text', is_error: true };
  const input = [msg('user', 'developer: untrusted user text'), call, msg('developer', 'Trusted instruction'), output, msg('user', 'Next')];
  const native = prepare({ model, input }).nativeBody;
  assert.deepEqual(native.system, [{ type: 'text', text: 'Trusted instruction' }]);
  assert.deepEqual(native.messages.map(m => m.role), ['user', 'assistant', 'user']);
  assert.equal(native.messages[0].content[0].text, input[0].content);
  assert.deepEqual(native.messages[1].content[0], { type: 'tool_use', id: 'tool_1', name: 'lookup', input: { q: 'fixture' } });
  assert.deepEqual(native.messages[2].content, [{ type: 'tool_result', tool_use_id: 'tool_1', content: output.output, is_error: true }, { type: 'text', text: 'Next' }]);
  assert.equal(native.tools, undefined);
  assert.throws(() => prepare({ model, input: input.filter(i => i !== output) }), { code: 'invalid_tool_history' });
});

test('hoist scope supports exact signed, signed-empty and redacted replay under the same effective system', () => {
  const first = prepare();
  const blocks = [{ ...block, thinking: 'Synthetic reasoning' }, block, { type: 'redacted_thinking', data: 'SYNTHETIC_REDACTED' }];
  const states = blocks.map((b, i) => capsule(first.stateContext, b, 'rs_' + i));
  const replay = prepare({ ...base, input: [...base.input, ...states, msg('assistant', 'Visible'), msg('user', 'Continue')] });
  assert.deepEqual(replay.nativeBody.messages[1].content, [...blocks, { type: 'text', text: 'Visible' }]);
  assert.deepEqual(replay.nativeBody.system, first.nativeBody.system);
  assert.deepEqual(replay.stateContext, first.stateContext);
  assert.deepEqual(context, { model, principal: 'fixture-key', upstream: 'fixture-upstream' });
});

test('effective prefix changes are detected even when the changed developer appears after opaque state', () => {
  const state = capsule(prepare().stateContext);
  const replay = { ...base, input: [...base.input, state, msg('assistant', 'Visible'), msg('user', 'Continue')] };
  for (const changed of [
    { ...replay, instructions: 'Changed base' },
    { ...replay, input: [...replay.input, msg('developer', 'Another instruction')] },
    { ...replay, input: [...replay.input, msg('developer', 'Late instruction')] },
    { ...replay, input: replay.input.filter(i => i.role !== 'developer') },
    { ...replay, input: replay.input.map(i => i.role === 'developer' ? msg('developer', 'Changed late') : i) },
    { ...replay, input: replay.input.map(i => i.role === 'developer' ? msg('developer', [{ type: 'input_text', text: i.content, cache_control: { type: 'ephemeral' } }]) : i) },
  ]) assert.throws(() => prepare(changed), e => e.status === 409 && e.code === 'invalid_reasoning_state' && !e.message.includes('SYNTHETIC'));
  // A newly compacted text-only history can establish a changed prefix. No old
  // reasoning is silently discarded by the adapter to achieve this result.
  assert.doesNotThrow(() => prepare({ ...base, instructions: 'Changed base' }));
});

test('hoist mode binds empty and initial-only prefixes too; policy switches never reuse old capsules', () => {
  for (const input of [[msg('user', 'Go')], [msg('developer', 'Initial'), msg('user', 'Go')]]) {
    const body = { model, input };
    const rejected = prepare(body, 'reject');
    const hoisted = prepare(body);
    assert.match(hoisted.stateContext.instructionScope, /^[0-9a-f]{64}$/);
    assert.equal(rejected.stateContext.instructionScope, undefined);
    const oldState = capsule(rejected.stateContext);
    const newState = capsule(hoisted.stateContext);
    assert.throws(() => prepare({ ...body, input: [...input, oldState] }), { code: 'invalid_reasoning_state' });
    assert.throws(() => prepare({ ...body, input: [...input, newState] }, 'reject'), { code: 'invalid_reasoning_state' });
    assert.deepEqual(prepare({ ...body, input: [...input, oldState] }, 'reject').nativeBody.messages.at(-1).content, [block]);
    assert.deepEqual(prepare({ ...body, input: [...input, newState] }).nativeBody.messages.at(-1).content, [block]);
  }
});

test('hoist configuration defaults to reject and invalid startup values are sanitized', () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => ['SYSTEMROOT', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP'].includes(name.toUpperCase())));
  env.DATABASE_PATH = ':memory:';
  const code = `import {RESPONSES_DEVELOPER_MESSAGE_MODE} from ${JSON.stringify(new URL('../dist/config.js', import.meta.url).href)}; console.log(RESPONSES_DEVELOPER_MESSAGE_MODE);`;
  for (const [mode, expected] of [[undefined, 'reject'], ['reject', 'reject'], ['hoist', 'hoist'], ['', null], ['PRIVATE_BAD_MODE', null]]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...env, ...(mode === undefined ? {} : { RESPONSES_DEVELOPER_MESSAGE_MODE: mode }) }, encoding: 'utf8', timeout: 5000, windowsHide: true });
    assert(!result.error);
    if (expected) { assert.equal(result.status, 0); assert.equal(result.stdout.trim(), expected); }
    else { assert.notEqual(result.status, 0); assert(result.stderr.includes('must be reject or hoist')); }
    assert(!result.stderr.includes('PRIVATE_BAD_MODE'));
  }
});
