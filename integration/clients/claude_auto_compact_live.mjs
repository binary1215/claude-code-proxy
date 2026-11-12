import { query, createSdkMcpServer, tool } from '../cli-backend/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';
import { z } from '../cli-backend/node_modules/zod/index.js';
import http from 'node:http';
import { once } from 'node:events';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, mkdirSync, rmSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep, relative } from 'node:path';

// Independent, unchanged official CLI/SDK client. Only stdin supplies the
// restricted gateway key. The observer forwards the client's bytes unchanged.
const {values: flags} = parseArgs({options:{'base-url':{type:'string',default:'http://192.168.0.7:4000'},model:{type:'string',default:'claude-opus-5-5-han'},'canonical-model':{type:'string',default:'claude-opus-5-5'},'cli-path':{type:'string'},'context-dir':{type:'string'},'context-file':{type:'string',multiple:true,default:[]},'auto-percent':{type:'string',default:'10'}}});
const MODEL = flags.model;
const EXPECTED_MODEL = flags['canonical-model'];
const AUTO_PERCENT = Number(flags['auto-percent']);
const ALLOWED_SSE_MODELS = new Set([MODEL, EXPECTED_MODEL]);
const BASE = flags['base-url'];
const PROJECT_CODE = 'NATIVE_JADE_739';
const TOOL_NAME = 'mcp__native_fixture__read_project_code';
const MAX_REQUESTS = 12;
class ProbeError extends Error { constructor(code) { super(code); this.code = code; } }
class InputQueue {
  items = []; waiting = []; closed = false;
  push(value) { if (this.closed) throw new ProbeError('input_closed'); const next = this.waiting.shift(); next ? next({ value, done: false }) : this.items.push(value); }
  next() { if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false }); if (this.closed) return Promise.resolve({ done: true }); return new Promise(next => this.waiting.push(next)); }
  close() { this.closed = true; this.items.length = 0; for (const next of this.waiting.splice(0)) next({ done: true }); }
  [Symbol.asyncIterator]() { return this; }
}
const report = {
  ok: false, functional_pass: false, qualification_pass: false,
  client: 'official-agent-sdk-0.3.322-cli-2.1.322', model_alias: MODEL, expected_model: EXPECTED_MODEL,
  run_label: 'official-native-client-genuine-automatic-compaction',
  automatic_compaction_pass: false,
  threshold: {layer:'native-Claude-Code-client',window:100000,percent:AUTO_PERCENT,source:'documented SDK settings and official CLI environment; actual provider usage is not changed',default_full_window_verified:false,context_snapshots:[]},
  source_context: {files:0,bytes:0,artifacts:[]},
  alias_mapping: { requested: MODEL, configured_canonical: EXPECTED_MODEL,
    accepted_sse_models: [...ALLOWED_SSE_MODELS], configuration_source: 'LiteLLM owner confirmed static Han route; no fallback',
    observation_scope: 'client response model may be public alias; gateway-to-Han model is not visible to this observer' },
  route: 'official-cli -> passive-observer -> LiteLLM .7 -> operating Han',
  actions: [], compaction: { boundaries: [], pre: [], post: [] },
  observer: { scope: 'client-to-gateway only; gateway-to-Han is opaque', requests: 0, statuses: [], models: [], native_usage: [],
    returned_thinking: 0, returned_signed_thinking: 0, returned_redacted: 0,
    replayed_thinking: 0, replayed_signed_thinking: 0, replayed_redacted: 0,
    signature_content_mismatches: 0, unrecognized_replayed_blocks: 0, hashes: [] },
  fixture: { calls: 0, arguments_valid: true }, checks: {},
};
const codes = new Set(['missing_stdin_key', 'invalid_stdin_key', 'watchdog_timeout', 'sdk_initialization_failed',
  'sdk_action_failed', 'sdk_stream_ended', 'sdk_stream_failed', 'provider_stream_error', 'unexpected_model',
  'retry_attempted', 'fallback_attempted', 'unexpected_tool_call', 'request_budget_exceeded', 'observer_failed',
  'initial_marker_mismatch', 'fixture_tool_not_observed', 'fixture_tool_repeated', 'warm_marker_mismatch',
  'warm_cache_not_observed', 'compaction_not_observed', 'compaction_hooks_not_observed', 'compaction_command_failed',
  'retained_project_code_mismatch', 'retained_tool_value_mismatch', 'after_marker_mismatch', 'after_cache_not_observed',
  'missing_native_reply', 'thinking_not_emitted', 'signed_thinking_not_replayed', 'thinking_content_changed',
  'input_closed', 'cleanup_failed', 'invalid_test_configuration', 'invalid_context_source', 'context_usage_unavailable']);
