import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CODEX_APPLY_PATCH_GRAMMAR as grammar, CODEX_APPLY_PATCH_ENVIRONMENT_GRAMMAR as environmentGrammar,
  recognizePatchGrammar, validPatchInput, MAX_PATCH_BYTES } from '../dist/services/responsesPatchGrammar.js';
import { prepareResponsesRequest } from '../dist/services/responsesRequest.js';
import { ResponsesStream, convertNativeMessage } from '../dist/services/responsesStream.js';

const model = 'synthetic-grammar-model';
const options = { context: { model, principal: 'fixture', upstream: 'fixture' },
  codec: { seal() { throw new Error('Not used'); }, open() { throw new Error('Not used'); } },
  defaultMaxTokens: 8192, defaultThinkingBudget: 1024, applyPatchMode: 'validated' };
const definition = (value = grammar) => ({ type: 'custom', name: 'apply_patch', description: 'Original tool instructions',
  format: { type: 'grammar', syntax: 'lark', definition: value } });
const prepare = (extra = {}, config = options) => prepareResponsesRequest({ model, input: 'synthetic patch fixture', tools: [definition()], ...extra }, config);
const wrap = (hunks, finalLF = '') => `*** Begin Patch\n${hunks}*** End Patch${finalLF}`;
const patch = wrap('*** Add File: fixture.txt\n+한글 🧪\n+\n', '\n');
const valid = [patch, wrap('*** Delete File: a\n'), wrap('*** Update File: a\n'),
  wrap('*** Update File: a\n*** Move to: b\n'), wrap('*** Update File: a\n@@\n'),
  wrap('*** Update File: a\n@@ where\n-old\n+new\n context\n*** End of File\n'),
  wrap('*** Add File: a\n+*** End Patch\n*** Delete File: b\n*** Update File: c\n \n'),
  wrap('*** Update File: a\n@@ \r\n+\r\n+\u2028\n+\u2029\n'),
  wrap('*** Delete File: \r\n'), wrap('*** Delete File: \u2028\n')];
const invalid = ['', '*** Begin Patch\n*** End Patch', patch + '\n', ' ' + patch, patch + 'suffix',
  patch.replaceAll('\n', '\r\n'), wrap('*** Add File: a\n'), wrap('*** Add File: \n+x\n'),
  wrap('*** Add File: a\n+x'), wrap('*** Add File: a\n x\n'), wrap('*** Delete File: a\n+x\n'),
  wrap('*** Update File: a\n*** Move to: \n'), wrap('*** Update File: a\n*** End of File\n'),
  wrap('*** Update File: a\n@@ \n'), wrap('*** Update File: a\n@@bad\n'),
  wrap('*** Update File: a\n+one\n*** End of File\n+late\n'),
  wrap('*** Unknown File: a\n'), wrap('*** Update File: a\n*** Move to: b\n*** Move to: c\n')];

test('recognizes only exact pinned apply_patch grammar and optional environment variant', () => {
  assert.equal(recognizePatchGrammar('apply_patch', 'lark', grammar), 'codex_apply_patch');
  assert.equal(recognizePatchGrammar('apply_patch', 'lark', environmentGrammar), 'codex_apply_patch_environment');
  assert.equal(recognizePatchGrammar('apply_patch', 'lark', grammar.replaceAll('\n', '\r\n')), 'codex_apply_patch');
  assert.equal(recognizePatchGrammar('apply_patch', 'lark', environmentGrammar.replaceAll('\n', '\r\n')), 'codex_apply_patch_environment');
  for (const args of [['other', 'lark', grammar], ['apply_patch', 'regex', grammar],
    ['apply_patch', 'lark', grammar + ' '], ['apply_patch', 'lark', grammar.replace('hunk+', 'hunk*')],
    ['apply_patch', 'lark', grammar.replace('\n', '\r\n')], ['apply_patch', 'lark', null]]) {
    assert.equal(recognizePatchGrammar(...args), undefined);
  }
});

