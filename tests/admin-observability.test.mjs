import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// Test the actual dependency-free display helpers without a Next.js server,
// credentials, browser network or fixtures copied from implementation logic.
async function loadHelper(relativePath) {
  const source = await readFile(new URL(relativePath, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
  } });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
}
const usage = await loadHelper('../admin/lib/usage.ts');
const diagnostics = await loadHelper('../admin/lib/diagnostics.ts');

test('admin total input includes fresh, cache write and cache read exactly once', () => {
  assert.equal(usage.formatTotalInputTokens(11, 100, 55), (166).toLocaleString());
  assert.equal(usage.formatTotalInputTokens(0, 0, 0), '0');
  assert.match(usage.USAGE_ACCOUNTING_NOTICE, /5m\/1h writes are subsets/);
});

test('admin never presents missing counts/cost as zero or partial input as total', () => {
  for (const missing of [null, undefined]) {
    assert.equal(usage.formatTokenCount(missing), 'Unknown');
    assert.equal(usage.formatCost(missing), 'Unknown');
    assert.equal(usage.formatTotalInputTokens(missing, 1, 2), 'Unknown');
    assert.equal(usage.formatTotalInputTokens(1, missing, 2), 'Unknown');
    assert.equal(usage.formatTotalInputTokens(1, 2, missing), 'Unknown');
  }
  for (const invalid of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(usage.formatTotalInputTokens(invalid, 1, 2), 'Unknown');
  }
  assert.equal(usage.formatTotalInputTokens(Number.MAX_SAFE_INTEGER, 1, 0), 'Unknown');
  assert.equal(usage.formatCost(0), '$0.0000');
  assert.match(usage.USAGE_ACCOUNTING_NOTICE, /Unknown is not zero or free/);
  assert.match(usage.USAGE_ACCOUNTING_NOTICE, /not a billing statement/);
  assert.match(usage.USAGE_ACCOUNTING_NOTICE, /not that every cache counter or charge is known/);
});

test('admin labels derived restriction separately from raw upstream codes and unknown 429', () => {
  const reason = 'third_party_plan_usage_restriction';
  assert.match(diagnostics.upstreamDiagnosticLabel(reason), /message-classified/);
  const note = diagnostics.upstreamDiagnosticExplanation(reason, 400);
  assert.match(note, /not a provider error code/);
  assert.match(note, /does not prove exhausted subscription allowance/);
  assert.match(note, /No retry or credential switch/);
  assert.match(diagnostics.upstreamDiagnosticLabel('unknown_429'), /cause unconfirmed/);
  assert.match(diagnostics.upstreamDiagnosticExplanation('provider_error', 429), /does not establish quota exhaustion/);
  assert.equal(diagnostics.upstreamDiagnosticLabel(null), 'Unknown / not recorded');
});

test('upstream authentication status is never relabeled as a gateway expired key or route rejection', () => {
  for (const status of [401, 403]) {
    assert.match(diagnostics.upstreamDiagnosticExplanation('provider_error', status), /configured upstream, not from LiteLLM/);
  }
  assert.match(diagnostics.GATEWAY_DIAGNOSTIC_NOTICE, /gateway response\/logs/);
  assert.match(diagnostics.GATEWAY_DIAGNOSTIC_NOTICE, /HTTP status alone does not identify which hop/);
  assert.match(diagnostics.GATEWAY_DIAGNOSTIC_NOTICE, /validation may also fail before a history row/);
  assert.equal(diagnostics.upstreamDiagnosticExplanation('http_error', 400), null);
  assert.equal(diagnostics.upstreamDiagnosticExplanation(null, null), null);
});