const queue = new InputQueue(), abortController = new AbortController();
let currentQuery, currentAction, terminalError, directory, consumption, observer, watchdog;
let finished = false, clientCompacting = false, sourceContext = '';
function loadSourceContext(){
  if(!flags['context-dir'] || !flags['context-file'].length) throw new ProbeError('invalid_context_source');
  const root=realpathSync(flags['context-dir']), entries=[],artifacts=[]; let bytes=0;
  for(const selected of flags['context-file']){
    const path=realpathSync(resolve(root,selected));
    if(!path.startsWith(root+sep)||!statSync(path).isFile()||/(^\.env(?:\.|$)|\.(?:pem|key)$|(?:token|credential|secret).*\.(?:txt|json)$)/i.test(basename(path)))throw new ProbeError('invalid_context_source');
    const content=readFileSync(path,'utf8');bytes+=Buffer.byteLength(content);if(bytes>128000)throw new ProbeError('invalid_context_source');
    entries.push('SOURCE FILE '+relative(root,path)+'\n'+content);
    artifacts.push({path:relative(root,path),bytes:Buffer.byteLength(content),sha256:createHash('sha256').update(content).digest('hex')});
  }
  report.source_context={files:entries.length,bytes,artifacts};return entries.join('\n\n');
}
async function contextSnapshot(label){
  try{const value=await currentQuery.getContextUsage({detail:'summary'});const clean={label,source:'official SDK summary: last real usage plus local estimates'};for(const field of ['totalTokens','maxTokens','rawMaxTokens','autoCompactThreshold'])clean[field]=Number.isFinite(value[field])?value[field]:null;clean.isAutoCompactEnabled=value.isAutoCompactEnabled===true;report.threshold.context_snapshots.push(clean);}
  catch{report.threshold.context_snapshots.push({label,unavailable:true});}
}
const outgoing = new Set(), returned = new Map(), signed = new Map();
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
function fail(code) {
  if (terminalError) return;
  terminalError = new ProbeError(codes.has(code) ? code : 'sdk_stream_failed');
  try { currentQuery?.close(); } catch {}
  abortController.abort(); currentAction?.reject(terminalError);
  for (const request of outgoing) request.destroy();
}
function requireCheck(condition, code) { if (!condition) throw new ProbeError(code); }
function observeUsage(action, value) {
  if (!value || typeof value !== 'object') return;
  for (const key of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) {
    if (Number.isSafeInteger(value[key]) && value[key] >= 0) action.usage[key] = value[key];
  }
}
function compactMetadata(source) {
  const result = {};
  if (['manual', 'auto'].includes(source?.trigger)) result.trigger = source.trigger;
  for (const key of ['pre_tokens', 'post_tokens', 'duration_ms', 'cumulative_dropped_tokens']) if (Number.isFinite(source?.[key]) && source[key] >= 0) result[key] = source[key];
  return result;
}
function observeReturned(block, requestNumber) {
  if (!['thinking', 'redacted_thinking'].includes(block?.type)) return;
  const digest = hash(block);
  returned.set(digest, { type: block.type, request: requestNumber });
  if (block.type === 'thinking') {
    report.observer.returned_thinking++;
    if (typeof block.signature === 'string' && block.signature) { report.observer.returned_signed_thinking++; signed.set(hash(block.signature), digest); }
  } else report.observer.returned_redacted++;
  report.observer.hashes.push({ kind: block.type, direction: 'response', request: requestNumber, sha256: digest });
}
function observeReplay(body, requestNumber) {
  for (const message of body?.messages ?? []) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!['thinking', 'redacted_thinking'].includes(block?.type)) continue;
      const digest = hash(block), previous = returned.get(digest);
      if (block.type === 'thinking' && typeof block.signature === 'string' && block.signature) {
        const original = signed.get(hash(block.signature));
        if (original && original !== digest) report.observer.signature_content_mismatches++;
      }
      if (!previous || previous.request >= requestNumber) { report.observer.unrecognized_replayed_blocks++; continue; }
      if (block.type === 'thinking') {
        report.observer.replayed_thinking++;
        if (typeof block.signature === 'string' && block.signature) report.observer.replayed_signed_thinking++;
      } else report.observer.replayed_redacted++;
      report.observer.hashes.push({ kind: block.type, direction: 'later-request', request: requestNumber, returned_on: previous.request, sha256: digest });
    }
  }
}
function sseObserver(requestNumber) {
  let pending = '', decoder = new TextDecoder();
  const blocks = new Map();
  const usage={input_tokens:null,output_tokens:null,cache_creation_input_tokens:null,cache_read_input_tokens:null};
  report.observer.native_usage.push({request:requestNumber,usage});
  const frame = raw => {
    const data = raw.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    let event; try { event = JSON.parse(data); } catch { fail('observer_failed'); return; }
    if (event.type === 'message_start') {
      observeUsage({usage},event.message?.usage);
      const model = event.message?.model;
      if (typeof model === 'string' && !report.observer.models.includes(model)) report.observer.models.push(model);
      if (!ALLOWED_SSE_MODELS.has(model)) fail('unexpected_model');
    } else if(event.type==='message_delta') observeUsage({usage},event.usage);
    else if (event.type === 'content_block_start') blocks.set(event.index, structuredClone(event.content_block));
    else if (event.type === 'content_block_delta') {
      const block = blocks.get(event.index), delta = event.delta;
      if (block?.type === 'thinking' && delta?.type === 'thinking_delta') block.thinking = (block.thinking ?? '') + delta.thinking;
      else if (block?.type === 'thinking' && delta?.type === 'signature_delta') block.signature = delta.signature;
    } else if (event.type === 'content_block_stop') { observeReturned(blocks.get(event.index), requestNumber); blocks.delete(event.index); }
    else if (event.type === 'error') fail('provider_stream_error');
  };
  return { write(chunk) { pending += decoder.decode(chunk, { stream: true }); const frames = pending.split(/\r?\n\r?\n/); pending = frames.pop(); for (const value of frames) frame(value); },
    end() { pending += decoder.decode(); if (pending.trim()) frame(pending); } };
}
async function startObserver() {
  observer = http.createServer((request, response) => { void (async () => {
    const parts = []; let length = 0;
    for await (const part of request) { length += part.length; if (length > 10 * 1024 * 1024) throw new ProbeError('observer_failed'); parts.push(part); }
    const bytes = Buffer.concat(parts), path = new URL(request.url, BASE);
    const isMessages = request.method === 'POST' && path.pathname === '/v1/messages';
    let number;
    if (isMessages) {
      number = ++report.observer.requests;
      if (number > MAX_REQUESTS) { response.writeHead(429).end(); fail('request_budget_exceeded'); return; }
      const body = JSON.parse(bytes.toString('utf8'));
      if (body.model !== MODEL) { response.writeHead(400).end(); fail('unexpected_model'); return; }
      observeReplay(body, number);
    }
    const headers = { ...request.headers, host: path.host };
    delete headers.connection; delete headers['transfer-encoding'];
    const forward = http.request(path, { method: request.method, headers }, upstream => {
      const copy = { ...upstream.headers }; delete copy.connection; delete copy['transfer-encoding'];
      response.writeHead(upstream.statusCode ?? 502, copy);
      if (isMessages) report.observer.statuses.push({ request: number, action: currentAction?.name ?? 'startup', status: upstream.statusCode ?? 0,kind:clientCompacting?'client-auto-compaction':'ordinary-client-inference' });
      const observe = isMessages && upstream.headers['content-type']?.includes('text/event-stream') ? sseObserver(number) : undefined;
      upstream.on('data', chunk => { observe?.write(chunk); if (!response.write(chunk)) upstream.pause(), response.once('drain', () => upstream.resume()); });
      upstream.on('end', () => { observe?.end(); response.end(); });
      upstream.on('error', () => { response.destroy(); fail('observer_failed'); });
    });
    outgoing.add(forward); forward.once('close', () => outgoing.delete(forward));
    forward.on('error', () => { response.destroy(); if (!finished && !terminalError) fail('observer_failed'); });
    response.on('close', () => { if (!response.writableFinished) forward.destroy(); });
    forward.end(bytes);
  })().catch(() => { response.destroy(); fail('observer_failed'); }); });
  observer.listen(0, '127.0.0.1'); await once(observer, 'listening');
  return `http://127.0.0.1:${observer.address().port}`;
}
async function action(name, content, { command = false, toolExpected = false } = {}) {
  if (terminalError) throw terminalError;
  const state = { name, command, text: '', nativeStarts: 0, nativeStops: 0,
    usage: { input_tokens: null, output_tokens: null, cache_creation_input_tokens: null, cache_read_input_tokens: null } };
  const done = new Promise((resolveAction, reject) => { state.resolve = resolveAction; state.reject = reject; });
  currentAction = state;
  queue.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, ...(command ? {} : { client_composed: true }) });
  await done; currentAction = undefined;
  if (terminalError) throw terminalError;
  report.actions.push({ action: name, success: true, ...(command ? { local_command_compact: state.localCommand === 'compact' } : {
    native_replies: state.nativeStarts, native_completed: state.nativeStops === state.nativeStarts, usage: state.usage }) });
  if (!command && (state.nativeStarts < 1 || state.nativeStops !== state.nativeStarts)) throw new ProbeError('missing_native_reply');
  return state;
}
try {
  const key = readFileSync(0, 'utf8').trim();
  requireCheck(Boolean(key), 'missing_stdin_key'); requireCheck(!/[^\x21-\x7e]/.test(key), 'invalid_stdin_key');
  directory = mkdtempSync(join(tmpdir(), 'native-litellm-'));
  const cwd = join(directory, 'workspace'), configDir = join(directory, 'config'); mkdirSync(cwd, { mode: 0o700 }); mkdirSync(configDir, { mode: 0o700 });
  requireCheck(Number.isInteger(AUTO_PERCENT)&&AUTO_PERCENT>=1&&AUTO_PERCENT<=100,'invalid_test_configuration');
  const targetBase=new URL(BASE);requireCheck(['http:','https:'].includes(targetBase.protocol)&&!targetBase.username&&!targetBase.password,'invalid_test_configuration');
  sourceContext=loadSourceContext();
  watchdog = setTimeout(() => fail('watchdog_timeout'), 900_000);
  const base = await startObserver();
  const fixture = createSdkMcpServer({ name: 'native_fixture', version: '1.0.0', tools: [tool('read_project_code',
    'Return the synthetic project code and integer value used by this no-I/O qualification fixture.', { operation: z.literal('read_project_code') }, async args => {
      report.fixture.calls++; report.fixture.arguments_valid &&= args.operation === 'read_project_code';
      if (report.fixture.calls > 1) { fail('fixture_tool_repeated'); throw new ProbeError('fixture_tool_repeated'); }
      return { content: [{ type: 'text', text: JSON.stringify({ project_code: PROJECT_CODE, value: 5, source_context: sourceContext }) }] };
    })] });
  const env = { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: directory, USERPROFILE: directory, TMPDIR: directory,
    CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(AUTO_PERCENT), CLAUDE_CONFIG_DIR: configDir, ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: key,
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: '4096', CLAUDE_CODE_MAX_RETRIES: '0', CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES: '0',
    CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1', CLAUDE_CODE_NO_MODEL_FALLBACK: '1', CLAUDE_CODE_DISABLE_MODEL_ACCESS_FALLBACK: '1',
    CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK: '1', CLAUDE_CODE_DISABLE_REFUSAL_RETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1', ENABLE_TOOL_SEARCH: 'false' };
  currentQuery = query({ prompt: queue, options: { ...(flags['cli-path']?{pathToClaudeCodeExecutable:flags['cli-path']}:process.platform!=='win32'?{pathToClaudeCodeExecutable:'/usr/local/bin/claude'}:{}), model: MODEL, cwd, env, abortController,
    systemPrompt: { type: 'preset', preset: 'claude_code' }, tools: [], skills: [], plugins: [], mcpServers: { native_fixture: fixture }, strictMcpConfig: true,
    settingSources: [], persistSession: false, includePartialMessages: true, verbatimPrompts: false, effort: 'medium', thinking: { type: 'adaptive' },
    settings: { disableClaudeAiConnectors: true, disableBundledSkills: true, autoMemoryEnabled: false, autoCompactEnabled: true, autoCompactWindow: 100000,
      idleCompaction: false, precomputeCompactionEnabled: false, fallbackModel: [] },
    canUseTool: async (name, input) => { if (name !== TOOL_NAME) { fail('unexpected_tool_call'); throw new ProbeError('unexpected_tool_call'); } return { behavior: 'allow', updatedInput: input }; },
    hooks: { PreCompact: [{ hooks: [async input => { clientCompacting=true; report.compaction.pre.push({ trigger: input.trigger }); return {}; }] }],
      PostCompact: [{ hooks: [async input => { clientCompacting=false; report.compaction.post.push({ trigger: input.trigger,
        retained_target: typeof input.compact_summary === 'string' && input.compact_summary.includes(PROJECT_CODE) }); return {}; }] }] }, stderr: () => {},
  } });
  consumption = (async () => { try {
    for await (const message of currentQuery) {
      if (message.type === 'stream_event') {
        const event = message.event;
        if (event?.type === 'message_start' && !ALLOWED_SSE_MODELS.has(event.message?.model)) { fail('unexpected_model'); break; }
        if (event?.type === 'error') { fail('provider_stream_error'); break; }
        if (!currentAction || currentAction.command || clientCompacting) continue;
        if (event?.type === 'message_start') { currentAction.nativeStarts++; currentAction.text = ''; observeUsage(currentAction, event.message.usage); }
        else if (event?.type === 'content_block_start' && event.content_block?.type === 'tool_use' && event.content_block.name !== TOOL_NAME) { fail('unexpected_tool_call'); break; }
        else if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') currentAction.text += event.delta.text;
        else if (event?.type === 'message_delta') observeUsage(currentAction, event.usage);
        else if (event?.type === 'message_stop') currentAction.nativeStops++;
      } else if (message.type === 'system' && message.subtype === 'compact_boundary') report.compaction.boundaries.push(compactMetadata(message.compact_metadata));
      else if(message.type==='system'&&message.subtype==='status'&&message.status===null&&message.compact_result==='failed'){clientCompacting=false;report.compaction.skipped=(report.compaction.skipped??0)+1;}
      else if (message.type === 'system' && message.subtype === 'api_retry') { fail('retry_attempted'); break; }
      else if (message.type === 'system' && message.subtype === 'model_refusal_fallback') { fail('fallback_attempted'); break; }
      else if (message.type === 'result') {
        if (message.subtype !== 'success' || message.is_error || !currentAction) { report.sdk_failure = { subtype: message.subtype, is_error: Boolean(message.is_error) }; fail('sdk_action_failed'); break; }
        currentAction.localCommand = message.local_command; currentAction.resolve();
      }
    }
    if (!finished && !terminalError) fail('sdk_stream_ended');
  } catch { if (!finished) fail('sdk_stream_failed'); } })();
  try { await currentQuery.initializationResult(); } catch { throw terminalError ?? new ProbeError('sdk_initialization_failed'); }
  await contextSnapshot('initial-ready');
  const initial = await action('initial_client_tool', `This is a genuine automatic-compaction qualification using real project source. First call the ${TOOL_NAME} tool exactly once with operation read_project_code. Remember the exact project_code, integer value, and relevant source context returned by that tool. From the supplied source identify and remember the exported CLI worker class, native-history materializer function, and public CLI-session acquisition function. Then find and verify the unique integer N in 0 <= N < 215441 with N mod 17 = 4, N mod 19 = 17, N mod 23 = 18, N mod 29 = 3. Retain N, these three source identifiers, and the tool result throughout this session. Reply with only NATIVE_INITIAL_OK:<N> replacing <N> with the integer. Do not invoke compaction commands.`, {toolExpected:true});
  requireCheck(initial.text.trim()==='NATIVE_INITIAL_OK:173829','initial_marker_mismatch');
  requireCheck(report.fixture.calls===1&&report.fixture.arguments_valid,'fixture_tool_not_observed');
  report.checks.client_owned_tool=true;report.checks.initial_reasoning_solution=true;
  await contextSnapshot('after-initial');
  const warm=await action('warm_cache','Keep the project source, remembered code, integer value and N. Consider which source components matter to a safe small change, but do not repeat source or call any tool. Reply with exactly NATIVE_WARM_OK.');
  requireCheck(warm.text.trim()==='NATIVE_WARM_OK','warm_marker_mismatch');
  report.checks.warm_cache_read=warm.usage.cache_read_input_tokens===null?null:warm.usage.cache_read_input_tokens>0;
  await contextSnapshot('after-warm');
  // Normal user turns age the real source/tool round out of the protected recent
  // segment. The official CLI alone chooses whether and when to auto-compact.
  for(let round=1;round<=3&&!report.compaction.boundaries.some(value=>value.trigger==='auto')&&report.observer.requests<8;round++){
    const next=await action(`ordinary_continuation_${round}`,`Retain the project context, exact code, fixture value, and computed N. This is continuation ${round}; do not call any tool or any slash command. Reply with exactly NATIVE_CONTINUE_${round}_OK.`);
    requireCheck(next.text.trim()===`NATIVE_CONTINUE_${round}_OK`,'after_marker_mismatch');
    await contextSnapshot(`after-continuation-${round}`);
  }
  report.checks.automatic_compaction_boundary=report.compaction.boundaries.some(value=>value.trigger==='auto');
  report.checks.automatic_compaction_hooks=report.compaction.pre.some(value=>value.trigger==='auto')&&report.compaction.post.some(value=>value.trigger==='auto');
  report.checks.no_manual_compaction=report.compaction.boundaries.every(value=>value.trigger==='auto')&&report.compaction.pre.every(value=>value.trigger==='auto');
  const retained = await action('retained_tool_result', 'Without calling any tool, retrieve the exact project code and integer value returned by the fixture tool and the remembered N from the earlier congruence solution. Using that remembered N, carefully compute checksum = (37 * N + 11) mod 100000 and verify it. Also retrieve the exported worker class, native-history materializer function, and public CLI-session acquisition function from the source you read earlier. Reply with exactly six space-separated fields: project code, fixture integer value, checksum, worker class identifier, native-history materializer identifier, CLI-session acquisition identifier.');
  requireCheck(retained.text.trim() === `${PROJECT_CODE} 5 31684 CliWorker nativeHistoryEntries acquireCliSession`, 'retained_project_code_mismatch');
  report.checks.retained_tool_result = true; report.checks.retained_reasoning_checksum = true; report.checks.retained_source_identifiers=true;
  const after = await action('after_compaction_cache', 'Reply with exactly NATIVE_AFTER_CACHE_OK.');
  requireCheck(after.text.trim() === 'NATIVE_AFTER_CACHE_OK', 'after_marker_mismatch');
  report.checks.after_compaction_cache_read = after.usage.cache_read_input_tokens === null ? null : after.usage.cache_read_input_tokens > 0;
  report.functional_pass = true;
  report.automatic_compaction_pass=report.checks.automatic_compaction_boundary&&report.checks.automatic_compaction_hooks&&report.checks.no_manual_compaction;
  await contextSnapshot('after-retention-and-cache');
  report.checks.thinking_emitted = report.observer.returned_thinking + report.observer.returned_redacted > 0;
  report.checks.signed_thinking_replayed = report.checks.thinking_emitted
    ? report.observer.replayed_signed_thinking > 0 || report.observer.replayed_redacted > 0 : null;
  requireCheck(report.observer.signature_content_mismatches === 0 && report.observer.unrecognized_replayed_blocks === 0, 'thinking_content_changed');
  report.checks.actual_returned_blocks_preserved = report.checks.signed_thinking_replayed === true ? true : null;
  report.checks.configured_model_ids_only = true; report.checks.no_retry_or_fallback = true;
  report.alias_mapping.public_alias_seen = report.observer.models.includes(MODEL);
  report.alias_mapping.canonical_id_seen = report.observer.models.includes(EXPECTED_MODEL);
  report.qualification_pass = report.automatic_compaction_pass && report.checks.warm_cache_read === true && report.checks.after_compaction_cache_read === true
    && report.checks.thinking_emitted && report.checks.signed_thinking_replayed === true;
  report.ok = report.functional_pass && report.automatic_compaction_pass;
  if(!report.ok){report.error='compaction_not_observed';process.exitCode=1;}
} catch (error) {
  report.error = terminalError?.code ?? (error instanceof ProbeError && codes.has(error.code) ? error.code : 'sdk_stream_failed');
  report.ok = false; report.functional_pass = false; report.automatic_compaction_pass = false; report.qualification_pass = false; process.exitCode = 1;
} finally {
  finished = true; clearTimeout(watchdog); try { currentQuery?.close(); } catch {} abortController.abort(); queue.close();
  for (const request of outgoing) request.destroy(); if (consumption) await consumption;
  if (observer) { observer.closeAllConnections(); await new Promise(done => observer.close(done)); }
  if (directory) try { const target = resolve(directory); if (!target.startsWith(resolve(tmpdir()) + sep) || !basename(target).startsWith('native-litellm-')) throw new ProbeError('cleanup_failed'); rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  catch { report.ok = false; report.functional_pass = false; report.qualification_pass = false; report.error ??= 'cleanup_failed'; process.exitCode = 1; }
  // Receipt contains only fixture booleans, counts, known IDs and hashes.
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
