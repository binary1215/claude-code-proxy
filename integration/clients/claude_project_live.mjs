import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

// Opt-in live client, not a relay/provider emulator. Run inside the documented
// pinned container. A gateway client key arrives on stdin and is never saved.
const MODEL = 'claude-opus-5-5-han';
const CANONICAL = 'claude-opus-5-5';
const BASE = 'http://192.168.0.7:4000';
const IMAGE = 'sha256:34b5f1b91a24f1d2148b4d52ec37550eccf100e7567fd968931502e14a88b870';
const SDK_VERSION = '0.3.322', CLI_VERSION = '2.1.322';
const MAX_REQUESTS = 16, WATCHDOG_MS = 600_000;
const TEST_COMMAND = 'node --test --test-reporter=tap tests/order.test.mjs';
const SOURCE_FILES = ['src/amounts.mjs', 'src/order.mjs'];
const TEST_FILE = 'tests/order.test.mjs';
const INITIAL_AMOUNTS = `export function toCents(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('price');
  if (value < 0) throw new RangeError('price');
  return Math.floor(value * 100);
}
export function calculateDiscount(subtotalCents, percent = 0) {
  return Math.round(subtotalCents * percent);
}
`;
const INITIAL_ORDER = `import { toCents, calculateDiscount } from './amounts.mjs';
export function summarizeOrder(items, { discountPercent = 0 } = {}) {
  const subtotalCents = items.reduce((sum, item) => sum + toCents(item.unitPrice), 0);
  const discountCents = calculateDiscount(subtotalCents, discountPercent);
  return { subtotalCents, discountCents, totalCents: subtotalCents + discountCents };
}
`;
const BASE_TESTS = `import test from 'node:test';
import assert from 'node:assert/strict';
import { toCents, calculateDiscount } from '../src/amounts.mjs';
import { summarizeOrder } from '../src/order.mjs';
test('currency rounds half up to cents, including a binary floating-point boundary', () => {
  assert.equal(toCents(12.345), 1235); assert.equal(toCents(1.005), 101);
  assert.equal(toCents(0), 0); assert.throws(() => toCents(-1), RangeError);
  assert.throws(() => toCents(NaN), TypeError); assert.throws(() => toCents('2'), TypeError);
});
test('percentage discounts round to the nearest cent and validate their range', () => {
  assert.equal(calculateDiscount(1000, 7.5), 75); assert.equal(calculateDiscount(999, 10), 100);
  assert.equal(calculateDiscount(1000), 0); assert.throws(() => calculateDiscount(1000, 101), RangeError);
  assert.throws(() => calculateDiscount(1000, -1), RangeError);
});
test('an order totals quantities and subtracts its discount', () => {
  assert.deepEqual(summarizeOrder([{ unitPrice: 3.25, quantity: 2 }, { unitPrice: 2.5, quantity: 1 }],
    { discountPercent: 10 }), { subtotalCents: 900, discountCents: 90, totalCents: 810 });
  assert.deepEqual(summarizeOrder([]), { subtotalCents: 0, discountCents: 0, totalCents: 0 });
});
test('quantities must be positive integers', () => {
  for (const quantity of [0, -1, 1.5]) assert.throws(() => summarizeOrder([{ unitPrice: 2, quantity }]), RangeError);
});
`;
const FOLLOWUP_TESTS = `
test('a fixed discount is applied before the percentage discount', () => {
  assert.equal(calculateDiscount(1000, 10, 250), 325);
  assert.equal(calculateDiscount(1000, 10, 2000), 1000);
  assert.throws(() => calculateDiscount(1000, 10, -1), RangeError);
  assert.deepEqual(summarizeOrder([{ unitPrice: 5, quantity: 2 }], { discountPercent: 10, fixedDiscount: 2.5 }),
    { subtotalCents: 1000, discountCents: 325, totalCents: 675 });
  assert.deepEqual(summarizeOrder([{ unitPrice: 5, quantity: 2 }], { fixedDiscount: 20 }),
    { subtotalCents: 1000, discountCents: 1000, totalCents: 0 });
});
`;
const REFERENCE_AMOUNTS = `export function toCents(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('price');
  if (value < 0) throw new RangeError('price');
  return Math.round((value + Number.EPSILON) * 100);
}
export function calculateDiscount(subtotalCents, percent = 0, fixedDiscountCents = 0) {
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw new RangeError('percent');
  if (!Number.isInteger(fixedDiscountCents) || fixedDiscountCents < 0) throw new RangeError('fixed');
  const fixed = Math.min(subtotalCents, fixedDiscountCents);
  return fixed + Math.round((subtotalCents - fixed) * percent / 100);
}
`;
const REFERENCE_ORDER = `import { toCents, calculateDiscount } from './amounts.mjs';
export function summarizeOrder(items, { discountPercent = 0, fixedDiscount = 0 } = {}) {
  const subtotalCents = items.reduce((sum, item) => {
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) throw new RangeError('quantity');
    return sum + toCents(item.unitPrice) * item.quantity;
  }, 0);
  const discountCents = calculateDiscount(subtotalCents, discountPercent, toCents(fixedDiscount));
  return { subtotalCents, discountCents, totalCents: subtotalCents - discountCents };
}
`;
const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const blockHash = value => hash(canonical(value));
class ProbeError extends Error { constructor(code) { super(code); this.code = code; } }
class InputQueue {
  values = []; waiters = []; closed = false;
  push(value) { const next = this.waiters.shift(); if (this.closed) throw new ProbeError('input_closed'); next ? next({ value, done: false }) : this.values.push(value); }
  next() { return this.values.length ? Promise.resolve({ value: this.values.shift(), done: false }) : this.closed ? Promise.resolve({ done: true }) : new Promise(next => this.waiters.push(next)); }
  close() { this.closed = true; this.values.length = 0; for (const next of this.waiters.splice(0)) next({ done: true }); }
  [Symbol.asyncIterator]() { return this; }
}
function createProject() {
  const root = mkdtempSync(join(tmpdir(), 'claude-project-live-'));
  const cwd = join(root, 'workspace');
  mkdirSync(join(cwd, 'src'), { recursive: true }); mkdirSync(join(cwd, 'tests')); mkdirSync(join(root, 'config'));
  writeFileSync(join(cwd, SOURCE_FILES[0]), INITIAL_AMOUNTS); writeFileSync(join(cwd, SOURCE_FILES[1]), INITIAL_ORDER);
  writeFileSync(join(cwd, TEST_FILE), BASE_TESTS);
  return { root, cwd };
}
function cleanup(root) {
  const target = resolve(root);
  if (!target.startsWith(resolve(tmpdir()) + sep) || !basename(target).startsWith('claude-project-live-')) throw new ProbeError('cleanup_failed');
  rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
function runTests(cwd) {
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', TEST_FILE], {
    cwd, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
    env: { PATH: process.env.PATH ?? '', HOME: dirname(cwd), TMPDIR: dirname(cwd) },
  });
  if (result.error || result.signal) throw new ProbeError('oracle_execution_failed');
  const failCount = /# fail (\d+)/.exec(result.stdout)?.[1];
  return { exit_code: result.status, tests_failed: failCount === undefined ? null : Number(failCount), passed: result.status === 0 && failCount === '0' };
}
const sourceHashes = cwd => Object.fromEntries(SOURCE_FILES.map(file => [file, hash(readFileSync(join(cwd, file)))]));
const BROWSE_COMMANDS = new Set(['pwd', 'ls', 'find', 'cat', 'rg', 'grep', 'sed', 'head', 'tail', 'wc', 'printf', 'echo', 'test', '[', 'cd', 'true', 'false']);
const commandFamily = value => BROWSE_COMMANDS.has(value) || value === 'node' ? value : 'unsupported_command';
function shellParts(command) {
  const parts = []; let words = [], word = '', quote = '', started = false;
  const finishWord = () => { if (started) words.push(word); word = ''; started = false; };
  const finishPart = () => { finishWord(); if (words.length) parts.push(words); words = []; };
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote) {
      if (char === quote) { quote = ''; continue; }
      if (quote === '"' && (char === '`' || char === '$')) throw new ProbeError('bash_shell_expansion');
      if (char === '\\' && quote === '"' && ['"', '\\'].includes(command[i + 1])) word += command[++i];
      else word += char;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; started = true; continue; }
    if (char === '\\' && command[i + 1]) { word += command[++i]; started = true; continue; }
    if (char === '$' && command[i + 1] === '?') { word += '$?'; i++; started = true; continue; }
    if ('`$<>'.includes(char)) throw new ProbeError('bash_shell_expansion_or_redirect');
    if (char === ';' || char === '\n' || char === '|' || char === '&') {
      if (char === '&' && command[i + 1] !== '&') throw new ProbeError('bash_background_command');
      if ((char === '|' || char === '&') && command[i + 1] === char) i++;
      finishPart(); continue;
    }
    if (/\s/.test(char)) { finishWord(); continue; }
    word += char; started = true;
  }
  if (quote) throw new ProbeError('bash_unclosed_quote');
  finishPart(); return parts;
}
function inspectNodeCode(code) {
  if (/\b(?:process|globalThis|global|fetch|WebSocket|XMLHttpRequest|require|eval|Function|constructor|__proto__)\b|https?:\/\//.test(code)) throw new ProbeError('node_inspection_outside_fixture');
  const imports = [...code.matchAll(/\b(?:from\s*|import\s*\(\s*|import\s*)(['"])(.*?)\1/g)].map(match => match[2]);
  if (imports.some(value => ![...SOURCE_FILES.map(file => `./${file}`), './tests/order.test.mjs', 'node:assert', 'node:assert/strict'].includes(value))) throw new ProbeError('node_import_outside_fixture');
  if (/\bimport\s*\((?!\s*['"])/.test(code)) throw new ProbeError('node_dynamic_import_not_literal');
}
function bashEvidence(command, cwd) {
  if (typeof command !== 'string' || !command.trim() || command.length > 16000) throw new ProbeError('bash_invalid_command');
  const normalized = command.replaceAll(cwd, '.').replaceAll('/usr/local/bin/node', 'node').replaceAll('/usr/bin/node', 'node').replace(/2>&1/g, '').replace(/2>\s*\/dev\/null/g, '');
  const heredoc = /^(node(?:\s+--input-type=(?:module|commonjs))?)\s+<<\s*(['"]?)([A-Za-z_]\w*)\2\s*\n([\s\S]*)\n\3\s*$/.exec(normalized);
  const commands = heredoc ? [[...shellParts(heredoc[1])[0], '-e', heredoc[4]]] : shellParts(normalized);
  const families = [];
  const readSnapshots = new Map();
  for (const [name, ...args] of commands) {
    if (!BROWSE_COMMANDS.has(name) && name !== 'node') throw new ProbeError('bash_unsupported_command');
    let family = name;
    if (name === 'node') {
      const evalIndex = args.findIndex(value => value === '-e' || value === '--eval');
      if (evalIndex >= 0) {
        if (evalIndex !== args.length - 2 || args.slice(0, evalIndex).some(value => !/^--input-type=(?:module|commonjs)$/.test(value))) throw new ProbeError('node_inspection_flags');
        inspectNodeCode(args[evalIndex + 1]); family = 'node_inspect';
      } else if (args.length === 1 && ['-v', '--version'].includes(args[0])) family = 'node_version';
      else if (args[0] === '--test') family = 'node_test';
      else if (['--check', '-c'].includes(args[0]) && args.length === 2) family = 'node_check';
      else throw new ProbeError('node_unsupported_mode');
      if (family !== 'node_inspect' && args.some(value => /^(?:-e|-p|-r|--eval|--print|--require|--import)(?:=|$)/.test(value))) throw new ProbeError('node_unsupported_mode');
    }
    if (family !== 'node_inspect' && args.some(value => /(?:^|[=\s])\/|(?:^|\/)\.\.(?:\/|$)|~|\$[A-Za-z_{]/.test(value))) throw new ProbeError('bash_path_outside_fixture');
    if (name === 'sed' && args.some(value => /^-[A-Za-z]*i/.test(value)) || name === 'find' && args.some(value => ['-exec', '-execdir', '-delete', '-ok', '-okdir'].includes(value))) throw new ProbeError('bash_mutation_not_edit');
    families.push(family);
    if (name !== 'cat') continue;
    for (const arg of args) {
      const file = arg.replace(/^\.\//, '');
      if (SOURCE_FILES.includes(file)) readSnapshots.set(file, readFileSync(join(cwd, file), 'utf8'));
    }
  }
  return { command_families: [...new Set(families)], readSnapshots, test: families.includes('node_test') };
}
function toolOutcome(input) {
  const response = input.tool_response;
  const stdout = typeof response === 'string' ? response : typeof response?.stdout === 'string' ? response.stdout : '';
  const stderr = typeof response?.stderr === 'string' ? response.stderr : '';
  const error = typeof input.error === 'string' ? input.error : '';
  const text = [stdout, stderr, error].join('\n');
  const completed = input.hook_event_name !== 'PostToolUseFailure' && !input.error && response?.interrupted !== true;
  let error_category = null;
  if (!completed) {
    error_category = /read.only file system|EROFS/i.test(text) ? 'read_only_filesystem'
      : /permission denied|operation not permitted|EACCES|EPERM/i.test(text) ? 'permission_denied'
      : /command not found|no such file or directory|ENOENT/i.test(text) ? 'missing_executable_or_path'
      : /# fail [1-9]\d*/.test(text) ? 'test_failure' : 'tool_error';
  }
  return { completed, error_category, stdout, text };
}
function fixtureSelfTest() {
  const { root, cwd } = createProject();
  try {
    assert.ok(runTests(cwd).tests_failed > 0);
    // Stage-one reference deliberately lacks the future fixed-discount feature.
    writeFileSync(join(cwd, SOURCE_FILES[0]), REFERENCE_AMOUNTS.replace(', fixedDiscountCents = 0', '').replace(/  if \(!Number.isInteger\(fixedDiscountCents\)[\s\S]*?  return fixed \+ Math.round\(\(subtotalCents - fixed\) \* percent \/ 100\);/, '  return Math.round(subtotalCents * percent / 100);'));
    writeFileSync(join(cwd, SOURCE_FILES[1]), REFERENCE_ORDER.replace(', fixedDiscount = 0', '').replace(', toCents(fixedDiscount)', ''));
    assert.ok(runTests(cwd).passed);
    writeFileSync(join(cwd, TEST_FILE), BASE_TESTS + FOLLOWUP_TESTS); assert.ok(runTests(cwd).tests_failed > 0);
    writeFileSync(join(cwd, SOURCE_FILES[0]), REFERENCE_AMOUNTS); writeFileSync(join(cwd, SOURCE_FILES[1]), REFERENCE_ORDER);
    assert.ok(runTests(cwd).passed);
    const evidence = bashEvidence(`cat src/amounts.mjs './src/order.mjs' && ${TEST_COMMAND}`, cwd);
    assert.deepEqual(evidence.command_families, ['cat', 'node_test']);
    assert.equal(evidence.readSnapshots.size, 2);
    assert.equal(bashEvidence('echo src/amounts.mjs', cwd).readSnapshots.size, 0);
    const success = toolOutcome({ hook_event_name: 'PostToolUse', tool_response: { stdout: REFERENCE_AMOUNTS } });
    assert.ok(success.completed && success.stdout.includes(evidence.readSnapshots.get(SOURCE_FILES[0])));
    const failure = toolOutcome({ hook_event_name: 'PostToolUseFailure', error: 'spawn /bin/missing ENOENT' });
    assert.equal(failure.completed, false); assert.equal(failure.error_category, 'missing_executable_or_path');
    assert.equal(toolOutcome({ hook_event_name: 'PostToolUseFailure', error: 'exit 1\n# fail 3' }).error_category, 'test_failure');
    const inspection = "import { toCents } from './src/amounts.mjs'; console.log(toCents(1.005));";
    const allowedCommands = [
      ['pwd && ls -la', ['pwd', 'ls']], ['node --version', ['node_version']], ['node -v', ['node_version']],
      ['node --check src/order.mjs', ['node_check']], [`${TEST_COMMAND} 2>&1 || true`, ['node_test', 'true']],
      ["sed -n '1,180p' src/amounts.mjs", ['sed']],
      [`node --input-type=module -e "${inspection}"`, ['node_inspect']],
      [`node --input-type=module <<'NODE'\n${inspection}\nNODE`, ['node_inspect']],
      ['node -e "import(\'./src/amounts.mjs\').then(m => console.log(m.toCents(1.005)))"', ['node_inspect']],
    ];
    for (const [command, families] of allowedCommands) assert.deepEqual(bashEvidence(command, cwd).command_families, families);
    const deniedCommands = [
      'curl https://example.invalid', 'cat /etc/passwd', 'cat ../outside', 'cat "src/../../outside"',
      'node -e "console.log(process.env)"', 'node -e "import(\'node:fs\')"', 'node -e "import(moduleName)"',
      'node --test --require=./src/order.mjs', 'echo "$HOME"', 'sed -i s/a/b/ src/order.mjs',
    ];
    for (const command of deniedCommands) assert.throws(() => bashEvidence(command, cwd), ProbeError);
    const inspectionRun = spawnSync(process.execPath, ['--input-type=module', '-e', inspection], { cwd, encoding: 'utf8', timeout: 5000 });
    assert.equal(inspectionRun.status, 0); assert.equal(inspectionRun.stdout.trim(), '101');
    return { ok: true, mode: 'fixture_self_test', baseline_fails: true, initial_reference_passes: true, followup_fails_then_passes: true,
      tool_evidence_checks: true, supported_command_cases: allowedCommands.length, denied_command_cases: deniedCommands.length,
      actual_node_inspection_passed: true, model_requests: 0 };
  } finally { cleanup(root); }
}

async function live() {
  const report = { ok: false, functional_pass: false, client: `official-agent-sdk-${SDK_VERSION}-cli-${CLI_VERSION}`,
    model_alias: MODEL, expected_model: CANONICAL, image_expected: IMAGE,
    route: 'official-cli -> passive-observer -> LiteLLM .7 /v1/messages -> configured Han',
    observation_scope: 'client-to-gateway; gateway/provider internals are not observed',
    limits: { maximum_model_requests: MAX_REQUESTS, watchdog_seconds: WATCHDOG_MS / 1000, client_retries: 0, fallback: false },
    phases: [], checks: {}, rejected_tools: [], observer: { requests: 0, statuses: [], models: [], cache_read_input_tokens: [],
      returned_signed_thinking: 0, replayed_signed_thinking: 0, unrecognized_replayed_thinking: 0, signature_content_mismatches: 0, hashes: [] },
  };
  const queue = new InputQueue(), abortController = new AbortController(), outgoing = new Set();
  const returned = new Map(), signatures = new Map(), operations = new Map(), denied = new Set();
  let project, currentQuery, consumption, observer, watchdog, current, lastAction, terminalError, finished = false;
  const stop = code => {
    terminalError ??= new ProbeError(code); abortController.abort(); try { currentQuery?.close(); } catch {}
    current?.reject(terminalError); for (const value of outgoing) value.destroy();
  };
  const check = (condition, code) => { if (!condition) throw new ProbeError(code); };
  const observeBlock = (block, requestNumber) => {
    if (!['thinking', 'redacted_thinking'].includes(block?.type)) return;
    const digest = blockHash(block); returned.set(digest, requestNumber);
    if (block.type === 'thinking' && block.signature) { report.observer.returned_signed_thinking++; signatures.set(hash(block.signature), digest); }
    report.observer.hashes.push({ request: requestNumber, direction: 'response', type: block.type, sha256: digest });
  };
  const sse = requestNumber => {
    let pending = ''; const decoder = new TextDecoder(), blocks = new Map();
    const frame = raw => {
      const data = raw.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!data || data === '[DONE]') return;
      let event; try { event = JSON.parse(data); } catch { stop('invalid_gateway_stream'); return; }
      if (event.type === 'message_start') {
        const model = event.message?.model; if (![MODEL, CANONICAL].includes(model)) stop('unexpected_model');
        if (!report.observer.models.includes(model)) report.observer.models.push(model);
      } else if (event.type === 'content_block_start') blocks.set(event.index, structuredClone(event.content_block));
      else if (event.type === 'content_block_delta') {
        const block = blocks.get(event.index), delta = event.delta;
        if (block?.type === 'thinking' && delta?.type === 'thinking_delta') block.thinking = (block.thinking ?? '') + delta.thinking;
        if (block?.type === 'thinking' && delta?.type === 'signature_delta') block.signature = delta.signature;
      } else if (event.type === 'content_block_stop') { observeBlock(blocks.get(event.index), requestNumber); blocks.delete(event.index); }
      else if (event.type === 'message_delta' && Number.isSafeInteger(event.usage?.cache_read_input_tokens)) report.observer.cache_read_input_tokens.push(event.usage.cache_read_input_tokens);
      else if (event.type === 'error') stop('gateway_stream_error');
    };
    return { write(chunk) { pending += decoder.decode(chunk, { stream: true }); const frames = pending.split(/\r?\n\r?\n/); pending = frames.pop(); frames.forEach(frame); },
      end() { pending += decoder.decode(); if (pending.trim()) frame(pending); } };
  };
  const validateTool = (name, input) => {
    if (!current || !['Read', 'Edit', 'Bash'].includes(name) || !input || typeof input !== 'object') throw new ProbeError('unexpected_tool');
    if (name === 'Read' || name === 'Edit') {
      const path = resolve(project.cwd, input.file_path ?? '');
      const allowed = SOURCE_FILES.map(file => join(project.cwd, file));
      if (name === 'Edit' ? !allowed.includes(path) : path !== project.cwd && !path.startsWith(project.cwd + sep)) throw new ProbeError('tool_outside_fixture');
      return { name, file: path.slice(project.cwd.length + 1).split(sep).join('/') };
    }
    return { name, ...bashEvidence(input.command, project.cwd) };
  };
  const denyTool = (name, input, error) => {
    const reason = error instanceof ProbeError ? error.code : 'tool_scope_failed';
    const identity = `${current?.name}:${name}:${hash(input ?? null)}:${reason}`;
    if (!denied.has(identity)) {
      denied.add(identity);
      const first = typeof input?.command === 'string' ? input.command.trim().split(/\s/, 1)[0].replace(/^\/usr\/(?:local\/)?bin\//, '') : '';
      report.rejected_tools.push({ phase: current?.name ?? 'startup', tool: ['Read', 'Edit', 'Bash'].includes(name) ? name : 'unsupported_tool',
        reason, ...(name === 'Bash' ? { command_family: commandFamily(first) } : {}) });
    }
    return `This isolated fixture does not allow that form (${reason}). Use Read for project files, Edit for the two source modules, and Bash for pwd/ls/cat, node --version, fixture-local Node inspection, or ${TEST_COMMAND}. Keep tests unchanged. Continue with a supported tool call.`;
  };
  const preTool = async input => {
    try {
      const value = validateTool(input.tool_name, input.tool_input);
      operations.set(input.tool_use_id, { ...value, phase: current.name });
      current.tool_calls[value.name]++;
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } };
    } catch (error) { return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
      permissionDecisionReason: denyTool(input.tool_name, input.tool_input, error) } }; }
  };
  const postTool = async input => {
    const operation = operations.get(input.tool_use_id); if (!operation || operation.phase !== current?.name) return {};
    operations.delete(input.tool_use_id);
    const outcome = toolOutcome(input);
    const reads = [];
    if (outcome.completed && operation.file) current[operation.name === 'Read' ? 'read_files' : 'edited_files'].add(operation.file);
    if (outcome.completed && operation.readSnapshots) for (const [file, source] of operation.readSnapshots) {
      if (source && outcome.stdout.includes(source)) { current.read_files.add(file); reads.push(file); }
    }
    current.tool_results.push({ tool: operation.name, completed: outcome.completed, error_category: outcome.error_category,
      ...(operation.command_families ? { command_families: operation.command_families, source_reads_verified: reads } : {}) });
    if (operation.test) {
      // Hook payload is consumed in memory; raw stdout/stderr never enters a receipt.
      const failCount = /# fail (\d+)/.exec(outcome.text)?.[1];
      if (failCount !== undefined) {
        if (Number(failCount) > 0) { current.failed_test_runs++; if (current.tool_calls.Edit === 0) current.failed_before_first_edit = true; }
        else if (outcome.completed) current.passing_test_runs++;
      }
    }
    return {};
  };
  const action = async (name, prompt) => {
    check(!terminalError, terminalError?.code ?? 'client_stopped');
    const state = { name, tool_calls: { Read: 0, Edit: 0, Bash: 0 }, tool_results: [], read_files: new Set(), edited_files: new Set(), failed_test_runs: 0, passing_test_runs: 0, failed_before_first_edit: false };
    const done = new Promise((resolveAction, reject) => { state.resolve = resolveAction; state.reject = reject; }); current = state; lastAction = state;
    queue.push({ type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null, client_composed: true });
    await done; current = undefined; if (terminalError) throw terminalError;
    return state;
  };
  try {
    const key = readFileSync(0, 'utf8').trim(); check(Boolean(key) && !/[^\x21-\x7e]/.test(key), 'invalid_stdin_key');
    const sdkEntry = new URL(import.meta.resolve('@anthropic-ai/claude-agent-sdk'));
    check(JSON.parse(readFileSync(new URL('./package.json', sdkEntry), 'utf8')).version === SDK_VERSION, 'unexpected_sdk_version');
    const cliVersion = spawnSync('/usr/local/bin/claude', ['--version'], { encoding: 'utf8', timeout: 15000 });
    check(cliVersion.status === 0 && cliVersion.stdout.includes(CLI_VERSION), 'unexpected_cli_version');
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    project = createProject(); const initialHashes = sourceHashes(project.cwd);
    const baseline = runTests(project.cwd); check(baseline.tests_failed > 0, 'initial_baseline_not_failing');
    watchdog = setTimeout(() => stop('watchdog_timeout'), WATCHDOG_MS);
    observer = http.createServer((request, response) => { void (async () => {
      const chunks = []; let length = 0;
      for await (const chunk of request) { length += chunk.length; if (length > 10 * 1024 * 1024) throw new ProbeError('request_too_large'); chunks.push(chunk); }
      const bytes = Buffer.concat(chunks), url = new URL(request.url, BASE);
      check(url.origin === new URL(BASE).origin, 'unexpected_gateway_origin');
      const isMessages = request.method === 'POST' && url.pathname === '/v1/messages';
      let number;
      if (isMessages) {
        number = ++report.observer.requests; check(number <= MAX_REQUESTS, 'request_budget_exceeded');
        const body = JSON.parse(bytes.toString()); check(body.model === MODEL, 'unexpected_model');
        for (const message of body.messages ?? []) for (const block of Array.isArray(message.content) ? message.content : []) {
          if (message.role !== 'assistant' || !['thinking', 'redacted_thinking'].includes(block.type)) continue;
          const digest = blockHash(block), previous = returned.get(digest);
          if (!previous || previous >= number) report.observer.unrecognized_replayed_thinking++;
          if (block.type === 'thinking' && block.signature) {
            const original = signatures.get(hash(block.signature)); if (original && original !== digest) report.observer.signature_content_mismatches++;
            if (previous && previous < number) report.observer.replayed_signed_thinking++;
          }
          report.observer.hashes.push({ request: number, direction: 'later-request', type: block.type, sha256: digest, recognized: Boolean(previous && previous < number) });
        }
      }
      const headers = { ...request.headers, host: url.host }; delete headers.connection; delete headers['transfer-encoding'];
      const forward = http.request(url, { method: request.method, headers }, upstream => {
        const headers = { ...upstream.headers }; delete headers.connection; delete headers['transfer-encoding']; response.writeHead(upstream.statusCode ?? 502, headers);
        if (isMessages) report.observer.statuses.push({ request: number, phase: current?.name ?? 'startup', status: upstream.statusCode ?? 0 });
        if (isMessages && upstream.statusCode !== 200) stop('gateway_http_error');
        const observe = isMessages && upstream.headers['content-type']?.includes('text/event-stream') ? sse(number) : undefined;
        upstream.on('data', chunk => { observe?.write(chunk); if (!response.write(chunk)) upstream.pause(), response.once('drain', () => upstream.resume()); });
        upstream.on('end', () => { observe?.end(); response.end(); }); upstream.on('error', () => { response.destroy(); stop('observer_failed'); });
      });
      outgoing.add(forward); forward.once('close', () => outgoing.delete(forward));
      forward.on('error', () => { response.destroy(); if (!finished && !terminalError) stop('observer_failed'); });
      response.on('close', () => { if (!response.writableFinished) forward.destroy(); }); forward.end(bytes);
    })().catch(error => { response.destroy(); stop(error instanceof ProbeError ? error.code : 'observer_failed'); }); });
    observer.listen(0, '127.0.0.1'); await once(observer, 'listening');
    const env = { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: project.root, USERPROFILE: project.root, TMPDIR: project.root,
      CLAUDE_CONFIG_DIR: join(project.root, 'config'), ANTHROPIC_BASE_URL: `http://127.0.0.1:${observer.address().port}`, ANTHROPIC_AUTH_TOKEN: key,
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '4096', CLAUDE_CODE_MAX_RETRIES: '0', CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES: '0',
      CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1', CLAUDE_CODE_NO_MODEL_FALLBACK: '1', CLAUDE_CODE_DISABLE_MODEL_ACCESS_FALLBACK: '1',
      CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK: '1', CLAUDE_CODE_DISABLE_REFUSAL_RETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1', ENABLE_TOOL_SEARCH: 'false' };
    currentQuery = query({ prompt: queue, options: { model: MODEL, pathToClaudeCodeExecutable: '/usr/local/bin/claude', cwd: project.cwd, env, abortController,
      tools: ['Read', 'Edit', 'Bash'], skills: [], plugins: [], mcpServers: {}, strictMcpConfig: true, settingSources: [], persistSession: false,
      systemPrompt: { type: 'preset', preset: 'claude_code' }, permissionMode: 'default', includePartialMessages: true, verbatimPrompts: false,
      effort: 'medium', thinking: { type: 'adaptive' }, settings: { disableClaudeAiConnectors: true, disableBundledSkills: true, autoMemoryEnabled: false,
        autoCompactEnabled: true, idleCompaction: false, precomputeCompactionEnabled: false, fallbackModel: [] }, stderr: () => {},
      canUseTool: async (name, input) => { try { validateTool(name, input); return { behavior: 'allow', updatedInput: input }; }
        catch (error) { return { behavior: 'deny', message: denyTool(name, input, error) }; } },
      hooks: { PreToolUse: [{ hooks: [preTool], onFailure: 'block' }], PostToolUse: [{ hooks: [postTool] }], PostToolUseFailure: [{ hooks: [postTool] }] },
    } });
    consumption = (async () => { try {
      for await (const message of currentQuery) {
        if (message.type === 'system' && ['api_retry', 'model_refusal_fallback'].includes(message.subtype)) { stop('retry_or_fallback_attempted'); break; }
        if (message.type === 'result') {
          if (!current || message.subtype !== 'success' || message.is_error) { stop('sdk_action_failed'); break; }
          current.resolve();
        }
      }
      if (!finished && !terminalError) stop('sdk_stream_ended');
    } catch { if (!finished) stop('sdk_stream_failed'); } })();
    await currentQuery.initializationResult();
    const runtimeHelp = `The fixture already has Node and needs no dependencies. Prefer ${TEST_COMMAND} for tests. Read/Edit and Bash pwd/ls/cat, node --version, node --check, and fixture-local Node inspection are available. If a command form is denied, continue with a supported form; no permission escalation is needed for this fixture.`;
    const initialPrompt = `Work only in this temporary project. Read src/amounts.mjs, src/order.mjs, and tests/order.test.mjs. First run ${TEST_COMMAND} to observe the existing failures before editing. Fix both source modules: round currency half up, calculate and validate percentage discounts, total positive integer quantities, and subtract discounts. Use the genuine Edit tool for source changes; do not change tests. Run the tests again until they pass. Do not install dependencies or access anything outside this project. ${runtimeHelp} Then reply PROJECT_INITIAL_OK.`;
    const first = await action('initial_project_repair', initialPrompt);
    check(hash(readFileSync(join(project.cwd, TEST_FILE))) === hash(BASE_TESTS), 'acceptance_tests_changed');
    const firstHashes = sourceHashes(project.cwd), firstOracle = runTests(project.cwd);
    check(firstOracle.passed && SOURCE_FILES.every(file => firstHashes[file] !== initialHashes[file]), 'initial_project_not_repaired');
    check(SOURCE_FILES.every(file => first.read_files.has(file) && first.edited_files.has(file)) && first.failed_before_first_edit && first.passing_test_runs > 0, 'initial_tool_evidence_missing');
    report.phases.push({ phase: first.name, baseline, final_oracle: firstOracle, tool_calls: first.tool_calls,
      tool_results: first.tool_results,
      source_files_read: [...first.read_files], source_files_edited: [...first.edited_files], failed_test_runs: first.failed_test_runs,
      failed_before_first_edit: first.failed_before_first_edit, passing_test_runs: first.passing_test_runs });
    writeFileSync(join(project.cwd, TEST_FILE), BASE_TESTS + FOLLOWUP_TESTS);
    const followupBaseline = runTests(project.cwd); check(followupBaseline.tests_failed > 0, 'followup_baseline_not_failing');
    const second = await action('followup_project_feature', `Same project and session. A new acceptance test now specifies fixed discounts. Read the updated tests. First run ${TEST_COMMAND} to observe the new failure. Extend calculateDiscount(subtotalCents, percent, fixedDiscountCents=0) so it caps the fixed discount to the subtotal, applies the percentage to the remainder, and rejects negative/noninteger fixed cents. Extend summarizeOrder options with fixedDiscount=0 in currency units, convert it using toCents, and pass it to calculateDiscount. Use Edit to update both source modules, preserve earlier behavior, leave tests unchanged, and run the tests until they pass. Work only in this project. ${runtimeHelp} Reply PROJECT_FOLLOWUP_OK.`);
    check(hash(readFileSync(join(project.cwd, TEST_FILE))) === hash(BASE_TESTS + FOLLOWUP_TESTS), 'acceptance_tests_changed');
    const finalHashes = sourceHashes(project.cwd), finalOracle = runTests(project.cwd);
    check(finalOracle.passed && SOURCE_FILES.every(file => finalHashes[file] !== firstHashes[file]), 'followup_project_not_repaired');
    check(SOURCE_FILES.every(file => second.edited_files.has(file)) && second.failed_before_first_edit && second.passing_test_runs > 0, 'followup_tool_evidence_missing');
    report.phases.push({ phase: second.name, baseline: followupBaseline, final_oracle: finalOracle, tool_calls: second.tool_calls,
      tool_results: second.tool_results,
      source_files_edited: [...second.edited_files], failed_test_runs: second.failed_test_runs,
      failed_before_first_edit: second.failed_before_first_edit, passing_test_runs: second.passing_test_runs });
    report.source_hashes = { initial: initialHashes, after_repair: firstHashes, after_followup: finalHashes };
    report.checks = { actual_source_read_edit_and_test: true, initial_failing_tests_observed: true, two_source_files_repaired: true,
      same_session_followup: true, two_source_files_edited_again: true, unchanged_acceptance_tests: true, independent_final_tests_passed: true,
      observed_signed_thinking_preserved: report.observer.replayed_signed_thinking > 0
        ? report.observer.signature_content_mismatches === 0 && report.observer.unrecognized_replayed_thinking === 0 : null,
      signed_thinking_replayed: report.observer.replayed_signed_thinking > 0 ? true : null };
    report.ok = true; report.functional_pass = true;
  } catch (error) {
    report.error = terminalError?.code ?? (error instanceof ProbeError ? error.code : 'project_validation_failed');
    if (lastAction && !report.phases.some(value => value.phase === lastAction.name)) report.incomplete_phase = {
      phase: lastAction.name, tool_calls: lastAction.tool_calls, source_files_read: [...lastAction.read_files],
      tool_results: lastAction.tool_results,
      source_files_edited: [...lastAction.edited_files], failed_test_runs: lastAction.failed_test_runs,
      failed_before_first_edit: lastAction.failed_before_first_edit, passing_test_runs: lastAction.passing_test_runs,
    };
    process.exitCode = 1;
  }
  finally {
    finished = true; clearTimeout(watchdog); try { currentQuery?.close(); } catch {} abortController.abort(); queue.close();
    for (const request of outgoing) request.destroy(); if (consumption) await consumption;
    if (observer) { observer.closeAllConnections(); await new Promise(done => observer.close(done)); }
    if (project) try { cleanup(project.root); } catch { report.ok = false; report.functional_pass = false; report.error ??= 'cleanup_failed'; process.exitCode = 1; }
  }
  return report;
}

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--self-test') {
  try { process.stdout.write(JSON.stringify(fixtureSelfTest()) + '\n'); }
  catch { process.stdout.write('{"ok":false,"mode":"fixture_self_test","error":"fixture_self_test_failed"}\n'); process.exitCode = 1; }
} else if (args.length === 1 && args[0] === '--live') process.stdout.write(JSON.stringify(await live()) + '\n');
else { process.stdout.write('{"ok":false,"error":"explicit_live_or_self_test_flag_required"}\n'); process.exitCode = 2; }
