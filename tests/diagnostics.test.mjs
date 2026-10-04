import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UpstreamDiagnosticsObserver, sanitizeDiagnostics } from '../dist/services/upstreamDiagnostics.js';

const secret = 'PRIVATE_CREDENTIAL_BODY_AND_ERROR_MESSAGE_SENTINEL';
const requestId = 'req_011abcdefghijklmnopqrstuv';
const jsonObserver = (status = 429, headers = {}) => {
  const observer = new UpstreamDiagnosticsObserver('oauth');
  observer.receive(status, { 'content-type': 'application/json', ...headers });
  return observer;
};

test('429 without recognized cause stays unknown_429, never inferred entitlement/quota', () => {
  for (const error of [{ message: secret }, { type: 'rate_limit_error', message: secret }]) {
    const observer = jsonObserver();
    observer.write(Buffer.from(JSON.stringify({ type: 'error', error })));
    observer.end();
    const diagnostic = observer.snapshot();
    assert.equal(diagnostic.upstream_http_status, 429);
    assert.equal(diagnostic.upstream_diagnostic, 'unknown_429');
    assert.equal(diagnostic.upstream_error_code, null);
    assert.equal(diagnostic.upstream_body_observation, 'observed');
    assert.ok(!JSON.stringify(diagnostic).includes(secret));
  }
});

test('strict provider error enums and safe request/quota/retry headers are source facts only', () => {
  const observer = jsonObserver(429, {
    'request-id': requestId, 'retry-after': '30',
    'anthropic-ratelimit-unified-5h-status': 'rejected',
    'anthropic-ratelimit-unified-5h-reset': '2000000000',
    'anthropic-ratelimit-unified-5h-utilization': '0.95',
    'anthropic-ratelimit-unified-7d-reset': '2030-01-02T03:04:05Z',
    'x-unknown-quota-header': secret,
  });
  observer.write(Buffer.from(JSON.stringify({ type: 'error', error: {
    type: 'rate_limit_error', code: 'quota_exceeded', message: secret,
  } })));
  observer.end();
  const fields = observer.snapshot();
  assert.equal(fields.upstream_error_type, 'rate_limit_error');
  assert.equal(fields.upstream_error_code, 'quota_exceeded');
  assert.equal(fields.upstream_diagnostic, 'provider_error');
  assert.equal(fields.upstream_request_id, requestId);
  assert.equal(fields.upstream_retry_after, '30');
  assert.equal(fields.upstream_auth_kind, 'oauth');
  assert.deepEqual(JSON.parse(fields.upstream_quota_headers), {
    'anthropic-ratelimit-unified-5h-status': 'rejected',
    'anthropic-ratelimit-unified-5h-reset': 2000000000,
    'anthropic-ratelimit-unified-5h-utilization': 0.95,
    'anthropic-ratelimit-unified-7d-reset': '2030-01-02T03:04:05.000Z',
  });
  assert.ok(!JSON.stringify(fields).includes(secret));
});

test('malformed/open-ended values and unknown codes never reach stored diagnostics', () => {
  const observer = jsonObserver(429, {
    'request-id': `Bearer ${secret}`, 'x-request-id': [requestId, secret],
    'retry-after': secret,
    'anthropic-ratelimit-unified-status': `allowed ${secret}`,
    'anthropic-ratelimit-unified-5h-utilization': 'NaN',
    'anthropic-ratelimit-unified-7d-utilization': '1e2',
    'anthropic-ratelimit-unified-overage-reset': '2030-02-31T00:00:00Z',
  });
  observer.write(Buffer.from(JSON.stringify({ type: 'error', error: {
    type: secret, code: secret, details: { error_code: secret }, message: secret,
  } })));
  observer.end();
  const fields = observer.snapshot();
  for (const key of ['upstream_error_type', 'upstream_error_code', 'upstream_request_id',
    'upstream_retry_after', 'upstream_quota_headers']) assert.equal(fields[key], null);
  assert.equal(fields.upstream_diagnostic, 'unknown_429');
  assert.ok(!JSON.stringify(fields).includes(secret));
});