test('pinned grammar accepts its full line forms without patch/path execution or normalization', () => {
  for (const input of valid) assert.equal(validPatchInput(input, 'codex_apply_patch'), true, JSON.stringify(input));
  for (const input of invalid) assert.equal(validPatchInput(input, 'codex_apply_patch'), false, JSON.stringify(input));
  const env = patch.replace('*** Begin Patch\n', '*** Begin Patch\n*** Environment ID: fixture\n');
  assert.equal(validPatchInput(env, 'codex_apply_patch'), false);
  assert.equal(validPatchInput(env, 'codex_apply_patch_environment'), true);
  assert.equal(validPatchInput(patch, 'codex_apply_patch_environment'), true);
  for (const id of ['', 'a\n*** Environment ID: second']) {
    assert.equal(validPatchInput(patch.replace('*** Begin Patch\n', `*** Begin Patch\n*** Environment ID: ${id}\n`), 'codex_apply_patch_environment'), false);
  }
  // These are syntactically legal filenames. Authorization belongs to the client,
  // not this non-executing recognizer. No filesystem operation is performed here.
  for (const name of ['../outside', '/absolute', 'C:\\absolute', 'a\u0000b']) {
    assert.equal(validPatchInput(wrap(`*** Delete File: ${name}\n`), 'codex_apply_patch'), true);
  }
});

test('patch byte bound is exact and Unicode counts as UTF8, not UTF16 characters', () => {
  const base = wrap('*** Add File: a\n+\n');
  const available = MAX_PATCH_BYTES - Buffer.byteLength(base);
  assert.equal(validPatchInput(base.replace('+\n', '+' + 'x'.repeat(available) + '\n'), 'codex_apply_patch'), true);
  assert.equal(validPatchInput(base.replace('+\n', '+' + 'x'.repeat(available + 1) + '\n'), 'codex_apply_patch'), false);
  assert.equal(validPatchInput(base.replace('+\n', '+' + '🧪'.repeat(Math.floor(available / 4) + 1) + '\n'), 'codex_apply_patch'), false);
});

test('default rejection, explicit mode, exact schema description and namespace mapping', () => {
  assert.throws(() => prepare({}, { ...options, applyPatchMode: undefined }), e => e.code === 'unsupported_tool');
  assert.throws(() => prepare({}, { ...options, applyPatchMode: 'reject' }), e => e.code === 'unsupported_tool');
  const tool = definition();
  const prepared = prepare({ tools: [{ type: 'namespace', name: 'functions', tools: [tool] }] });
  const native = prepared.nativeBody.tools[0];
  assert.match(native.name, /^ns_[0-9a-f]{60}$/);
  assert.equal(prepared.tools.get(native.name).grammar, 'codex_apply_patch');
  assert(native.description.startsWith(tool.description + '\n\n'));
  assert(native.description.includes('Transport note:'));
  assert(native.input_schema.properties.input.description.endsWith(grammar));
  assert.deepEqual(native.input_schema.required, ['input']);
  assert.equal(native.input_schema.additionalProperties, false);
  assert.deepEqual(tool, definition());
  const windowsDefinition = grammar.replaceAll('\n', '\r\n');
  const windows = prepare({ tools: [definition(windowsDefinition)] });
  assert(windows.nativeBody.tools[0].input_schema.properties.input.description.endsWith(windowsDefinition));
  for (const format of [{ ...tool.format, definition: grammar + '\n' }, { ...tool.format, extra: true },
    { ...tool.format, syntax: 'regex' }, { type: 'grammar' }]) {
    assert.throws(() => prepare({ tools: [{ ...tool, format }] }));
  }
});

