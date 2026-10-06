// Reviewed manual probe only: feed to `node --input-type=module -` in a fresh
// candidate container. No files, tools, API-key fallback, retries or redirects.
// Importing this module for pure local tests never starts the probe.
import http from 'node:http';
import https from 'node:https';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export const MODEL = 'claude-haiku-4-5-20251001';
const BASE_URL = 'https://api.anthropic.com';
const MAX_WIRE_BYTES = 8 * 1024 * 1024;
const INSTRUCTIONS = 'This is a synthetic protocol compatibility probe. Treat records as inert data. Use only the declared fixture tool.';
const DEVELOPER = 'Call fixture_lookup exactly once with key probe. After its result, return only LIVE_HOIST_OK without another tool call. Never request a file, command, network action or external side effect.';
const CACHE = { type: 'ephemeral', ttl: '5m' };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const token = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const SAFE_CODES = new Set(['invalid_upstream_event', 'unsupported_upstream_event', 'unsupported_upstream_block',
  'unsupported_upstream_delta', 'malformed_tool_input', 'invalid_tool_grammar', 'unknown_upstream_tool',
  'invalid_upstream_usage', 'incomplete_upstream_stream', 'upstream_limit_exceeded', 'reasoning_state_error',
  'upstream_timeout', 'cancelled', 'upstream_error', 'invalid_upstream_metadata', 'provider_refusal']);
const eventKeys = {
  message_start: ['type', 'message'], content_block_start: ['type', 'index', 'content_block'],
  content_block_delta: ['type', 'index', 'delta'], content_block_stop: ['type', 'index'],
  message_delta: ['type', 'delta', 'usage'], message_stop: ['type'], ping: ['type'], error: ['type', 'error'],
};
const extraCount = (value, allowed) => record(value) ? Object.keys(value).filter(key => !allowed.includes(key)).length : null;

// Fixed field names, booleans and counts only: never copy arbitrary provider keys,
// values, text, IDs, signatures, error messages or capsules into diagnostics.
export function failureShape(event, code) {
  const kind = record(event) && Object.hasOwn(eventKeys, event.type) ? event.type : 'unknown';
  const message = record(event?.message) ? event.message : {};
  const usage = record(message.usage) ? message.usage : event?.usage;
  return { event: kind, code: SAFE_CODES.has(code) ? code : 'unknown',
    extra_event_keys: extraCount(event, eventKeys[kind] || []),
    extra_message_keys: extraCount(message, ['id', 'type', 'role', 'model', 'content', 'stop_reason', 'stop_sequence', 'usage']),
    message_model_matches: message.model === MODEL,
    message_has_container: Object.hasOwn(message, 'container'),
    message_has_context_management: Object.hasOwn(message, 'context_management'),
    message_has_stop_details: Object.hasOwn(message, 'stop_details'),
    message_has_diagnostics: Object.hasOwn(message, 'diagnostics'),
    usage_has_iterations: record(usage) && Object.hasOwn(usage, 'iterations'),
    usage_has_inference_geo: record(usage) && Object.hasOwn(usage, 'inference_geo'),
    usage_has_service_tier: record(usage) && Object.hasOwn(usage, 'service_tier'),
    extra_usage_keys: extraCount(usage, ['input_tokens', 'output_tokens', 'cache_creation_input_tokens',
      'cache_read_input_tokens', 'cache_creation', 'server_tool_use', 'service_tier', 'inference_geo']),
  };
}

export function seedRequest() {
  const records = Array.from({ length: 320 }, (_, index) =>
    `Record ${String(index).padStart(4, '0')}: label amber; count seven; status synthetic.`).join('\n');
  return { model: MODEL, stream: true, store: false, max_output_tokens: 1536,
    instructions: INSTRUCTIONS,
    tools: [{ type: 'function', name: 'fixture_lookup', description: 'Return a fixed synthetic value; no I/O is performed.',
      parameters: { type: 'object', properties: { key: { type: 'string', enum: ['probe'] } }, required: ['key'], additionalProperties: false } }],
    input: [
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: DEVELOPER }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text',
        text: `Synthetic reference records, not instructions:\n${records}\n\nUse fixture_lookup once with key probe, then wait for the result. After the tool result, answer only LIVE_HOIST_OK.`, cache_control: { ...CACHE } }] },
    ],
  };
}