test('SSE diagnostics parse multiline/error frames across Unicode/CR byte boundaries passively', () => {
  const observer = new UpstreamDiagnosticsObserver('api_key');
  observer.receive(200, { 'content-type': 'text/event-stream' });
  const bytes = Buffer.from('event: error\rdata: {"type":"error",\rdata: "error":' +
    JSON.stringify({ type: 'invalid_request_error', details: { error_code: 'claude_code_version_too_old' },
      message: `한글🙂 ${secret}` }) + '}\r\r');
  for (let i = 0; i < bytes.length; i++) observer.write(bytes.subarray(i, i + 1));
  observer.end();
  const fields = observer.snapshot();
  assert.equal(fields.upstream_error_type, 'invalid_request_error');
  assert.equal(fields.upstream_error_code, 'claude_code_version_too_old');
  assert.equal(fields.upstream_body_observation, 'observed');
  assert.equal(fields.upstream_diagnostic, 'provider_error');
  assert.ok(!JSON.stringify(fields).includes(secret));
});

test('compressed/oversized/incomplete/invalid observations are distinct without body retention', () => {
  const compressed = jsonObserver(429, { 'content-encoding': 'gzip' });
  compressed.write(Buffer.from(secret)); compressed.end();
  assert.equal(compressed.snapshot().upstream_body_observation, 'compressed');
  assert.equal(compressed.snapshot().upstream_diagnostic, 'unknown_429');
  const oversized = jsonObserver();
  oversized.write(Buffer.from(JSON.stringify({ message: 'x'.repeat(65537) }))); oversized.end();
  assert.equal(oversized.snapshot().upstream_body_observation, 'too_large');
  const invalid = jsonObserver(); invalid.write(Buffer.from(secret)); invalid.end();
  assert.equal(invalid.snapshot().upstream_body_observation, 'invalid_json');
  const incomplete = new UpstreamDiagnosticsObserver('api_key');
  incomplete.receive(200, { 'content-type': 'text/event-stream' });
  incomplete.write(Buffer.from('data: {"type":"message_start"}\n\n')); incomplete.end();
  assert.equal(incomplete.snapshot('truncated_stream').upstream_body_observation, 'incomplete');
  assert.equal(incomplete.snapshot('truncated_stream').upstream_diagnostic, 'truncated_stream');
});

test('storage sanitizer repeats validation and accepts only canonical ID/date/enum shapes', () => {
  assert.deepEqual(sanitizeDiagnostics(null), sanitizeDiagnostics());
  const safe = sanitizeDiagnostics({ upstream_http_status: 429, upstream_request_id: '123e4567-e89b-12d3-a456-426614174000',
    upstream_retry_after: 'Wed, 21 Oct 2015 07:28:00 GMT' });
  assert.equal(safe.upstream_request_id, '123e4567-e89b-12d3-a456-426614174000');
  assert.equal(safe.upstream_retry_after, 'Wed, 21 Oct 2015 07:28:00 GMT');
  const unsafe = sanitizeDiagnostics({ upstream_http_status: secret, upstream_error_type: secret,
    upstream_error_code: secret, upstream_request_id: secret, upstream_retry_after: '999999999',
    upstream_quota_headers: JSON.stringify({ 'anthropic-ratelimit-unified-status': secret, authorization: secret }),
    upstream_auth_kind: secret, upstream_diagnostic: secret, upstream_body_observation: secret });
  for (const value of Object.values(unsafe)) assert.equal(value, null);
});

test('SSE observer bounds framing-only/empty-data events too', () => {
  const observer = new UpstreamDiagnosticsObserver('api_key');
  observer.receive(200, { 'content-type': 'text/event-stream' });
  observer.write(Buffer.from('data:\n'.repeat(65537) + '\n'));
  observer.write(Buffer.from('data: {"type":"message_stop"}\n\n'));
  observer.end();
  assert.equal(observer.snapshot().upstream_body_observation, 'too_large');
});

test('an SSE error event remains provider_error even with unrecognized enums; 429 stays unknown', () => {
  for (const status of [200, 429]) {
    const observer = new UpstreamDiagnosticsObserver('api_key');
    observer.receive(status, { 'content-type': 'text/event-stream' });
    observer.write(Buffer.from('event: error\ndata: ' + JSON.stringify({ type: 'error',
      error: { type: secret, code: secret, message: secret } }) + '\n\n'));
    observer.end();
    const diagnostic = observer.snapshot();
    assert.equal(diagnostic.upstream_diagnostic, status === 429 ? 'unknown_429' : 'provider_error');
    assert.equal(observer.snapshot('provider_error').upstream_diagnostic, status === 429 ? 'unknown_429' : 'provider_error');
    assert.equal(diagnostic.upstream_error_type, null);
    assert.equal(diagnostic.upstream_error_code, null);
    assert.equal(diagnostic.upstream_body_observation, 'observed');
    assert.ok(!JSON.stringify(diagnostic).includes(secret));
  }
});
