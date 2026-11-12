import { readFileSync, realpathSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, sep } from 'node:path';

const MODEL = 'claude-opus-5-5', TARGET = 'BACKEND_JADE_739';
const report = { ok: false, functional_pass: false, automatic_compaction_pass: false, cache_qualified: false,
  run_label: 'real-proxy-cli-backend-auto-compaction', model: MODEL,
  route: 'test caller -> unchanged dist acquireCliSession -> unchanged CliWorker/SDK/CLI -> unchanged private forwarder -> actual Anthropic',
  limits: { provider_calls: 12, watchdog_ms: 900000 },
  requested_threshold: { autoCompactWindow: 100000, official_percent_override: 10 },
  threshold_note: 'SDK-reported display is recorded separately; it may omit the percentage override. Actual compact boundary pre/post counts are not invented.',
  default_full_window_verified: false, source_context: { files: [], bytes: 0 },
  auth: { source: 'operating official CLI store, read-only', automatic_refresh: false, credential_exported: false },
  provider_calls: 0, distinct_backend_sessions: 0, rounds: [], hooks: [], boundaries: [], context_snapshots: [],
  native_block_roundtrip: { scope: 'returned native blocks -> caller history -> registry input, not a second provider wire observer', returned: 0, replayed: 0, mismatches: 0 },
  checks: {},
};
class ProbeError extends Error { constructor(code) { super(code); this.code = code; } }
const allowedErrors = new Set(['operator_start_required', 'invalid_isolation_configuration', 'invalid_source_context',
  'credential_unavailable', 'watchdog_timeout', 'provider_budget_exceeded', 'backend_turn_failed',
  'unexpected_model', 'unexpected_tool', 'fixture_not_called', 'fixture_repeated', 'initial_reply_mismatch',
  'followup_reply_mismatch', 'retention_mismatch', 'usage_accounting_mismatch', 'wire_usage_aggregated',
  'automatic_compaction_not_observed', 'backend_session_changed', 'native_history_changed', 'cleanup_failed']);