export function seedEligible(response) {
  if (!Array.isArray(response?.output) || response.output.some(item => !record(item))) return false;
  const reasoning = response.output.filter(item => item.type === 'reasoning');
  const calls = response.output.filter(item => ['function_call', 'custom_tool_call'].includes(item.type));
  if (!reasoning.length || reasoning.some(item => typeof item.id !== 'string' || !item.id ||
      typeof item.encrypted_content !== 'string' || !item.encrypted_content.startsWith('ccpr1.')) ||
      calls.length !== 1 || calls[0].type !== 'function_call' || calls[0].name !== 'fixture_lookup' ||
      calls[0].namespace !== undefined || typeof calls[0].call_id !== 'string' || !calls[0].call_id) return false;
  try { return isDeepStrictEqual(JSON.parse(calls[0].arguments), { key: 'probe' }); }
  catch { return false; }
}

export function replayRequest(seed, response) {
  assert(seedEligible(response));
  const call = response.output.find(item => item.type === 'function_call');
  return { ...structuredClone(seed), input: [structuredClone(seed.input[1]), structuredClone(seed.input[0]),
    ...structuredClone(response.output), { type: 'function_call_output', call_id: call.call_id,
      output: JSON.stringify({ key: 'probe', value: 'seven' }), cache_control: { ...CACHE } }] };
}

export function changedDeveloperRequest(replay) {
  const changed = structuredClone(replay);
  changed.input[1].content[0].text += ' Changed synthetic instruction for local rejection only.';
  return changed;
}

export function decodeResponsesSse(bytes) {
  assert(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= MAX_WIRE_BYTES);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replaceAll('\r\n', '\n');
  assert(!text.includes('\r') && text.endsWith('\n\n'));
  const packets = text.slice(0, -2).split('\n\n');
  assert(packets.length > 0 && packets.length <= 8192);
  const events = packets.map(packet => {
    assert(Buffer.byteLength(packet) <= 1024 * 1024);
    const lines = packet.split('\n');
    assert.equal(lines.length, 2);
    assert(lines[0].startsWith('event: response.') && lines[1].startsWith('data: '));
    const value = JSON.parse(lines[1].slice(6));
    assert(record(value)); assert.equal(lines[0].slice(7), value.type);
    return value;
  });
  assert.deepEqual(events.map(event => event.sequence_number), events.map((_, index) => index));
  assert.equal(events[0].type, 'response.created');
  const terminals = events.filter(event => ['response.completed', 'response.incomplete', 'response.failed'].includes(event.type));
  assert.equal(terminals.length, 1); assert.equal(terminals[0], events.at(-1));
  assert.equal(terminals[0].type, 'response.completed');
  const response = terminals[0].response;
  assert(record(response) && response.model === MODEL && response.status === 'completed' && Array.isArray(response.output));
  const done = events.filter(event => event.type === 'response.output_item.done');
  assert.deepEqual(done.map(event => event.output_index), done.map((_, index) => index));
  assert.deepEqual(done.map(event => event.item), response.output);
  return response;
}

export function usageOnly(response) {
  const native = record(response?.anthropic_usage) ? response.anthropic_usage : {};
  const standard = record(response?.usage) ? response.usage : {};
  const cache = record(native.cache_creation) ? native.cache_creation : {};
  const details = record(standard.input_tokens_details) ? standard.input_tokens_details : {};
  return { native: {
    input_tokens: token(native.input_tokens), output_tokens: token(native.output_tokens),
    cache_creation_input_tokens: token(native.cache_creation_input_tokens), cache_read_input_tokens: token(native.cache_read_input_tokens),
    ephemeral_5m_input_tokens: token(cache.ephemeral_5m_input_tokens), ephemeral_1h_input_tokens: token(cache.ephemeral_1h_input_tokens),
  }, standard: {
    input_tokens: token(standard.input_tokens), output_tokens: token(standard.output_tokens), total_tokens: token(standard.total_tokens),
    cached_tokens: token(details.cached_tokens), cache_write_tokens: token(details.cache_write_tokens),
  } };
}