function native(input) {
  return { id: 'msg_fixture', type: 'message', role: 'assistant', model,
    content: [{ type: 'tool_use', id: 'call_patch', name: 'apply_patch', input: { input } }],
    stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
}
const streamOptions = () => ({ model, tools: prepare().tools, seal: options.codec.seal });

test('nonstream and historical grammar input round-trip unchanged, invalid history fails before upstream', () => {
  const response = convertNativeMessage(native(patch), streamOptions());
  assert.equal(response.output[0].input, patch);
  const replay = prepare({ input: [{ role: 'user', content: 'apply fixture patch' }, ...response.output,
    { type: 'custom_tool_call_output', call_id: 'call_patch', output: 'fixture result' }] });
  assert.deepEqual(replay.nativeBody.messages[1].content, native(patch).content);
  for (const input of invalid) {
    assert.throws(() => convertNativeMessage(native(input), streamOptions()), e => e.code === 'invalid_tool_grammar' && e.status === 502);
    assert.throws(() => prepare({ input: [{ role: 'user', content: 'fixture' }, { ...response.output[0], input },
      { type: 'custom_tool_call_output', call_id: 'call_patch', output: 'fixture result' }] }), e => e.code === 'invalid_tool_history');
  }
});

test('removed custom-tool definitions do not imply historical grammar or permission for a new patch', () => {
  const raw = 'opaque historical text, not a valid patch';
  const input = [{ role: 'user', content: 'fixture' },
    { type: 'custom_tool_call', call_id: 'call_patch', name: 'apply_patch', input: raw },
    { type: 'custom_tool_call_output', call_id: 'call_patch', output: 'historical result' }];
  const compact = prepare({ tools: [], input }, { ...options, applyPatchMode: 'reject' });
  assert.deepEqual(compact.nativeBody.messages[1].content, native(raw).content);
  assert.equal(compact.tools.size, 0);
  assert.equal(Object.hasOwn(compact.nativeBody, 'tools'), false);
  assert.throws(() => prepare({ input }), e => e.code === 'invalid_tool_history');
  assert.throws(() => convertNativeMessage(native(patch), { model, tools: compact.tools, seal: options.codec.seal }),
    e => e.code === 'unknown_upstream_tool');
});

test('stream buffers all grammar input until validated; invalid input never emits executable done', () => {
  for (const input of [patch, ...invalid]) {
    const stream = new ResponsesStream(streamOptions());
    const message = native(input);
    const events = [...stream.push({ type: 'message_start', message: { ...message, content: [], stop_reason: null } }),
      ...stream.push({ type: 'content_block_start', index: 0, content_block: { ...message.content[0], input: {} } })];
    const encoded = JSON.stringify({ input });
    for (let i = 0; i < encoded.length; i += 3) {
      events.push(...stream.push({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: encoded.slice(i, i + 3) } }));
    }
    assert(!events.some(e => e.type.includes('custom_tool_call_input') || e.type === 'response.output_item.done'));
    events.push(...stream.push({ type: 'content_block_stop', index: 0 }));
    if (input === patch) {
      assert.equal(events.find(e => e.type === 'response.custom_tool_call_input.done').input, patch);
      assert.equal(events.find(e => e.type === 'response.custom_tool_call_input.delta').delta, patch);
      assert.equal(events.find(e => e.type === 'response.output_item.done').item.input, patch);
    } else {
      assert.equal(events.at(-1).type, 'response.failed');
      assert.equal(events.at(-1).response.error.code, 'invalid_tool_grammar');
      assert(!events.some(e => e.type.includes('custom_tool_call_input') || e.type === 'response.output_item.done' || e.type === 'response.completed'));
      assert.equal(events.at(-1).response.output[0].input, '');
      assert(!JSON.stringify(events.at(-1).response.error).includes(input || 'PRIVATE'));
    }
  }
});

test('EOF or cancellation with buffered grammar JSON never emits input or executable done', () => {
  for (const encoded of [JSON.stringify({input: patch}), '{"input":"*** Begin Patch']) {
    for (const ending of ['eof', 'cancelled']) {
      const stream = new ResponsesStream(streamOptions());
      const message = native(patch);
      const events = [...stream.push({type:'message_start', message:{...message,content:[],stop_reason:null}}),
        ...stream.push({type:'content_block_start',index:0,content_block:{...message.content[0],input:{}}}),
        ...stream.push({type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:encoded}})];
      if (ending === 'eof') assert.throws(() => stream.finish(), e => e.code === 'incomplete_upstream_stream');
      events.push(...stream.fail(ending === 'eof' ? 'incomplete_upstream_stream' : 'cancelled', 'PRIVATE_DIAGNOSTIC'));
      assert.equal(events.at(-1).type, 'response.failed');
      assert(!events.some(e => e.type.includes('custom_tool_call_input') || e.type === 'response.output_item.done' || e.type === 'response.completed'));
      assert.equal(events.at(-1).response.output[0].input, '');
      assert(!JSON.stringify(events.at(-1).response.error).includes('PRIVATE_DIAGNOSTIC'));
    }
  }
});
