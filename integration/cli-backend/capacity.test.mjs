import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, afterEach, test } from 'node:test';

// Genuine pinned SDK/CLI, with a loopback scripted provider and synthetic auth.
// Pending tools belong to the external caller, so an idle worker is a cache:
// eviction must preserve full-history continuation without executing a tool.
const runtime = mkdtempSync(join(tmpdir(), 'claude-cli-capacity-'));
const calls = [];
const model = 'claude-haiku-5-5';
const signed = { type: 'thinking', thinking: 'Synthetic exact caller reasoning.', signature: 'synthetic-capacity-signature' };
const emit = (type, rest = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...rest })}\n\n`;
const blocksOf = body => body.messages.flatMap(message => Array.isArray(message.content) ? message.content : [{ type: 'text', text: message.content }]);
const provider = http.createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
  if (req.url.startsWith('/v1/models')) return res.end(JSON.stringify({ data: [{ id: model, type: 'model' }], has_more: false }));
  if (req.url.includes('count_tokens')) return res.end('{"input_tokens":200}');
  calls.push(body);
  const contents = blocksOf(body);
  const hold = contents.some(block => block.type === 'text' && block.text?.includes('HOLD_ACTIVE_LEASE'));
  const result = contents.find(block => block.type === 'tool_result');
  const tool = body.tools?.find(definition => definition.name.startsWith('mcp__caller__'));
  const blocks = result ? [{ type: 'text', text: 'CALLER_RESULT_ACCEPTED' }] : [signed, {
    type: 'tool_use', id: `toolu_capacity_${calls.length}`, name: tool?.name, input: { input: { value: 7 } },
  }];
  const usage = { input_tokens: 7, output_tokens: 9, cache_read_input_tokens: 11, cache_creation_input_tokens: 3 };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(emit('message_start', { message: { id: `msg_capacity_${calls.length}`, type: 'message', role: 'assistant', model,
    content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 0 } } }));
  if (hold) return; // Keep the real upstream stream active until owned cleanup.
  for (const [index, block] of blocks.entries()) {
    const start = block.type === 'thinking' ? { ...block, thinking: '', signature: '' } : block.type === 'tool_use' ? { ...block, input: {} } : { ...block, text: '' };
    res.write(emit('content_block_start', { index, content_block: start }));
    if (block.type === 'thinking') {
      res.write(emit('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: block.thinking } }));
      res.write(emit('content_block_delta', { index, delta: { type: 'signature_delta', signature: block.signature } }));
    } else if (block.type === 'tool_use') {
      res.write(emit('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } }));
    } else res.write(emit('content_block_delta', { index, delta: { type: 'text_delta', text: block.text } }));
    res.write(emit('content_block_stop', { index }));
  }
  res.end(emit('message_delta', { delta: { stop_reason: result ? 'end_turn' : 'tool_use', stop_sequence: null }, usage }) + emit('message_stop'));
});
provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
Object.assign(process.env, {
  DATABASE_PATH: ':memory:', UPSTREAM_AUTH_SOURCE: 'configured', ANTHROPIC_API_KEY: 'synthetic-capacity-only',
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${provider.address().port}`, CLAUDE_INFERENCE_BACKEND: 'cli',
  CLAUDE_AUTH_AUTO_REFRESH: 'false', CLAUDE_CLI_RUNTIME_DIR: runtime, CLAUDE_CLI_MAX_SESSIONS: '2',
  CLAUDE_CLI_WORKER_PATH: fileURLToPath(new URL('./worker.mjs', import.meta.url)), UPSTREAM_TIMEOUT_MS: '20000', RESPONSES_ENABLED: 'false',
});
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
const { acquireCliSession, closeCliSessions, cliSessionCount } = await import('../../dist/services/cliSessions.js');
const { db } = await import('../../dist/db/connection.js');
const credential = { kind: 'api_key', token: process.env.ANTHROPIC_API_KEY };
const tools = [{ name: 'caller_only', description: 'Executed by the external client.',
  input_schema: { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'], additionalProperties: false } }];
const request = label => ({ model, max_tokens: 1024, tools, messages: [{ role: 'user', content: label }] });
async function turn(body) {
  const lease = await acquireCliSession(body, 'capacity-fixture', credential);
  try {
    for await (const event of lease.session.events()) { /* Drain the genuine CLI message. */ }
    lease.session.commit(lease.messages);
    return { session: lease.session, message: structuredClone(lease.session.message) };
  } finally { lease.detach(); }
}
function continuation(body, previous, value) {
  const tool = previous.message.content.find(block => block.type === 'tool_use');
  return { ...body, messages: [...body.messages, { role: 'assistant', content: previous.message.content },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: tool.id, content: value }] }] };
}
afterEach(async () => { await closeCliSessions(); });
after(async () => {
  provider.closeAllConnections(); await new Promise(done => provider.close(done)); db.close();
  const target = resolve(runtime);
  assert.ok(target.startsWith(resolve(tmpdir()) + sep) && basename(target).startsWith('claude-cli-capacity-'));
  rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('idle pending workers are LRU caches and evicted tool histories resume losslessly', { timeout: 90000 }, async () => {
  const bodies = ['CAPACITY_A', 'CAPACITY_B', 'CAPACITY_C'].map(request);
  const first = await turn(bodies[0]), second = await turn(bodies[1]);
  assert.equal(first.session.pending.size, 1); assert.equal(second.session.pending.size, 1);
  assert.equal(first.session.busy, false); assert.equal(first.session.upstream.active, false);
  const before = calls.length;
  const third = await turn(bodies[2]);
  assert.equal(calls.length, before + 1, 'Eviction must not invoke another model or execute a caller tool');
  assert.equal(cliSessionCount(), 2);
  assert.equal(first.session.closed, true, 'The least-recent idle pending worker is evicted');
  assert.equal(second.session.closed, false); assert.equal(third.session.closed, false);

  for (const [body, previous, value] of [[bodies[0], first, 'CALLER_REAL_RESULT_A_42'], [bodies[1], second, 'CALLER_REAL_RESULT_B_56']]) {
    const restored = await turn(continuation(body, previous, value));
    assert.notEqual(restored.session, previous.session);
    assert.equal(restored.message.content.find(block => block.type === 'text').text, 'CALLER_RESULT_ACCEPTED');
    const history = blocksOf(calls.at(-1));
    assert.deepEqual(history.find(block => block.type === 'thinking'), signed, 'The exact signed thinking must survive full-history import');
    const originalTool = previous.message.content.find(block => block.type === 'tool_use');
    assert.ok(history.some(block => block.type === 'tool_use' && block.id === originalTool.id));
    const result = history.find(block => block.type === 'tool_result' && block.tool_use_id === originalTool.id);
    assert.ok(JSON.stringify(result).includes(value), 'Use the actual caller result, not a cancelled/interrupted placeholder');
    assert.ok(!JSON.stringify(calls.at(-1)).includes('[claude-proxy-resume:'));
    assert.equal(cliSessionCount(), 2);
  }
});

test('capacity eviction never closes an active inference lease and still rejects genuine overload', { timeout: 90000 }, async () => {
  const pending = await turn(request('IDLE_PENDING'));
  const active = await acquireCliSession(request('HOLD_ACTIVE_LEASE_A'), 'capacity-fixture', credential);
  const next = active.session.events();
  try {
    assert.equal((await next.next()).value.type, 'message_start');
    const newest = await acquireCliSession(request('HOLD_ACTIVE_LEASE_B'), 'capacity-fixture', credential);
    const newestEvents = newest.session.events();
    try {
      assert.equal((await newestEvents.next()).value.type, 'message_start');
      assert.equal(pending.session.closed, true);
      assert.equal(active.session.closed, false); assert.equal(active.session.busy, true); assert.equal(active.session.upstream.active, true);
      assert.equal(newest.session.closed, false); assert.equal(cliSessionCount(), 2);
      const before = calls.length;
      await assert.rejects(acquireCliSession(request('OVER_CAPACITY'), 'capacity-fixture', credential), { code: 'cli_capacity', status: 503 });
      assert.equal(calls.length, before, 'Rejected overload must not make a provider call');
      assert.equal(active.session.closed, false); assert.equal(newest.session.closed, false);
    } finally { newest.detach(); await newestEvents.return(); }
  } finally { active.detach(); await next.return(); }
});
