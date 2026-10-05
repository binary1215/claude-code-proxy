// Pure synthetic tests: no app import, credentials, sockets or live provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MODEL, seedRequest, seedEligible, replayRequest, changedDeveloperRequest,
  decodeResponsesSse, usageOnly, usageMatchesRow, standardUsageMatches, failureShape } from './hoist_live_probe.mjs';

const output = [
  { type: 'reasoning', id: 'rs_fixture', encrypted_content: 'ccpr1.SYNTHETIC_ONLY', summary: [] },
  { type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture', name: 'fixture_lookup', arguments: '{"key":"probe"}', status: 'completed' },
];
function wire(response, mutate = () => {}) {
  const events = [
    { type: 'response.created', response: { model: MODEL, status: 'in_progress', output: [] } },
    ...response.output.map((item, output_index) => ({ type: 'response.output_item.done', item: structuredClone(item), output_index })),
    { type: 'response.completed', response: structuredClone(response) },
  ];
  for (const [sequence_number, event] of events.entries()) event.sequence_number = sequence_number;
  mutate(events);
  return Buffer.from(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
}
const response = { model: MODEL, status: 'completed', output };

test('failure shape never exposes provider keys or values', () => {
  const shape = failureShape({ type: 'message_start', SECRET_KEY: 'SECRET_VALUE', message: {
    model: MODEL, context_management: { SECRET_KEY: 'SECRET_VALUE' }, usage: { iterations: ['SECRET_VALUE'] },
    signature: 'SECRET_VALUE', content: ['SECRET_VALUE'],
  } }, 'unsupported_upstream_event');
  assert.equal(shape.event, 'message_start'); assert.equal(shape.extra_event_keys, 1);
  assert.equal(shape.message_model_matches, true); assert.equal(shape.message_has_context_management, true);
  assert.equal(shape.usage_has_iterations, true);
  assert(!JSON.stringify(shape).includes('SECRET'));
  assert.equal(failureShape({ type: 'SECRET_EVENT' }, 'SECRET_CODE').event, 'unknown');
  assert.equal(failureShape(null, 'SECRET_CODE').code, 'unknown');
});

test('seed is pinned, bounded, synthetic, streaming and has explicit cache marker', () => {
  const seed = seedRequest();
  assert.equal(seed.model, 'claude-haiku-4-5-20251001'); assert.equal(seed.stream, true);
  assert.equal(seed.max_output_tokens, 1536); assert.equal(seed.tools.length, 1);
  assert.equal(seed.tools[0].name, 'fixture_lookup'); assert.equal(seed.input[0].role, 'developer');
  assert.equal(seed.input[1].content[0].cache_control.ttl, '5m');
  assert.equal((seed.input[1].content[0].text.match(/Record \d{4}:/g) || []).length, 320);
  assert(Buffer.byteLength(JSON.stringify(seed)) < 1024 * 1024);
});

test('eligibility requires opaque state plus exactly one exact safe lookup', () => {
  assert(seedEligible(response));
  for (const changed of [
    { output: output.slice(1) }, { output: output.slice(0, 1) }, { output: [null] },
    { output: [...output, output[1]] },
    { output: [output[0], { ...output[1], name: 'exec_command' }] },
    { output: [output[0], { ...output[1], arguments: '{"key":"other"}' }] },
    { output: [output[0], { ...output[1], arguments: '{"key":"probe","extra":true}' }] },
  ]) assert.equal(seedEligible(changed), false);
});

test('replay only moves same developer and preserves opaque history plus synthetic tool result', () => {
  const seed = seedRequest(), before = structuredClone(seed), replay = replayRequest(seed, response);
  assert.deepEqual(seed, before);
  assert.deepEqual(replay.input[0], seed.input[1]); assert.deepEqual(replay.input[1], seed.input[0]);
  assert.deepEqual(replay.input.slice(2, -1), output);
  assert.deepEqual(replay.input.at(-1), { type: 'function_call_output', call_id: 'call_fixture',
    output: '{"key":"probe","value":"seven"}', cache_control: { type: 'ephemeral', ttl: '5m' } });
  const changed = changedDeveloperRequest(replay);
  assert.notEqual(changed.input[1].content[0].text, replay.input[1].content[0].text);
  changed.input[1].content[0].text = replay.input[1].content[0].text;
  assert.deepEqual(changed, replay);
});

test('strict SSE accepts exact done/completed opaque items and rejects changed capsules', () => {
  assert.deepEqual(decodeResponsesSse(wire(response)), response);
  assert.throws(() => decodeResponsesSse(wire(response, events => {
    events.at(-1).response.output[0].encrypted_content = 'ccpr1.CHANGED';
  })));
  assert.throws(() => decodeResponsesSse(wire(response, events => { events[1].output_index = 8; })));
  assert.throws(() => decodeResponsesSse(wire(response, events => { events[1].sequence_number = 8; })));
});

test('SSE rejects invalid UTF-8, truncation, wrong model, extra or failed terminal', () => {
  assert.throws(() => decodeResponsesSse(Buffer.from([0xff])));
  assert.throws(() => decodeResponsesSse(wire(response).subarray(0, -1)));
  assert.throws(() => decodeResponsesSse(wire({ ...response, model: 'unapproved' })));
  assert.throws(() => decodeResponsesSse(wire(response, events => { events.at(-1).type = 'response.failed'; })));
  assert.throws(() => decodeResponsesSse(wire(response, events => { events.push({ ...events.at(-1), sequence_number: events.length }); })));
});

test('usage output is numeric allowlist only; unknown provider strings cannot escape', () => {
  const usage = usageOnly({ anthropic_usage: { input_tokens: 3, output_tokens: 4, cache_creation_input_tokens: 5,
    cache_read_input_tokens: 6, cache_creation: { ephemeral_5m_input_tokens: 5, ephemeral_1h_input_tokens: 0, secret: 'DO_NOT_PRINT' },
    secret: 'DO_NOT_PRINT' }, usage: { input_tokens: 14, output_tokens: 4, total_tokens: 18,
    input_tokens_details: { cached_tokens: 6, cache_write_tokens: 5 }, secret: 'DO_NOT_PRINT' } });
  assert(!JSON.stringify(usage).includes('DO_NOT_PRINT'));
  const row = { input_tokens: 3, output_tokens: 4, cache_creation_input_tokens: 5, cache_read_input_tokens: 6,
    cache_creation_5m_tokens: 5, cache_creation_1h_tokens: 0, requested_model: MODEL, resolved_model: MODEL,
    status: 'success', upstream_http_status: 200 };
  assert(usageMatchesRow(usage, row)); assert(!usageMatchesRow(usage, { ...row, cache_read_input_tokens: 0 }));
  assert(!usageMatchesRow(usage, { ...row, resolved_model: 'changed' }));
  assert(standardUsageMatches(usage));
  assert(!standardUsageMatches({ ...usage, standard: { ...usage.standard, input_tokens: 999 } }));
  assert(standardUsageMatches(usageOnly({})));
  assert.equal(usageOnly({ anthropic_usage: { input_tokens: 'DO_NOT_PRINT', output_tokens: -1 } }).native.input_tokens, null);
  assert.equal(usageOnly({ anthropic_usage: { input_tokens: 'DO_NOT_PRINT', output_tokens: -1 } }).native.output_tokens, null);
});
