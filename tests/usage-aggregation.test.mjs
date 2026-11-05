import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';

process.env.DATABASE_PATH = ':memory:';
const { db } = await import('../dist/db/connection.js');
const { insertPendingRequest, completeRequest, getStats } = await import('../dist/services/historyService.js');
after(() => db.close());
beforeEach(() => db.exec('DELETE FROM request_log'));

let sequence = 0;
function request(model, data, status = 'success', createdAt = '2026-10-24 12:00:00') {
  const id = insertPendingRequest({ apiKeyId: null, completionId: `usage-aggregate-${sequence++}`,
    requestedModel: model, resolvedModel: model, isStream: false });
  if (status !== 'pending') completeRequest(id, status, data);
  db.prepare('UPDATE request_log SET created_at = ? WHERE id = ?').run(createdAt, id);
  return id;
}
const complete = { inputTokens: 11, cacheCreationInputTokens: 100, cacheReadInputTokens: 55,
  cacheCreation5mTokens: 80, cacheCreation1hTokens: 20, outputTokens: 7, usageComplete: true };
const zeros = { inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
  outputTokens: 0, usageComplete: true };
const metric = (total, known, reported, unknown) => ({ total_tokens: total, known_tokens: known,
  reported_requests: reported, unknown_requests: unknown });

test('period and per-model totals include each cache counter once and preserve legacy fresh input', () => {
  request('model-a', complete);
  request('model-a', zeros);
  request('model-b', { ...complete, inputTokens: 5 });
  const stats = getStats();
  assert.equal(stats.total_requests, 3);
  assert.equal(stats.total_input_tokens, 16); // Original API is still fresh input only.
  assert.equal(stats.total_output_tokens, 14);
  assert.equal(stats.total_cost_usd, null);
  assert.deepEqual(stats.usage.fresh_input, metric(16, 16, 3, 0));
  assert.deepEqual(stats.usage.cache_write, metric(200, 200, 3, 0));
  assert.deepEqual(stats.usage.cache_read, metric(110, 110, 3, 0));
  assert.deepEqual(stats.usage.output, metric(14, 14, 3, 0));
  assert.deepEqual(stats.usage.total_input, metric(326, 326, 3, 0));
  assert.deepEqual(stats.usage.total_tokens, metric(340, 340, 3, 0));
  assert.equal(stats.usage.complete_requests, 3);
  assert.equal(stats.usage.partial_requests, 0);
  assert.equal(stats.usage.unknown_requests, 0);
  const model = stats.by_model.find(row => row.model === 'model-a');
  assert.equal(model.count, 2);
  assert.equal(model.cost_usd, null);
  assert.deepEqual(model.usage.total_tokens, metric(173, 173, 2, 0));
});

test('partial, pending and failed requests retain known subtotals without inventing complete totals', () => {
  request('model-a', complete);
  request('model-a', { inputTokens: 3, outputTokens: 2, usageComplete: true }); // Missing cache usage.
  request('model-b', { inputTokens: 4, outputTokens: 1, cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0, usageComplete: false }, 'cancelled');
  request('model-b', {}, 'error');
  request('model-b', {}, 'pending');
  const stats = getStats();
  assert.equal(stats.total_requests, 5);
  assert.equal(stats.total_input_tokens, null);
  assert.equal(stats.total_cost_usd, null);
  assert.equal(stats.usage.complete_requests, 1);
  assert.equal(stats.usage.partial_requests, 2);
  assert.equal(stats.usage.unknown_requests, 2);
  assert.equal(stats.usage.terminal_usage_requests, 2);
  assert.deepEqual(stats.usage.fresh_input, metric(null, 18, 3, 2));
  assert.deepEqual(stats.usage.cache_write, metric(null, 100, 2, 3));
  assert.deepEqual(stats.usage.cache_read, metric(null, 55, 2, 3));
  assert.deepEqual(stats.usage.output, metric(null, 10, 3, 2));
  // Do not combine counters from different incomplete rows into a fabricated input total.
  assert.deepEqual(stats.usage.total_input, metric(null, 170, 2, 3));
  assert.deepEqual(stats.usage.total_tokens, metric(null, 178, 2, 3));
  const modelA = stats.by_model.find(row => row.model === 'model-a');
  assert.deepEqual(modelA.usage.fresh_input, metric(14, 14, 2, 0));
  assert.deepEqual(modelA.usage.cache_read, metric(null, 55, 1, 1));
  const modelB = stats.by_model.find(row => row.model === 'model-b');
  assert.equal(modelB.usage.partial_requests, 1);
  assert.equal(modelB.usage.unknown_requests, 2);
});

