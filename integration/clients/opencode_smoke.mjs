#!/usr/bin/env node
// Test-only: unmodified, explicitly selected OpenCode binary against a fake provider.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, realpath } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const expectedVersion = '1.18.34';
const binaryArgument = process.argv.indexOf('--binary');
assert(binaryArgument >= 0 && process.argv[binaryArgument + 1], 'Pass --binary /absolute/path/to/opencode.exe');
const binary = await realpath(process.argv[binaryArgument + 1]);
const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-fidelity-'));
const fixtureDirectory = path.join(root, 'fixture');
const fixturePath = path.join(fixtureDirectory, 'fixture.txt');
const fixtureText = 'SYNTHETIC_LOCAL_FIXTURE_7f352a';
const thinking = 'Synthetic reasoning: 한글 🧪 only.';
const signature = Buffer.from('synthetic-signature-opencode-fixture').toString('base64');
const redactedData = Buffer.from('synthetic-redacted-opencode-fixture').toString('base64');
const toolID = 'toolu_fake_opencode_01';
const model = 'claude-sonnet-4-6';
const requests = [];
let blockedRequests = 0;
const blockedRequestKinds = { offlineRegistry: 0, officialModels: 0, officialRelease: 0, other: 0 };
let serverError;
let stdoutBytes = 0;
let stderrBytes = 0;
let stderrSample = '';
let output = '';
const sockets = new Set();

function blockedKind(value) {
  if (value.startsWith('/offline-npm/')) return 'offlineRegistry';
  let host;
  try { host = new URL(value.startsWith('http') ? value : `https://${value}`).hostname; } catch { return 'other'; }
  if (host === 'models.opencode.ai' || host === 'models.dev') return 'officialModels';
  if (host === 'api.github.com' || host === 'github.com') return 'officialRelease';
  return 'other';
}

function recordBlocked(value) {
  blockedRequests++;
  blockedRequestKinds[blockedKind(value)]++;
}

await mkdir(fixtureDirectory, { recursive: true });
await writeFile(fixturePath, `${fixtureText}\n`, 'utf8');
for (const name of ['home', 'config', 'data', 'cache', 'state', 'tmp', 'appdata', 'localappdata', 'programdata']) {
  await mkdir(path.join(root, name), { recursive: true });
}