const abortController = new AbortController();
let registry, closeSessions, resolveCredential, db, activeSession, watchdog;
const readers = new Map(), contextWaiters = new Map(), remembered = new Map();
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const counters = ['inputTokens', 'outputTokens', 'cacheCreationInputTokens', 'cacheReadInputTokens', 'cacheCreation5mTokens', 'cacheCreation1hTokens'];
const wireFields = { inputTokens: 'input_tokens', outputTokens: 'output_tokens', cacheCreationInputTokens: 'cache_creation_input_tokens', cacheReadInputTokens: 'cache_read_input_tokens' };
function check(condition, code) { if (!condition) throw new ProbeError(code); }
function numericUsage(value, fields) { return Object.fromEntries(fields.map(key => [key, Number.isSafeInteger(value?.[key]) && value[key] >= 0 ? value[key] : null])); }
function metadata(value) {
  const output = { trigger: ['auto', 'manual'].includes(value?.trigger) ? value.trigger : null };
  for (const key of ['pre_tokens', 'post_tokens', 'duration_ms', 'cumulative_dropped_tokens']) output[key] = Number.isFinite(value?.[key]) && value[key] >= 0 ? value[key] : null;
  return output;
}
function attach(session) {
  if (readers.has(session.id)) return;
  const reader = createInterface({ input: session.child.stdout, crlfDelay: Infinity }); readers.set(session.id, reader);
  reader.on('line', line => {
    let value; try { value = JSON.parse(line); } catch { return; }
    if (value.type === 'backend_test_hook') report.hooks.push({ phase: value.phase, trigger: value.trigger });
    else if (value.type === 'compact_boundary') report.boundaries.push(metadata(value.compact_metadata));
    else if (value.type === 'backend_test_context') {
      const waiter = contextWaiters.get(value.request_id); contextWaiters.delete(value.request_id);
      if (waiter) { const { type, request_id, ...safe } = value; waiter({ ...safe, source: 'official SDK summary: actual last usage plus local estimates' }); }
    }
  });
}
async function context(label) {
  if (!activeSession || activeSession.closed) return;
  const id = randomUUID(); let timer;
  const value = await new Promise(async done => {
    contextWaiters.set(id, done); timer = setTimeout(() => { contextWaiters.delete(id); done({ unavailable: true }); }, 10000);
    try { await activeSession.send({ type: 'backend_test_context', request_id: id }); }
    catch { contextWaiters.delete(id); done({ unavailable: true }); }
  });
  clearTimeout(timer); report.context_snapshots.push({ label, ...value });
}
function sourceContext() {
  const root = realpathSync('/source-context'), paths = ['integration/cli-backend/worker.mjs', 'integration/cli-backend/history.mjs', 'src/services/cliSessions.ts'];
  const bodies = [];
  for (const relative of paths) {
    const path = realpathSync(resolve(root, relative.split('/').at(-1))); check(path.startsWith(root + sep) && statSync(path).isFile(), 'invalid_source_context');
    const bytes = readFileSync(path); report.source_context.bytes += bytes.length; check(report.source_context.bytes <= 128000, 'invalid_source_context');
    report.source_context.files.push({ path: relative, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    bodies.push('SOURCE FILE ' + relative + '\n' + new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  }
  return bodies.join('\n\n');
}
function observeReturned(blocks) {
  for (const block of blocks) if (['thinking', 'redacted_thinking'].includes(block.type)) {
    remembered.set(digest(block), structuredClone(block)); report.native_block_roundtrip.returned++;
  }
}
function observeInput(messages) {
  for (const message of messages) if (message.role === 'assistant') for (const block of message.content ?? []) {
    if (!['thinking', 'redacted_thinking'].includes(block.type)) continue;
    const prior = remembered.get(digest(block));
    if (prior && digest(prior) === digest(block)) report.native_block_roundtrip.replayed++;
    else report.native_block_roundtrip.mismatches++;
  }
  check(report.native_block_roundtrip.mismatches === 0, 'native_history_changed');
}
async function turn(name, body) {
  check(report.provider_calls < 12 && !abortController.signal.aborted, 'provider_budget_exceeded');
  const credential = await resolveCredential(() => abortController.signal.aborted);
  check(Boolean(credential), 'credential_unavailable');
  let lease, counted=false, recorded=false;
  try {
    lease = await registry(body, 'private-backend-auto-test-20261112', credential, abortController.signal);
    activeSession = lease.session; attach(activeSession); report.distinct_backend_sessions=readers.size; observeInput(lease.messages);
    for await (const event of activeSession.events()) if (event.type === 'message_start') check(event.message?.model === MODEL, 'unexpected_model');
    const message = structuredClone(activeSession.message); check(message?.model === MODEL, 'unexpected_model');
    const requests = [...(activeSession.upstream.requests ?? [])]; await Promise.all(requests.map(request => request.done));
    const actual = requests.map(request => ({ kind: request.kind, usage: numericUsage(request.usage.snapshot(), counters) }));
    report.provider_calls += actual.length; counted=true; check(report.provider_calls <= 12, 'provider_budget_exceeded');
    const accounting = numericUsage(activeSession.turnUsage, counters), inference = actual.filter(value => value.kind === 'inference');
    check(inference.length === 1, 'usage_accounting_mismatch');
    for (const field of counters) {
      const known = actual.map(value => value.usage[field]).filter(value => value !== null);
      const expected = known.length ? known.reduce((sum, value) => sum + value, 0) : null;
      check(accounting[field] === expected, 'usage_accounting_mismatch');
    }
    const wire = numericUsage(message.usage, Object.values(wireFields));
    for (const [field, key] of Object.entries(wireFields)) if (wire[key] !== null && inference[0].usage[field] !== null) check(wire[key] === inference[0].usage[field], 'wire_usage_aggregated');
    report.rounds.push({ name, provider_calls: actual.length, requests: actual, turn_usage: accounting, wire_usage: wire,
      stop_reason: message.stop_reason, native_blocks: message.content.map(block => block.type),
      backend_compactions: activeSession.compactions, boundary: activeSession.lastCompaction ? metadata(activeSession.lastCompaction) : null });
    recorded=true;
    observeReturned(message.content); activeSession.commit(lease.messages);
    return { message, history: [...body.messages, { role: 'assistant', content: message.content }] };
  } catch(error) {
    if(lease&&!recorded){
      const requests=[...(lease.session.upstream.requests??[])];
      lease.session.fail(error instanceof Error?error:new ProbeError('backend_turn_failed'));
      await Promise.all(requests.map(request=>request.done));
      if(!counted)report.provider_calls+=requests.length;
      report.rounds.push({name,failed:true,provider_calls:requests.length,requests:requests.map(request=>({kind:request.kind,usage:numericUsage(request.usage.snapshot(),counters)}))});
    }
    throw error;
  } finally { lease?.detach(); }
}
const text = message => message.content.filter(block => block.type === 'text').map(block => block.text).join('').trim();
try {
  check(process.env.BACKEND_LIVE_TEST_RUN === 'approved', 'operator_start_required');
  check(process.env.DATABASE_PATH === ':memory:' && process.env.UPSTREAM_AUTH_SOURCE === 'claude_cli' && process.env.CLAUDE_AUTH_AUTO_REFRESH === 'false'
    && process.env.CLAUDE_CONFIG_DIR === '/operating-auth' && process.env.CLAUDE_INFERENCE_BACKEND === 'cli'
    && process.env.CLAUDE_CLI_AUTO_COMPACT_WINDOW === '100000', 'invalid_isolation_configuration');
  const source = sourceContext();
  ({ acquireCliSession: registry, closeCliSessions: closeSessions } = await import('/app/dist/services/cliSessions.js'));
  ({ resolveUpstreamCredential: resolveCredential } = await import('/app/dist/services/settingsService.js'));
  ({ db } = await import('/app/dist/db/connection.js'));
  check(Boolean(await resolveCredential()), 'credential_unavailable');
  watchdog = setTimeout(() => { abortController.abort(); activeSession?.close(); }, 900000);
  const base = { model: MODEL, max_tokens: 4096, stream: true, thinking: { type: 'adaptive' }, output_config: { effort: 'medium' },
    tools: [{ name: 'read_project_state', description: 'Return the current project code, value and real project source exactly once.',
      input_schema: { type: 'object', properties: { operation: { const: 'read_project_state', type: 'string' } }, required: ['operation'], additionalProperties: false } }] };
  let history = [{ role: 'user', content: [{ type: 'text', text: 'Call read_project_state once with operation read_project_state. Remember its exact project code and value and inspect its real source. Remember the exported worker class, native-history materializer function and session-acquisition function identifiers. Then solve and verify the unique integer N in 0 <= N < 215441 satisfying N mod 17 = 4, N mod 19 = 17, N mod 23 = 18, N mod 29 = 3. Retain all of this across the conversation. After the tool succeeds, reply with only BACKEND_INITIAL_OK:<N>. Do not invoke compaction commands.' }] }];
  let next = await turn('initial_tool_request', { ...base, messages: history }); history = next.history;
  const calls = next.message.content.filter(block => block.type === 'tool_use');
  check(next.message.stop_reason === 'tool_use' && calls.length === 1, 'fixture_not_called');
  check(calls[0].name === 'read_project_state' && calls[0].input.operation === 'read_project_state', 'unexpected_tool');
  history.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: calls[0].id, content: JSON.stringify({ project_code: TARGET, value: 5, source_context: source }) }] });
  next = await turn('initial_tool_result', { ...base, messages: history }); history = next.history;
  check(text(next.message) === 'BACKEND_INITIAL_OK:173829', 'initial_reply_mismatch');
  report.checks.actual_caller_tool_result = true; await context('after-initial-tool');
  async function say(name, prompt, expected) {
    history.push({ role: 'user', content: [{ type: 'text', text: prompt }] });
    const result = await turn(name, { ...base, messages: history }); history = result.history;
    check(!result.message.content.some(block => block.type === 'tool_use'), 'fixture_repeated');
    check(text(result.message) === expected, 'followup_reply_mismatch'); await context(name); return result;
  }
  const warm = await say('warm_cache', 'Retain the project source, code, fixture value and computed N. Do not call tools. Reply with exactly BACKEND_WARM_OK.', 'BACKEND_WARM_OK');
  report.checks.warm_cache_read = warm.message.usage?.cache_read_input_tokens === undefined ? null : warm.message.usage.cache_read_input_tokens > 0;
  for (let index = 1; index <= 3 && !report.boundaries.some(value => value.trigger === 'auto') && report.provider_calls < 8; index++) {
    await say('ordinary-' + index, `Retain the source identifiers, exact code, value and N. Do not call tools or slash commands. Reply with exactly BACKEND_CONTINUE_${index}_OK.`, `BACKEND_CONTINUE_${index}_OK`);
  }
  const retained = await say('retained_source_tool_state', 'Without tools, retrieve the project code, fixture integer value and remembered N. Compute checksum=(37*N+11) mod 100000. Retrieve the worker class, native-history materializer and session-acquisition identifiers from the source you read earlier. Reply with exactly six space-separated fields: project code, fixture value, checksum, worker class identifier, materializer identifier, session-acquisition identifier.',
    TARGET + ' 5 31684 CliWorker nativeHistoryEntries acquireCliSession');
  report.checks.retained_source_tool_reasoning_state = true;
  const after = await say('post_compact_cache', 'Reply with exactly BACKEND_AFTER_CACHE_OK.', 'BACKEND_AFTER_CACHE_OK');
  report.checks.after_cache_read = after.message.usage?.cache_read_input_tokens === undefined ? null : after.message.usage.cache_read_input_tokens > 0;
  report.checks.automatic_boundary = report.boundaries.some(value => value.trigger === 'auto');
  report.checks.automatic_pre_post_hooks = report.hooks.some(value => value.phase === 'pre' && value.trigger === 'auto') && report.hooks.some(value => value.phase === 'post' && value.trigger === 'auto');
  report.checks.no_manual_compaction = report.boundaries.every(value => value.trigger === 'auto') && report.hooks.every(value => value.trigger === 'auto');
  report.checks.main_wire_usage_not_aggregated = true; report.checks.all_internal_usage_accounted = true;
  report.checks.same_live_backend_session=report.distinct_backend_sessions===1;
  report.functional_pass = true;
  report.automatic_compaction_pass = report.checks.automatic_boundary && report.checks.automatic_pre_post_hooks && report.checks.no_manual_compaction && report.checks.same_live_backend_session;
  report.cache_qualified = report.checks.warm_cache_read === true && report.checks.after_cache_read === true;
  report.ok = report.functional_pass && report.automatic_compaction_pass;
  if (!report.ok) { report.error = report.checks.same_live_backend_session ? 'automatic_compaction_not_observed' : 'backend_session_changed'; process.exitCode = 1; }
} catch (error) {
  report.error = abortController.signal.aborted ? 'watchdog_timeout' : error instanceof ProbeError && allowedErrors.has(error.code) ? error.code : 'backend_turn_failed';
  report.ok = false; report.functional_pass = false; process.exitCode = 1;
} finally {
  clearTimeout(watchdog); abortController.abort();
  for (const done of contextWaiters.values()) done({ unavailable: true }); contextWaiters.clear();
  try { await closeSessions?.(); for (const reader of readers.values()) reader.close(); db?.close(); }
  catch { report.ok = false; report.error ??= 'cleanup_failed'; process.exitCode = 1; }
  process.stdout.write(JSON.stringify(report) + '\n');
}