test('a full snapshot without terminal usage remains a subtotal, even when every counter is zero', () => {
  request('cancelled', { ...zeros, usageComplete: false }, 'cancelled');
  const stats = getStats();
  assert.deepEqual(stats.usage.total_tokens, metric(null, 0, 1, 0));
  assert.equal(stats.usage.complete_requests, 0);
  assert.equal(stats.usage.partial_requests, 1);
  assert.equal(stats.usage.unknown_requests, 0);
  assert.equal(stats.usage.terminal_usage_requests, 0);
});

test('terminal input/output does not imply cache zeros or complete cache-inclusive coverage', () => {
  request('legacy', { inputTokens: 10, outputTokens: 2, usageComplete: true });
  const stats = getStats();
  assert.deepEqual(stats.usage.fresh_input, metric(10, 10, 1, 0));
  assert.deepEqual(stats.usage.output, metric(2, 2, 1, 0));
  assert.deepEqual(stats.usage.cache_read, metric(null, null, 0, 1));
  assert.deepEqual(stats.usage.total_input, metric(null, null, 0, 1));
  assert.equal(stats.usage.partial_requests, 1);
});

test('empty windows remain unobserved, while reported zero usage is actually zero', () => {
  const empty = getStats();
  assert.equal(empty.total_requests, 0);
  assert.equal(empty.total_cost_usd, null);
  assert.deepEqual(empty.by_model, []);
  assert.deepEqual(empty.usage.total_tokens, metric(null, null, 0, 0));
  assert.equal(empty.usage.complete_requests + empty.usage.partial_requests + empty.usage.unknown_requests, 0);
  request('zeros', zeros);
  assert.deepEqual(getStats().usage.total_tokens, metric(0, 0, 1, 0));
});

test('existing inclusive date bounds constrain overall, model and status aggregates together', () => {
  request('before', complete, 'success', '2026-10-23 23:59:59');
  request('inside', complete, 'success', '2026-10-24 00:00:00');
  request('inside', zeros, 'success', '2026-10-24 23:59:59');
  request('after', complete, 'success', '2026-10-25 00:00:00');
  const stats = getStats('2026-10-24 00:00:00', '2026-10-24 23:59:59');
  assert.equal(stats.total_requests, 2);
  assert.deepEqual(stats.by_model.map(row => row.model), ['inside']);
  assert.deepEqual(stats.by_status, [{ status: 'success', count: 2 }]);
  assert.deepEqual(stats.usage.total_tokens, metric(173, 173, 2, 0));
  assert.equal(getStats('2026-10-25 00:00:00').total_requests, 1);
  assert.equal(getStats(undefined, '2026-10-23 23:59:59').total_requests, 1);
});

test('invalid legacy counters and unsafe aggregate totals are not exposed as precise token counts', () => {
  request('legacy', { ...zeros, inputTokens: -1, outputTokens: 0.5 });
  const legacy = getStats().usage;
  assert.deepEqual(legacy.fresh_input, metric(null, null, 0, 1));
  assert.deepEqual(legacy.output, metric(null, null, 0, 1));
  assert.equal(legacy.partial_requests, 1);
  db.exec('DELETE FROM request_log');
  request('huge', { ...zeros, inputTokens: Number.MAX_SAFE_INTEGER });
  request('huge', { ...zeros, inputTokens: 1 });
  assert.deepEqual(getStats().usage.fresh_input, metric(null, null, 2, 0));
});