function event(type, extra = {}) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`;
}

function start(id) {
  return event('message_start', { message: {
    id, type: 'message', role: 'assistant', model, content: [], stop_reason: null,
    stop_sequence: null, usage: { input_tokens: 16, output_tokens: 0 },
  } });
}

function toolResponse() {
  const input = JSON.stringify({ filePath: fixturePath, offset: 1, limit: 1 });
  return start('msg_fake_opencode_01')
    + event('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } })
    + event('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: thinking.slice(0, 22) } })
    + event('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: thinking.slice(22) } })
    + event('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature } })
    + event('content_block_stop', { index: 0 })
    + event('content_block_start', { index: 1, content_block: { type: 'redacted_thinking', data: redactedData } })
    + event('content_block_stop', { index: 1 })
    + event('content_block_start', { index: 2, content_block: { type: 'tool_use', id: toolID, name: 'read', input: {} } })
    + event('content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: input.slice(0, 19) } })
    + event('content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: input.slice(19) } })
    + event('content_block_stop', { index: 2 })
    + event('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 24 } })
    + event('message_stop');
}

function finalResponse() {
  return start('msg_fake_opencode_02')
    + event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
    + event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'SYNTHETIC_SMOKE_COMPLETE' } })
    + event('content_block_stop', { index: 0 })
    + event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } })
    + event('message_stop');
}

const server = http.createServer(async (req, res) => {
  // Also acts as an explicit rejecting proxy and offline npm registry. No forwarding.
  if (req.method !== 'POST' || req.url !== '/v1/messages') {
    recordBlocked(req.url);
    req.resume();
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end('{"error":{"type":"offline_smoke_only","message":"No external service allowed"}}');
    return;
  }
  try {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      assert(bytes <= 1024 * 1024, 'Client request exceeds test-only 1MiB bound');
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.equal(body.model, model);
    assert.equal(body.stream, true);
    assert.equal(req.headers['x-api-key'], 'synthetic-local-key-not-a-provider-secret');
    assert.equal(req.headers.authorization, undefined);
    assert(Array.isArray(body.tools) && body.tools.length === 1 && body.tools[0].name === 'read',
      'Only the tiny-fixture read tool may be exposed');
    requests.push(body);
    assert(requests.length <= 2, 'Unexpected auxiliary or repeated model request');
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'request-id': 'req_fake_opencode_01' });
    const bytesOut = Buffer.from(requests.length === 1 ? toolResponse() : finalResponse());
    // Small chunks split event framing, JSON, signature, and UTF-8 byte sequences.
    for (let i = 0; i < bytesOut.length; i += 7) {
      if (res.destroyed) break;
      res.write(bytesOut.subarray(i, i + 7));
      await delay(1);
    }
    res.end();
  } catch (error) {
    serverError = error;
    res.destroy();
  }
});
server.on('connection', (socket) => {
  sockets.add(socket);
  // The rejecting CONNECT proxy can be reset by the client; that is not a test failure.
  socket.on('error', () => {});
  socket.on('close', () => sockets.delete(socket));
});
server.on('connect', (req, socket) => {
  recordBlocked(req.url);
  socket.end('HTTP/1.1 502 Offline Smoke Only\r\nConnection: close\r\n\r\n');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

// Deliberately do not spread process.env: auth, proxy, account, and config state do not inherit.
const env = {};
for (const name of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'COMSPEC', 'PATHEXT']) {
  if (process.env[name]) env[name] = process.env[name];
}
Object.assign(env, {
  PATH: [path.dirname(binary), path.dirname(process.execPath), path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32')].join(path.delimiter),
  USERPROFILE: path.join(root, 'home'), HOME: path.join(root, 'home'), OPENCODE_TEST_HOME: path.join(root, 'home'),
  APPDATA: path.join(root, 'appdata'), LOCALAPPDATA: path.join(root, 'localappdata'), ProgramData: path.join(root, 'programdata'),
  XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'),
  XDG_CACHE_HOME: path.join(root, 'cache'), XDG_STATE_HOME: path.join(root, 'state'),
  TEMP: path.join(root, 'tmp'), TMP: path.join(root, 'tmp'), TMPDIR: path.join(root, 'tmp'),
  OPENCODE_DB: path.join(root, 'state', 'smoke.sqlite'),
  OPENCODE_PURE: 'true', OPENCODE_DISABLE_PROJECT_CONFIG: 'true', OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
  OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_DISABLE_PRUNE: 'true',
  OPENCODE_DISABLE_AUTOCOMPACT: 'true', OPENCODE_DISABLE_TERMINAL_TITLE: 'true', OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true',
  OPENCODE_DISABLE_LSP_DOWNLOAD: 'true', OPENCODE_DISABLE_CLAUDE_CODE: 'true', OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: 'true',
  HTTP_PROXY: origin, HTTPS_PROXY: origin, ALL_PROXY: origin, NO_PROXY: '127.0.0.1,localhost',
  http_proxy: origin, https_proxy: origin, all_proxy: origin, no_proxy: '127.0.0.1,localhost',
  npm_config_registry: `${origin}/offline-npm/`, npm_config_userconfig: path.join(root, 'home', '.npmrc'),
  OPENCODE_CONFIG_CONTENT: JSON.stringify({
    model: `anthropic/${model}`, small_model: `anthropic/${model}`, enabled_providers: ['anthropic'],
    autoupdate: false, snapshot: false, share: 'disabled', lsp: false, plugin: [], mcp: {},
    permission: { '*': 'deny', read: {
      '*': 'deny', 'fixture.txt': 'allow',
      [`**/${path.basename(root)}/fixture/fixture.txt`]: 'allow',
      [fixturePath.replaceAll('\\', '/')]: 'allow',
    } },
    provider: { anthropic: { options: { apiKey: 'synthetic-local-key-not-a-provider-secret', baseURL: `${origin}/v1` } } },
  }),
});

async function invoke(args, timeoutMs) {
  const child = spawn(binary, args, { cwd: fixtureDirectory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
  child.stdout.on('data', (bytes) => {
    stdoutBytes += bytes.length;
    if (output.length < 64 * 1024) output += bytes.toString('utf8').slice(0, 64 * 1024 - output.length);
  });
  child.stderr.on('data', (bytes) => {
    stderrBytes += bytes.length;
    if (stderrSample.length < 16 * 1024) stderrSample += bytes.toString('utf8').slice(0, 16 * 1024 - stderrSample.length);
  });
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert(!timedOut, 'Actual client exceeded bounded 60s smoke deadline');
    assert.equal(code, 0, `Client exited ${code}; inspect only isolated synthetic log under ${root}`);
  } finally {
    clearTimeout(timer);
  }
}

try {
  await invoke(['--version'], 15_000);
  assert.equal(output.trim(), expectedVersion, 'Use the pinned official release, not an inherited client');
  output = '';
  await invoke(['run', '--format', 'json', '--model', `anthropic/${model}`, '--title', 'Synthetic fidelity smoke', 'Read fixture.txt using the read tool, then finish.'], 60_000);
  if (serverError) throw serverError;
  assert.equal(requests.length, 2, 'Expected exactly one native tool round trip');
  const replay = requests[1].messages;
  const assistantTurns = replay.filter((message) => message.role === 'assistant');
  assert.equal(assistantTurns.length, 1, 'Expected one assistant history turn, not duplicated or regrouped turns');
  assert.deepEqual(assistantTurns[0].content, [
    { type: 'thinking', thinking, signature },
    { type: 'redacted_thinking', data: redactedData },
    { type: 'tool_use', id: toolID, name: 'read', input: { filePath: fixturePath, offset: 1, limit: 1 },
      cache_control: { type: 'ephemeral' } },
  ], 'Assistant content changed, reordered, duplicated, or gained extra blocks');
  const toolResults = replay.filter((message) => message.role === 'user')
    .flatMap((message) => Array.isArray(message.content) ? message.content : [])
    .filter((block) => block.type === 'tool_result');
  assert.equal(toolResults.length, 1, 'Expected exactly one user tool_result');
  const result = toolResults[0];
  assert.equal(result.tool_use_id, toolID);
  assert(result, 'Real client did not replay a matching tool_result');
  const readFailure = JSON.stringify(result.content);
  const readFailureKind = /permission|denied|rejected/i.test(readFailure) ? 'permission' : /not found/i.test(readFailure) ? 'not_found' : 'unknown';
  if (result.is_error === true) await writeFile(path.join(root, 'synthetic-tool-error.txt'), readFailure, 'utf8');
  assert.notEqual(result.is_error, true, `Read was denied or failed (${readFailureKind})`);
  assert(JSON.stringify(result.content).includes(fixtureText), 'Tool result did not contain the tiny synthetic fixture');
  const clientEvents = output.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
  assert(!clientEvents.some((value) => value.type === 'error'), 'Client emitted an error event');
  const textEvents = clientEvents.filter((value) => value.type === 'text');
  assert.equal(textEvents.length, 1, 'Expected exactly one completed final text event');
  assert.equal(textEvents[0].part?.text, 'SYNTHETIC_SMOKE_COMPLETE', 'Client final text event is not the exact fake completion');
  const finishes = clientEvents.filter((value) => value.type === 'step_finish');
  assert.deepEqual(finishes.map((value) => value.part?.reason), ['tool-calls', 'stop'],
    'Client did not complete the tool step followed by a successful final stop');
  assert.equal(clientEvents.at(-1)?.type, 'step_finish', 'Client did not finish its final step');
  console.log(JSON.stringify({
    status: 'pass', client: 'OpenCode', version: expectedVersion, nativeRequests: requests.length,
    thinkingPreserved: true, signaturePreserved: true, redactedThinkingPreserved: true, toolHistoryPreserved: true,
    assistantBlockOrderExact: true, clientAddedToolCacheControl: 'ephemeral', finalClientEventsComplete: true,
    localReadExecuted: true, fragmentedUnicodeSSEConsumed: true, blockedNonProviderRequests: blockedRequests,
    blockedRequestKinds, onlyReadToolExposed: true,
    stdoutBytes, stderrBytes, isolatedArtifacts: root,
    limitation: 'Direct fake Anthropic endpoint only; not a LiteLLM or production upstream compatibility claim.',
  }, null, 2));
} catch (error) {
  // Never dump request, headers, actual auth state, or arbitrary CLI output.
  await writeFile(path.join(root, 'synthetic-client-stderr.txt'), stderrSample, 'utf8');
  console.error(JSON.stringify({ status: 'fail', client: 'OpenCode', version: expectedVersion,
    reason: error.message, nativeRequests: requests.length, blockedNonProviderRequests: blockedRequests,
    blockedRequestKinds,
    stdoutBytes, stderrBytes, isolatedArtifacts: root }, null, 2));
  process.exitCode = 1;
} finally {
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
}
