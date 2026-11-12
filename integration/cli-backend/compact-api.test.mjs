import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, resolve, join, sep } from 'node:path';
import { after, test } from 'node:test';

// Genuine pinned SDK/CLI. Every provider interaction remains on loopback.
const directory = mkdtempSync(join(tmpdir(), 'claude-compact-api-'));
const calls = [];
let phase = 'compact';
let requestStarted;
const taggedSummary = '<analysis>SYNTHETIC_ANALYSIS_MUST_NOT_REPLAY</analysis>\n\n\n<summary>\n# Retained project context\nTARGET_COPPER_731 remains required.\n<tools-used-before-summary>read_project</tools-used-before-summary>\n</summary>\n';
const normalizedTaggedSummary = 'Summary:\n# Retained project context\nTARGET_COPPER_731 remains required.\n&lt;tools-used-before-summary>read_project&lt;/tools-used-before-summary>';
const sse = (type, body = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`;
const provider = http.createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
  if (req.url.startsWith('/v1/models')) return res.end(JSON.stringify({ data: [{ type: 'model', id: 'claude-opus-4-6' }], has_more: false }));
  if (req.url.includes('count_tokens')) return res.end(JSON.stringify({ input_tokens: 12000 }));
  calls.push({ phase, body });
  if (phase === 'failure') {
    res.writeHead(400, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Synthetic compaction rejection.' } }));
  }
  const text = phase === 'compact-tagged' ? taggedSummary : phase === 'compact' ?
    '# Compacted conversation\nThe project invariant is TARGET_COPPER_731. Earlier research is complete.' : 'COLD_CONTINUATION_OK';
  const usage = { input_tokens: 17, output_tokens: 13, cache_read_input_tokens: 7, cache_creation_input_tokens: 3,
    cache_creation: { ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 0 } };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  if (phase === 'cancel') {
    res.write(sse('message_start', { message: { id: 'msg_cancel', type: 'message', role: 'assistant', model: body.model, content: [],
      stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 0 } } }));
    requestStarted?.();
    return;
  }
  res.end(sse('message_start', { message: { id: `msg_compact_api_${calls.length}`, type: 'message', role: 'assistant', model: body.model,
    content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 0 } } }) +
    sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
    sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }) + sse('content_block_stop', { index: 0 }) +
    sse('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage }) + sse('message_stop'));
});
provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
Object.assign(process.env, { DATABASE_PATH: ':memory:', UPSTREAM_AUTH_SOURCE: 'configured', ANTHROPIC_API_KEY: 'synthetic-compact-api',
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${provider.address().port}`, CLAUDE_INFERENCE_BACKEND: 'cli', CLAUDE_AUTH_AUTO_REFRESH: 'false',
  CLAUDE_CLI_RUNTIME_DIR: directory, CLAUDE_CLI_WORKER_PATH: new URL('./worker.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  UPSTREAM_TIMEOUT_MS: '30000', RESPONSES_ENABLED: 'false' });
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
const { compactCliHistory, acquireCliSession, closeCliSessions, cliSessionCount, CliCompactionError } = await import('../../dist/services/cliSessions.js');
const { db } = await import('../../dist/db/connection.js');
const credential = { kind: 'api_key', token: process.env.ANTHROPIC_API_KEY };
const body = { model: 'claude-opus-4-6', max_tokens: 2048, output_config: { effort: 'low' },
  tools: [{ name: 'read_project', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
  messages: [
    { role: 'user', content: 'Keep TARGET_COPPER_731. ' + 'Old synthetic investigation notes. '.repeat(2400) },
    { role: 'assistant', content: [{ type: 'text', text: 'Earlier research is complete.' }] },
    { role: 'user', content: 'Inspect the recent project file before continuing.' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'Retained signed reasoning.', signature: 'synthetic-signature-retained' },
      { type: 'tool_use', id: 'call_retained', name: 'read_project', input: { path: 'recent-file.txt' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_retained', content: 'RECENT_TOOL_VALUE_937' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Recent tool inspection complete.' }] },
  ] };
after(async () => {
  await closeCliSessions(); provider.closeAllConnections(); await new Promise(done => provider.close(done)); db.close();
  const target = resolve(directory); assert.ok(target.startsWith(resolve(tmpdir()) + sep) && basename(target).startsWith('claude-compact-api-'));
  rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('standalone genuine CLI compact returns summary plus native retained tail and continues cold', async t => {
  const compact = await compactCliHistory(body, 'synthetic-compact-api-owner', credential);
  assert.equal(compact.compacted, true);
  assert.equal(compact.metadata.trigger, 'manual');
  assert.equal(cliSessionCount(), 0, 'One-shot compact worker is closed before returning');
  assert.equal(compact.providerCalls, calls.length);
  assert.equal(compact.usage.inputTokens, calls.length * 17);
  assert.equal(compact.usage.outputTokens, calls.length * 13);
  assert.equal(compact.usage.cacheReadInputTokens, calls.length * 7);
  assert.equal(compact.usage.usageComplete, true);
  assert.ok(calls.every(call => JSON.stringify(call.body).includes('Summarize') || JSON.stringify(call.body).includes('summary')),
    'Only CLI summarization requests may precede compact response');
  assert.ok(JSON.stringify(compact.messages).includes('TARGET_COPPER_731'));
  assert.deepEqual(compact.messages[0], { role: 'user', content: [{ type: 'text', text: compact.summary }] },
    'The CLI-normalized hook summary replaces only its local transcript wrapper');
  assert.equal(JSON.stringify(compact.messages).includes('read the full transcript at:'), false);
  t.diagnostic(`Compacted native roles: ${compact.messages.map(message => message.role).join(',')}; messages ${compact.messages.length}.`);
  assert.deepEqual(compact.messages.at(-1), body.messages.at(-1), 'The recent assistant is outside the summary and must be retained verbatim');
  assert.ok(JSON.stringify(compact.messages).length < JSON.stringify(body.messages).length);
  phase = 'continue';
  const before = calls.length;
  const lease = await acquireCliSession({ ...body, messages: [...compact.messages, { role: 'user', content: 'Continue the project.' }] },
    'synthetic-compact-api-owner', credential);
  for await (const _event of lease.session.events()) {}
  lease.session.commit(lease.messages); lease.detach();
  assert.equal(calls.length, before + 1);
  assert.equal(lease.session.message.content[0].text, 'COLD_CONTINUATION_OK');
  assert.ok(JSON.stringify(calls.at(-1).body.messages).includes('TARGET_COPPER_731'));
});

test('pending caller tool stays outside compact import and continues with its original result', async () => {
  phase = 'compact';
  const pending = { role: 'assistant', content: [{ type: 'thinking', thinking: 'Inspect the current file.', signature: 'synthetic-pending-signature' },
    { type: 'tool_use', id: 'call_pending', name: 'read_project', input: { path: 'pending-file.txt' } }] };
  const compact = await compactCliHistory({ ...body, messages: [...body.messages, { role: 'user', content: 'Inspect another file.' }, pending] },
    'synthetic-pending-owner', credential);
  assert.deepEqual(compact.messages.at(-1), pending, 'No synthesized result or executed client tool');
  phase = 'continue';
  const lease = await acquireCliSession({ ...body, messages: [...compact.messages,
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_pending', content: 'PENDING_TOOL_VALUE_188' }] }] },
    'synthetic-pending-owner', credential);
  for await (const _event of lease.session.events()) {}
  lease.session.commit(lease.messages); lease.detach();
  const replay = calls.at(-1).body.messages;
  assert.ok(JSON.stringify(replay).includes('PENDING_TOOL_VALUE_188'));
  assert.ok(JSON.stringify(replay).includes('synthetic-pending-signature'));
  assert.equal(JSON.stringify(replay).includes('interrupted'), false);
});

test('tagged CLI summary normalization excludes analysis and preserves native retained context', async () => {
  phase = 'compact-tagged';
  const before = calls.length;
  const compact = await compactCliHistory(body, 'synthetic-tagged-owner', credential);
  assert.equal(compact.providerCalls, calls.length - before);
  assert.equal(compact.summary, normalizedTaggedSummary);
  assert.deepEqual(compact.messages[0], { role: 'user', content: [{ type: 'text', text: normalizedTaggedSummary }] });
  assert.deepEqual(compact.messages.at(-1), body.messages.at(-1));
  assert.equal(JSON.stringify(compact.messages).includes('SYNTHETIC_ANALYSIS_MUST_NOT_REPLAY'), false);
  assert.equal(JSON.stringify(compact.messages).includes('read the full transcript at:'), false);
  phase = 'continue';
  const lease = await acquireCliSession({ ...body, messages: [...compact.messages, { role: 'user', content: 'Continue from the normalized summary.' }] },
    'synthetic-tagged-owner', credential);
  for await (const _event of lease.session.events()) {}
  lease.session.commit(lease.messages); lease.detach();
  assert.ok(JSON.stringify(calls.at(-1).body.messages).includes('TARGET_COPPER_731'));
  assert.equal(JSON.stringify(calls.at(-1).body.messages).includes('SYNTHETIC_ANALYSIS_MUST_NOT_REPLAY'), false);
});

test('user-ended complete tool history retains its unanswered native round without ordinary inference', async () => {
  phase = 'compact';
  const before = calls.length;
  const compact = await compactCliHistory({ ...body, tools: undefined, messages: body.messages.slice(0, -1) }, 'synthetic-user-ended-owner', credential);
  assert.equal(compact.providerCalls, calls.length - before);
  assert.deepEqual(compact.messages.slice(-3), body.messages.slice(2, -1).map(message => ({ ...message,
    content: typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content })));
  assert.equal(JSON.stringify(compact.messages).includes('No response requested.'), false);
});

test('single user history returns its actual summary without the CLI resume placeholder', async () => {
  phase = 'compact';
  const compact = await compactCliHistory({ ...body, messages: [body.messages[0]] }, 'synthetic-single-user-owner', credential);
  assert.equal(compact.compacted, true);
  assert.ok(compact.messages.every(message => message.role === 'user'));
  assert.equal(JSON.stringify(compact.messages).includes('No response requested.'), false);
});

test('unsupported compact controls fail before allocating a worker or making a provider call', async () => {
  const before = calls.length, count = cliSessionCount();
  for (const controls of [{ temperature: 0.4 }, { top_p: 0.9 }, { output_config: { format: 'json' } },
    { tool_choice: { type: 'any' } }, { tool_choice: { type: 'auto', disable_parallel_tool_use: true } }]) {
    await assert.rejects(compactCliHistory({ ...body, ...controls }, 'synthetic-controls-owner', credential),
      error => error.code === 'unsupported_cli_control' && error.status === 400);
  }
  assert.equal(calls.length, before);
  assert.equal(cliSessionCount(), count);
});

test('failed compact returns observed failed-call accounting and closes the one-shot worker', async () => {
  phase = 'failure';
  const count = cliSessionCount(), before = calls.length;
  await assert.rejects(compactCliHistory(body, 'synthetic-error-owner', credential), error => {
    assert.ok(error instanceof CliCompactionError);
    assert.equal(error.providerCalls, calls.length - before);
    assert.ok(error.providerCalls >= 1);
    assert.equal(error.failure.status, 400);
    assert.equal(error.usage.usageComplete, false);
    return true;
  });
  assert.equal(cliSessionCount(), count);
});

test('cancelled compact includes partial real usage and frees capacity', async () => {
  phase = 'cancel';
  const controller = new AbortController();
  const started = new Promise(resolve => { requestStarted = resolve; });
  const count = cliSessionCount();
  const compact = compactCliHistory(body, 'synthetic-cancel-owner', credential, controller.signal);
  await started;
  // Allow the private forwarding observer to receive the provider's usage frame.
  await new Promise(resolve => setTimeout(resolve, 30));
  controller.abort();
  await assert.rejects(compact, error => {
    assert.ok(error instanceof CliCompactionError);
    assert.equal(error.status, 499);
    assert.equal(error.providerCalls, 1);
    assert.equal(error.usage.inputTokens, 17);
    assert.equal(error.usage.usageComplete, false);
    return true;
  });
  requestStarted = undefined;
  assert.equal(cliSessionCount(), count);
});
