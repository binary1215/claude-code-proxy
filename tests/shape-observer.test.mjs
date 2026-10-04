import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarizeRequest, SHAPE_LIMITS } from '../integration/diagnostics/request_shape.mjs';

const secret = 'PRIVATE_AUTH_UA_QUERY_SCHEMA_TOOL_NAME_AND_CONTENT_SENTINEL';
const make = (body, extra = {}) => ({ method: 'POST', url: `/v1/messages?secret=${secret}`,
  headers: { Authorization: `Bearer ${secret}`, 'x-api-key': secret, 'user-agent': secret,
    'anthropic-beta': `oauth-2025-04-20,interleaved-thinking-2025-05-14,${secret}`,
    [`secret-header-${secret}`]: secret }, body: Buffer.from(JSON.stringify(body)), ...extra });

test('shape projection reports native structure without content, header/query values or unknown names', () => {
  const input = make({ model: 'claude-sonnet-4-6', max_tokens: 512,
    system: [{ type: 'text', text: `시스템🙂 ${secret}`, cache_control: { type: 'ephemeral', ttl: '1h' } }],
    thinking: { type: 'enabled', budget_tokens: 2048 },
    messages: [{ role: 'assistant', content: [
      { type: 'thinking', thinking: secret, signature: secret },
      { type: 'redacted_thinking', data: secret },
      { type: 'tool_use', id: secret, name: secret, input: { [secret]: secret } },
    ] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: secret, is_error: true,
      content: [{ type: 'text', text: secret, cache_control: { type: 'ephemeral', ttl: '5m' } }] }] }],
    tools: [{ name: secret, input_schema: { [secret]: secret }, description: secret,
      cache_control: { type: 'ephemeral' } }],
    metadata: { user_id: secret, [secret]: secret }, [secret]: { text: secret },
  });
  const originalBody = Buffer.from(input.body);
  const originalHeaders = { ...input.headers };
  const summary = summarizeRequest(input);
  assert.deepEqual(input.body, originalBody);
  assert.deepEqual(input.headers, originalHeaders);
  assert.equal(summary.endpoint, '/v1/messages');
  assert.equal(summary.headers.authKind, 'both');
  assert.deepEqual(summary.headers.beta.known, ['interleaved-thinking-2025-05-14', 'oauth-2025-04-20']);
  assert.equal(summary.headers.beta.unknownCount, 1);
  assert.equal(summary.headers.unknownFieldCount, 1);
  assert.equal(summary.body.unknownFieldCount, 1);
  assert.equal(summary.body.model.knownId, 'claude-sonnet-4-6');
  assert.equal(summary.body.model.family, 'sonnet');
  assert.equal(summary.body.system.sampled[0].textBytes, Buffer.byteLength(`시스템🙂 ${secret}`));
  assert.equal(summary.body.messages.sampled[0].content.sampled[0].signaturePresent, true);
  assert.equal(summary.body.messages.sampled[1].content.sampled[0].isError, true);
  assert.equal(summary.body.tools.sampled[0].type, 'custom');
  assert.equal(summary.body.metadata.knownPresence.user_id, true);
  assert.equal(summary.body.metadata.unknownFieldCount, 1);
  assert.equal(summary.body.cacheMarkers.observedCount, 3);
  const serialized = JSON.stringify(summary);
  assert.ok(!serialized.includes(secret));
  for (const forbidden of ['Bearer ', 'input_schema', 'description', 'secret-header', '?secret=']) {
    assert.ok(!serialized.includes(forbidden));
  }
});