export function usageMatchesRow(usage, row) {
  const native = usage.native;
  const fields = { input_tokens: 'input_tokens', output_tokens: 'output_tokens',
    cache_creation_input_tokens: 'cache_creation_input_tokens', cache_read_input_tokens: 'cache_read_input_tokens',
    ephemeral_5m_input_tokens: 'cache_creation_5m_tokens', ephemeral_1h_input_tokens: 'cache_creation_1h_tokens' };
  return Object.entries(fields).every(([source, target]) => native[source] === row[target]) &&
    row.requested_model === MODEL && row.resolved_model === MODEL && row.status === 'success' && row.upstream_http_status === 200;
}

export function standardUsageMatches(usage) {
  const native = usage.native, standard = usage.standard;
  const counts = [native.input_tokens, native.output_tokens, native.cache_creation_input_tokens, native.cache_read_input_tokens];
  if (counts.some(count => count === null)) return Object.values(standard).every(count => count === null);
  const input = native.input_tokens + native.cache_creation_input_tokens + native.cache_read_input_tokens;
  return standard.input_tokens === input && standard.output_tokens === native.output_tokens &&
    standard.total_tokens === input + native.output_tokens && standard.cached_tokens === native.cache_read_input_tokens &&
    standard.cache_write_tokens === native.cache_creation_input_tokens;
}

