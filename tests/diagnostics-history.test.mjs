import assert from 'node:assert/strict';
import { after, test } from 'node:test';

process.env.DATABASE_PATH = ':memory:';
const { db } = await import('../dist/db/connection.js');
const { insertPendingRequest, completeRequest, getRequestDetail, queryHistory, getStats } =
  await import('../dist/services/historyService.js');
const { UpstreamDiagnosticsObserver } = await import('../dist/services/upstreamDiagnostics.js');
after(() => db.close());

function pending(id) {
  return insertPendingRequest({ apiKeyId: null, completionId: id,
    requestedModel: 'synthetic-model', resolvedModel: 'synthetic-model', isStream: false });
}

test('history preserves derived upstream refusal separately from provider code and null accounting', () => {
  const observer = new UpstreamDiagnosticsObserver('oauth');
  observer.receive(400, { 'content-type': 'application/json' });
  observer.write(Buffer.from(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error',
    message: 'Synthetic third-party requests draw from extra usage, not your Claude plan. PRIVATE_MESSAGE_SENTINEL' } })));
  observer.end();
  const id = pending('synthetic-plan-refusal');
  completeRequest(id, 'error', { diagnostics: observer.snapshot(), errorMessage: 'upstream_error' });
  const row = getRequestDetail(id);
  assert.equal(row.upstream_diagnostic, 'third_party_plan_usage_restriction');
  assert.equal(row.upstream_http_status, 400);
  assert.equal(row.upstream_error_type, 'invalid_request_error');
  assert.equal(row.upstream_error_code, null);
  assert.equal(row.usage_complete, 0);
  for (const field of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'total_cost_usd']) {
    assert.equal(row[field], null);
  }
  assert.ok(!JSON.stringify(row).includes('PRIVATE_MESSAGE_SENTINEL'));
  assert.equal(queryHistory({}).rows.find(item => item.id === id).upstream_diagnostic, row.upstream_diagnostic);
});

test('history retains explicit cache zeros and cumulative provider counters without inventing USD cost', () => {
  const id = pending('synthetic-usage');
  completeRequest(id, 'success', { inputTokens: 11, outputTokens: 7, cacheCreationInputTokens: 100,
    cacheReadInputTokens: 55, cacheCreation5mTokens: 100, cacheCreation1hTokens: 0, usageComplete: true });
  const row = getRequestDetail(id);
  assert.equal(row.input_tokens, 11);
  assert.equal(row.output_tokens, 7);
  assert.equal(row.cache_creation_input_tokens, 100);
  assert.equal(row.cache_read_input_tokens, 55);
  assert.equal(row.cache_creation_5m_tokens, 100);
  assert.equal(row.cache_creation_1h_tokens, 0);
  assert.equal(row.usage_complete, 1);
  assert.equal(row.total_cost_usd, null);
  assert.equal(getStats().total_cost_usd, null);
});