test('regex-shaped model/beta/tool/block suffixes cannot become a secret logging loophole', () => {
  const disguised = 'claude-sonnet-4-supersecretpayload';
  const summary = summarizeRequest(make({ model: disguised, max_tokens: secret,
    system: secret, messages: [{ role: secret, content: [{ type: secret, text: secret, signature: secret }] }],
    thinking: { type: secret, budget_tokens: secret },
    tools: [{ type: `web_search_${secret}`, name: secret }], metadata: secret,
  }, { method: secret, url: `https://example.invalid/${secret}?query=${secret}` }));
  assert.equal(summary.endpoint, 'unknown');
  assert.equal(summary.method, 'unknown');
  assert.equal(summary.body.model.family, 'sonnet');
  assert.equal(summary.body.model.knownId, null);
  assert.equal(summary.body.thinking.type, 'unknown');
  assert.equal(summary.body.thinking.budgetTokens, null);
  assert.equal(summary.body.maxTokens, null);
  assert.equal(summary.body.messages.sampled[0].role, 'unknown');
  assert.equal(summary.body.messages.sampled[0].content.sampled[0].type, 'unknown');
  assert.equal(summary.body.tools.sampled[0].type, 'unknown');
  assert.ok(!JSON.stringify(summary).includes(secret));
  assert.ok(!JSON.stringify(summary).includes(disguised));
});

test('explicitly approved live-verified model IDs are preserved only by closed enum', () => {
  for (const id of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1']) {
    assert.equal(summarizeRequest(make({ model: id })).body.model.knownId, id);
    const withSecretSuffix = `${id}-private-secret-payload`;
    const summary = summarizeRequest(make({ model: withSecretSuffix }));
    assert.equal(summary.body.model.knownId, null);
    assert.ok(!JSON.stringify(summary).includes(withSecretSuffix));
  }
});

test('large arrays and nested tool results have fixed budgets with explicit truncation', () => {
  let nested = { type: 'text', text: secret };
  for (let i = 0; i < 5; i++) nested = { type: 'tool_result', content: [nested] };
  const summary = summarizeRequest(make({ messages: [{ role: 'user', content: [nested] }] }));
  assert.equal(summary.body.state, 'parsed');
  assert.equal(summary.body.truncated, true);
  const bounded = summarizeRequest(make({
    messages: Array.from({ length: 100 }, () => ({ role: 'user', content: Array.from({ length: 100 }, () => ({ type: 'text', text: secret })) })),
    tools: Array.from({ length: 100 }, () => ({ name: secret })),
  }));
  assert.equal(bounded.body.messages.sampled.length, SHAPE_LIMITS.messages);
  assert.equal(bounded.body.tools.sampled.length, SHAPE_LIMITS.tools);
  assert.equal(bounded.body.messages.truncated, true);
  assert.equal(bounded.body.tools.truncated, true);
  assert.equal(bounded.body.truncated, true);
  assert.equal(bounded.body.cacheMarkers.truncated, true);
  let sampledBlocks = 0;
  for (const message of bounded.body.messages.sampled) sampledBlocks += message.content.sampled.length;
  assert.ok(sampledBlocks <= SHAPE_LIMITS.totalBlocks);
  assert.ok(JSON.stringify(bounded).length < 100000);
  assert.ok(!JSON.stringify(bounded).includes(secret));
});

test('invalid/malformed bodies and headers stay safe and do not echo parsing failures', () => {
  for (const body of [Buffer.from(secret), Buffer.from('null'), Buffer.from('[]'), Buffer.alloc(0),
    Buffer.alloc(SHAPE_LIMITS.bodyBytes + 1, 'x')]) {
    const copy = Buffer.from(body);
    const summary = summarizeRequest(make({}, { body, headers: { 'anthropic-beta': secret.repeat(100) } }));
    assert.deepEqual(body, copy);
    assert.ok(!JSON.stringify(summary).includes(secret));
  }
  assert.equal(summarizeRequest(make({}, { body: secret })).body.state, 'unsupported_type');
  assert.equal(summarizeRequest(make({}, { headers: { 'anthropic-beta': secret.repeat(100) } })).headers.beta.truncated, true);
  assert.equal(summarizeRequest(make({}, { headers: { authorization: secret } })).headers.authKind, 'bearer');
  assert.equal(summarizeRequest(make({}, { headers: { 'x-api-key': secret } })).headers.authKind, 'api_key');
  assert.equal(summarizeRequest(make({}, { headers: {} })).headers.authKind, 'none');
});
