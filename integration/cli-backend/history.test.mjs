import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeHistoryEntries, nativeHistoryStore, HISTORY_CLI_VERSION } from './history.mjs';
import { nativeToolName, createToolRegistry } from './helpers.mjs';

function history() {
  return [
    { role: 'user', content: [{ type: 'text', text: 'Caller-authored compacted summary. 한글' }] },
    { role: 'assistant', content: [
      { type: 'thinking', thinking: '', signature: 'opaque-signed-empty' },
      { type: 'redacted_thinking', data: 'opaque-redacted-data' },
      { type: 'tool_use', id: 'toolu_historical', name: 'removed_tool', input: { z: 2, a: ['original'] } },
    ] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_historical', content: 'Actual caller result.', is_error: true }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Prior assistant role remains an assistant.' }] },
    { role: 'user', content: 'Latest caller instruction.' },
  ];
}

test('pinned native import preserves roles, signed/redacted content, IDs and original historical tool arguments', () => {
  const original = history(), before = structuredClone(original);
  const snapshot = nativeHistoryEntries(original, { model: 'fixture-model', cwd: '/owned/workspace' });
  assert.deepEqual(original, before);
  assert.deepEqual(snapshot.entries.map(entry => entry.message.role), original.map(message => message.role));
  const assistant = snapshot.entries[1];
  assert.deepEqual(assistant.message.content.slice(0, 2), original[1].content.slice(0, 2));
  assert.deepEqual(assistant.message.content[2], { ...original[1].content[2], name: nativeToolName('removed_tool'), input: { input: original[1].content[2].input } });
  assert.deepEqual(snapshot.entries[2].message.content, original[2].content);
  assert.equal(assistant.message.model, 'fixture-model');
  assert.equal(assistant.message.type, 'message');
  assert.equal(assistant.requestedModel, 'fixture-model');
  assert.equal(assistant.version, HISTORY_CLI_VERSION);
  assert.equal(Object.hasOwn(assistant.message, 'usage'), false, 'Unknown historical token counters must not be fabricated');
  assert.equal(snapshot.entries[0].parentUuid, null);
  snapshot.entries.slice(1).forEach((entry, index) => assert.equal(entry.parentUuid, snapshot.entries[index].uuid));
  assert.ok(snapshot.entries.every(entry => entry.sessionId === snapshot.sessionId));
  const current = createToolRegistry([{ name: 'current_tool', input_schema: { type: 'object' } }]);
  assert.equal(current.byOriginal.has('removed_tool'), false, 'Replayed tools are not re-registered for execution');
});

test('all supplied tool results must load with their original calls so resume cannot substitute interruption placeholders', () => {
  const source = history();
  assert.throws(() => nativeHistoryEntries(source.slice(0, 2), { model: 'fixture', cwd: '/owned' }), { code: 'invalid_history' });
  source[2].content[0].tool_use_id = 'foreign_id';
  assert.throws(() => nativeHistoryEntries(source, { model: 'fixture', cwd: '/owned' }), { code: 'invalid_history' });
  const complete = nativeHistoryEntries(history().slice(0, 3), { model: 'fixture', cwd: '/owned' });
  assert.equal(complete.entries.at(-1).message.content[0].content, 'Actual caller result.');
});

test('import-only SessionStore loads exact entries by scoped session ID and keeps no external append mirror', async () => {
  const snapshot = nativeHistoryEntries(history(), { model: 'fixture', cwd: '/owned' });
  const store = nativeHistoryStore(snapshot);
  assert.equal(await store.load({ sessionId: 'foreign' }), null);
  const loaded = await store.load({ sessionId: snapshot.sessionId });
  assert.deepEqual(loaded, snapshot.entries);
  loaded[0].message.content[0].text = 'mutated consumer copy';
  assert.notDeepEqual(loaded, snapshot.entries);
  await store.append({ sessionId: snapshot.sessionId }, [{ type: 'user', message: { role: 'user', content: 'not mirrored' } }]);
  assert.deepEqual(await store.load({ sessionId: snapshot.sessionId }), snapshot.entries);
  assert.deepEqual(await store.listSubkeys({ sessionId: snapshot.sessionId }), []);
});
