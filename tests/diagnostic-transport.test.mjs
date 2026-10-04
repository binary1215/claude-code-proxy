import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createObservationServer } from '../integration/diagnostics/observe_requests.mjs';

const oauthToken = 'test-oauth-secret-canary';
const proxyKey = 'test-proxy-secret-canary';
const auth = { authorization: 'Bearer ' + oauthToken };
async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`; }
async function setup(t, responder, options = {}) {
  const seen = []; const records = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    seen.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
    responder(req, res);
  });
  const target = await listen(upstream);
  const server = createObservationServer({ oauthToken, proxyKey, directTarget: target, proxyTarget: target,
    offline: true, emit: x => records.push(x), ...options });
  const base = await listen(server);
  t.after(async () => { for (const s of [server, upstream]) { s.closeAllConnections(); await new Promise(r => s.close(r)); } });
  return { base, records, seen };
}

test('observation keeps raw body, query, beta, response bytes; changes only relay auth', async t => {
  const response = '{"error":{"type":"rate_limit_error","message":"response-secret-canary"}}';
  const { base, seen, records } = await setup(t, (_req, res) => { res.writeHead(429, { 'content-type': 'application/json' }); res.end(response); });
  const body = '{ "model":"claude-opus-5-5", "messages":[{"role":"user","content":"prompt-secret-canary"}],"max_tokens":8 }\n';
  for (const route of ['direct', 'relay']) {
    const phase = await fetch(base + '/_control/phase', { method: 'POST', headers: auth, body: route === 'direct' ? 'raw_before' : 'official_relay' });
    assert.equal(phase.status, 204);
    const result = await fetch(base + '/' + route + '/v1/messages?beta=true', { method: 'POST', body,
      headers: { ...auth, 'anthropic-beta': 'oauth-2025-04-20', 'content-type': 'application/json', 'user-agent': 'test-client' } });
    assert.equal(result.status, 429); assert.equal(await result.text(), response);
  }
  assert.equal(seen.length, 2); assert.equal(records.length, 2);
  for (const item of seen) { assert.equal(item.body.toString(), body); assert.equal(item.url, '/v1/messages?beta=true'); assert.equal(item.headers['anthropic-beta'], 'oauth-2025-04-20'); }
  assert.equal(seen[0].headers.authorization, 'Bearer ' + oauthToken);
  assert.equal(seen[1].headers.authorization, 'Bearer ' + proxyKey);
  assert.equal(records[1].phase, 'official_relay');
  assert.equal(records[0].diagnostics.upstream_diagnostic, 'unknown_429');
  for (const secret of [oauthToken, proxyKey, 'prompt-secret-canary', 'response-secret-canary', 'test-client']) assert.ok(!JSON.stringify(records).includes(secret));
});

test('auth, alternate credential, route and global request bounds fail closed without retry', async t => {
  const { base, seen } = await setup(t, (_req, res) => res.end('{}'), { maxRequests: 1 });
  assert.equal((await fetch(base + '/direct/v1/models')).status, 401);
  assert.equal((await fetch(base + '/direct/v1/models', { headers: { authorization: 'Bearer wrong-token' } })).status, 401);
  assert.equal((await fetch(base + '/direct/v1/models', { headers: { ...auth, 'x-api-key': 'competing-secret' } })).status, 400);
  assert.equal(await new Promise(resolve => {
    http.get(base + '/direct/v1/models', { headers: { ...auth, connection: 'authorization' } }, res => { res.resume(); resolve(res.statusCode); });
  }), 400);
  assert.equal((await fetch(base + '/direct/unapproved', { headers: auth })).status, 404);
  assert.equal((await fetch(base + '/_control/phase', { method: 'POST', headers: auth, body: 'unknown' })).status, 400);
  assert.equal((await fetch(base + '/direct/v1/models', { headers: auth })).status, 200);
  assert.equal((await fetch(base + '/direct/v1/models', { headers: auth })).status, 429);
  assert.equal(seen.length, 1);
});

test('deadline produces one safe diagnostic and no retry', async t => {
  const { base, seen, records } = await setup(t, () => {}, { timeoutMs: 40 });
  const response = await fetch(base + '/direct/v1/models', { headers: auth });
  assert.equal(response.status, 502); await response.text();
  assert.equal(seen.length, 1); assert.equal(records.length, 1);
  assert.equal(records[0].diagnostics.upstream_diagnostic, 'timeout');
});

test('aborted control request does not terminate server; cancellation is recorded once', async t => {
  const { base, records } = await setup(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: {}\n\n'); });
  await new Promise(resolve => {
    const req = http.request(base + '/_control/phase', { method: 'POST', headers: { ...auth, 'content-length': 30 } });
    req.on('error', resolve); req.write('raw'); setTimeout(() => req.destroy(), 20);
  });
  assert.equal((await fetch(base + '/_control/phase', { method: 'POST', headers: auth, body: 'raw_after' })).status, 204);
  await new Promise(resolve => {
    const req = http.get(base + '/direct/v1/models', { headers: auth }, res => { res.once('data', () => { res.destroy(); resolve(); }); });
    req.on('error', resolve);
  });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(records.length, 1); assert.equal(records[0].diagnostics.upstream_diagnostic, 'cancelled');
});

test('target and credential validation never returns input values', () => {
  const base = { oauthToken, proxyKey, directTarget: 'http://127.0.0.1:1/', proxyTarget: 'http://127.0.0.1:2/', offline: true };
  for (const override of [{ directTarget: 'secret-invalid-url' }, { directTarget: 'https://example.com/' }, { directTarget: 'http://user:password@127.0.0.1/' }, { oauthToken: 'short' }, { maxRequests: 13 }]) {
    assert.throws(() => createObservationServer({ ...base, ...override }), error => !JSON.stringify(error).includes('secret-invalid-url') && !error.message.includes('password'));
  }
});