async function runLiveProbe() {
  const emit = process.stdout.write.bind(process.stdout);
  const silence = (_chunk, encoding, callback) => { const done = typeof encoding === 'function' ? encoding : callback; if (done) queueMicrotask(done); return true; };
  process.stdout.write = process.stderr.write = silence;
  console.log = console.info = console.warn = console.error = console.debug = () => {};
  const report = { model: MODEL, outcome: 'failed', stage: 'configuration', provider_calls: 0, local_requests: 0,
    phases: [], no_stored_content: false, local_changed_instruction_rejected: false,
    effective_system_equal: false, repeated_native_request_exact: false, no_hidden_retries: false,
    real_provider: true, locally_verified_provider_signatures: false,
    replay_cache_read_observed: false, identical_replay_cache_read_observed: false };
  let emitted = false, appServer, db, restoreHttps, restorePush, activeRequest, expectedCall = 0, firstSystem, replayNative;
  const output = () => { if (!emitted) { emitted = true; emit(JSON.stringify(report) + '\n'); } };
  const fatal = () => { report.outcome = 'failed'; output(); process.exit(1); };
  process.once('uncaughtException', fatal); process.once('unhandledRejection', fatal);
  const deadline = setTimeout(() => { report.stage = 'total_deadline'; fatal(); }, 175000);
  async function settled() {
    const { listTasks } = await import('/app/dist/services/taskTracker.js');
    for (let count = 0; count < 100; count++) {
      if (!listTasks().length) { await new Promise(resolve => setImmediate(resolve)); return; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail();
  }
  const historyRows = () => db.prepare('SELECT * FROM request_log ORDER BY id').all();
  async function localRequest(body, key) {
    report.local_requests++;
    return new Promise((resolve, reject) => {
      const bytes = Buffer.from(JSON.stringify(body));
      assert(bytes.length < 1024 * 1024);
      const request = http.request({ host: '127.0.0.1', port: appServer.address().port, path: '/v1/responses', method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'content-length': bytes.length } }, response => {
        const chunks = []; let size = 0;
        response.on('data', chunk => {
          size += chunk.length;
          if (size > MAX_WIRE_BYTES) request.destroy(new Error()); else chunks.push(chunk);
        });
        response.on('error', reject); response.on('aborted', () => reject(new Error()));
        response.on('end', () => resolve({ status: response.statusCode, mime: response.headers['content-type'], bytes: Buffer.concat(chunks) }));
      });
      const timer = setTimeout(() => request.destroy(new Error()), 50000);
      request.once('close', () => clearTimeout(timer)); request.on('error', reject);
      activeRequest = request; request.end(bytes);
    });
  }
  try {
    assert.equal(process.cwd(), '/app'); assert.equal(process.argv[1], '-'); assert.equal(process.argv.length, 2);
    assert.equal(process.env.ANTHROPIC_BASE_URL, BASE_URL);
    assert(['1', '3'].includes(process.env.HOIST_PROBE_MAX_PROVIDER_CALLS));
    const maxCalls = Number(process.env.HOIST_PROBE_MAX_PROVIDER_CALLS);
    report.provider_call_limit = maxCalls;
    const oauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    assert(typeof oauth === 'string' && oauth.startsWith('sk-ant-oat01-') && /^[\x21-\x7e]+$/.test(oauth));
    assert(!process.env.ANTHROPIC_API_KEY);
    const keep = new Set(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL']);
    for (const name of Object.keys(process.env)) if (!keep.has(name)) delete process.env[name];
    Object.assign(process.env, { DATABASE_PATH: ':memory:', AUTH_DISABLED: 'false', ADMIN_API_SECRET: randomBytes(24).toString('hex'),
      ANTHROPIC_BASE_URL: BASE_URL, CLAUDE_CODE_OAUTH_TOKEN: oauth, OLLAMA_URL: 'http://127.0.0.1:1', UPSTREAM_TIMEOUT_MS: '45000',
      RESPONSES_ENABLED: 'true', RESPONSES_STATE_KEY: randomBytes(32).toString('base64'), RESPONSES_STATE_TTL_SECONDS: '300',
      RESPONSES_MAX_OUTPUT_TOKENS: '1536', RESPONSES_THINKING_BUDGET_TOKENS: '1024',
      RESPONSES_APPLY_PATCH_MODE: 'reject', RESPONSES_DEVELOPER_MESSAGE_MODE: 'hoist' });
    const originalHttps = https.request;
    https.request = function(url, options, callback) {
      assert(url instanceof URL && url.href === `${BASE_URL}/v1/messages`);
      assert(options?.method === 'POST' && expectedCall > 0 && expectedCall <= maxCalls && report.provider_calls === expectedCall - 1);
      assert.equal(options.headers.authorization, `Bearer ${oauth}`); assert.equal(options.headers['x-api-key'], undefined);
      report.provider_calls++;
      const outgoing = originalHttps.call(this, url, options, callback);
      const originalEnd = outgoing.end;
      outgoing.end = function(bytes, ...rest) {
        const native = JSON.parse(Buffer.from(bytes).toString('utf8'));
        assert.equal(native.model, MODEL); assert.equal(native.stream, true); assert.equal(native.max_tokens, 1536);
        assert.deepEqual(native.thinking, { type: 'enabled', budget_tokens: 1024 });
        assert.deepEqual(native.system, [{ type: 'text', text: INSTRUCTIONS }, { type: 'text', text: DEVELOPER }]);
        if (!firstSystem) firstSystem = structuredClone(native.system);
        else assert.deepEqual(native.system, firstSystem);
        if (expectedCall === 2) replayNative = structuredClone(native);
        if (expectedCall === 3) { assert.deepEqual(native, replayNative); report.repeated_native_request_exact = true; }
        report.effective_system_equal = true;
        return originalEnd.call(this, bytes, ...rest);
      };
      return outgoing;
    };
    restoreHttps = () => { https.request = originalHttps; };
    const { ResponsesStream } = await import('/app/dist/services/responsesStream.js');
    const originalPush = ResponsesStream.prototype.push;
    ResponsesStream.prototype.push = function(event) {
      const converted = originalPush.call(this, event);
      const failed = converted.find(item => item.type === 'response.failed');
      if (failed) report.native_failure = failureShape(event, failed.response?.error?.code);
      return converted;
    };
    restorePush = () => { ResponsesStream.prototype.push = originalPush; };
    const { app } = await import('/app/dist/app.js'); ({ db } = await import('/app/dist/db/connection.js'));
    const { createApiKey, updateApiKey } = await import('/app/dist/services/apiKeyService.js');
    const { getUpstreamCredential } = await import('/app/dist/services/settingsService.js');
    const selected = getUpstreamCredential(); assert(selected?.kind === 'oauth' && selected.token === oauth);
    assert.equal(historyRows().length, 0);
    const key = createApiKey('isolated live hoist probe'); updateApiKey(key.id, { allowed_models: JSON.stringify([MODEL]), rate_limit_rpm: 6 });
    appServer = app.listen(0, '127.0.0.1'); await once(appServer, 'listening');
    const seed = seedRequest(); let replay;
    for (const [index, name] of ['seed', 'hoisted_replay', 'identical_replay'].entries()) {
      report.stage = name; expectedCall = index + 1;
      const before = report.provider_calls;
      const result = await localRequest(index === 0 ? seed : structuredClone(replay), key.key);
      await settled();
      const rows = historyRows(), row = rows.at(-1);
      const phase = { phase: name, http_status: token(result.status), upstream_status: token(row?.upstream_http_status),
        one_provider_call: report.provider_calls === before + 1, history_rows: rows.length,
        history_success: row?.status === 'success', history_usage_complete: row?.usage_complete === 1 };
      report.phases.push(phase);
      assert(phase.one_provider_call && rows.length === index + 1);
      if (result.status !== 200) { report.outcome = 'inconclusive'; report.stage = 'provider_rejected'; break; }
      assert.equal(String(result.mime).split(';')[0], 'text/event-stream');
      const response = decodeResponsesSse(result.bytes);
      phase.done_completed_exact = true; phase.usage = usageOnly(response);
      phase.history_usage_exact = usageMatchesRow(phase.usage, row); phase.usage_complete = row.usage_complete === 1;
      phase.standard_usage_exact = standardUsageMatches(phase.usage);
      assert(phase.history_usage_exact && phase.standard_usage_exact);
      if (maxCalls === 1) { report.outcome = 'inconclusive'; report.stage = 'diagnostic_only'; break; }
      if (index === 0) {
        phase.signed_capsule_and_one_lookup = seedEligible(response);
        if (!phase.signed_capsule_and_one_lookup) { report.outcome = 'inconclusive'; report.stage = 'seed_prerequisites_missing'; break; }
        replay = replayRequest(seed, response);
      } else {
        if (index === 1) report.replay_cache_read_observed = phase.usage.native.cache_read_input_tokens > 0;
        if (index === 2) report.identical_replay_cache_read_observed = phase.usage.native.cache_read_input_tokens > 0;
        phase.no_further_tool_calls = !response.output.some(item => ['function_call', 'custom_tool_call'].includes(item.type));
        if (!phase.no_further_tool_calls) { report.outcome = 'inconclusive'; report.stage = 'unexpected_tool_request'; break; }
        // Observe a narrow instruction-following marker without emitting content.
        phase.expected_visible_marker = response.output.filter(item => item.type === 'message')
          .flatMap(item => item.content || []).filter(part => part.type === 'output_text').map(part => part.text).join('').trim() === 'LIVE_HOIST_OK';
        if (!phase.expected_visible_marker) { report.outcome = 'inconclusive'; report.stage = 'unexpected_visible_output'; break; }
      }
      if (index === 2) {
        report.stage = 'local_changed_instruction'; expectedCall = 0;
        const count = report.provider_calls, rowCount = rows.length;
        const negative = await localRequest(changedDeveloperRequest(replay), key.key); await settled();
        assert.equal(negative.status, 409);
        assert.equal(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(negative.bytes)).error.code, 'invalid_reasoning_state');
        assert.equal(report.provider_calls, count); assert.equal(historyRows().length, rowCount);
        report.local_changed_instruction_rejected = true;
        report.no_hidden_retries = report.provider_calls === 3 && report.local_requests === 4;
        report.outcome = 'pass'; report.stage = 'completed';
      }
    }
  } catch { report.outcome = 'failed'; }
  finally {
    activeRequest?.destroy();
    if (appServer) { appServer.closeAllConnections(); await new Promise(resolve => appServer.close(resolve)); }
    if (db?.open) {
      report.no_stored_content = db.prepare('SELECT COUNT(*) AS n FROM request_log WHERE full_prompt IS NOT NULL OR full_response IS NOT NULL OR prompt_preview IS NOT NULL').get().n === 0;
      report.history_rows = historyRows().length; db.close();
    }
    restoreHttps?.();
    restorePush?.();
    if (report.outcome === 'pass' && (!report.no_stored_content || !report.no_hidden_retries)) report.outcome = 'failed';
    output(); clearTimeout(deadline); process.exitCode = report.outcome === 'pass' ? 0 : 1;
  }
}

if (process.argv[1] === '-' && import.meta.url.endsWith('/[eval1]')) await runLiveProbe();
