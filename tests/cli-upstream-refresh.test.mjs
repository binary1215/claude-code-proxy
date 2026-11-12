import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { after, test } from 'node:test';

// Scripted loopback HTTP only: these files/strings are synthetic fixtures,
// never an existing Claude login, SDK process or actual inference request.
const directory = mkdtempSync(join(tmpdir(), 'cli-upstream-refresh-'));
const providerCalls = [];
const registrations = new Set();
const provider = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  providerCalls.push({ authorization: req.headers.authorization, path: req.url,
    body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'message', id: 'synthetic-forwarded-message', model: 'fixture',
    role: 'assistant', content: [{ type: 'text', text: 'SCRIPTED_FORWARD_OK' }],
    stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
});
provider.listen(0, '127.0.0.1');
await once(provider, 'listening');
const providerBase = `http://127.0.0.1:${provider.address().port}`;
Object.assign(process.env, {
  DATABASE_PATH: ':memory:', UPSTREAM_AUTH_SOURCE: 'claude_cli',
  CLAUDE_AUTH_AUTO_REFRESH: 'true', CLAUDE_CONFIG_DIR: directory,
  ANTHROPIC_BASE_URL: providerBase, UPSTREAM_TIMEOUT_MS: '5000',
  CLAUDE_INFERENCE_BACKEND: 'http', RESPONSES_ENABLED: 'false',
});
const settings = await import('../dist/services/settingsService.js');
const authSession = await import('../dist/services/claudeCliSession.js');
const { saveRefreshRecord } = await import('../dist/services/authRefreshStatus.js');
const { upstreamStateScope } = await import('../dist/services/responsesState.js');
const { registerCliUpstream, closeCliUpstream } = await import('../dist/services/cliUpstream.js');
const { db } = await import('../dist/db/connection.js');

after(async () => {
  for (const registration of registrations) registration.close();
  await closeCliUpstream();
  provider.closeAllConnections();
  await new Promise(resolveClose => provider.close(resolveClose));
  db.close();
  const target = resolve(directory), temporaryRoot = resolve(tmpdir());
  assert.ok(target.startsWith(temporaryRoot + sep) && basename(target).startsWith('cli-upstream-refresh-'));
  rmSync(target, { recursive: true, force: true });
});

function writeCredential(token, expiresAt) {
  writeFileSync(join(directory, '.credentials.json'), JSON.stringify({ claudeAiOauth: {
    accessToken: token, refreshToken: 'synthetic-refresh-token', expiresAt,
  } }));
  writeFileSync(join(directory, '.claude.json'), JSON.stringify({ oauthAccount: {
    accountUuid: 'synthetic-forwarder-account', organizationUuid: 'synthetic-forwarder-org',
  } }));
}

function refreshState(state) {
  saveRefreshRecord(directory, { state, checked_at: new Date().toISOString(),
    last_success_at: null, next_attempt_at: null, failures: 0, successes: 0,
    reason: null, access_digest: null, refresh_digest: null });
}

async function until(predicate, message) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise(resolveWait => setTimeout(resolveWait, 10));
  }
}

async function register() {
  const credential = settings.getUpstreamCredential();
  assert.ok(credential?.stateIdentity, 'Synthetic account must have a committed auth-session identity');
  const turn = { active: true, calls: 0, model: 'fixture', scope: upstreamStateScope(providerBase, credential) };
  const registration = await registerCliUpstream(turn);
  registrations.add(registration);
  return { credential, turn, registration };
}

function request(registration) {
  let req;
  const response = new Promise((resolveResponse, reject) => {
    req = http.request(`${registration.base}/v1/messages`, { method: 'POST',
      headers: { authorization: `Bearer ${registration.token}`, 'content-type': 'application/json' } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolveResponse({ status: res.statusCode, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ model: 'fixture', max_tokens: 32, messages: [{ role: 'user', content: 'Synthetic forwarder fixture.' }] }));
  });
  // Cancellation may reject before the test reaches its awaited assertion.
  void response.catch(() => {});
  return { req, response };
}

test('the same private forwarder nonce and scope survive a coordinated OAuth refresh', async () => {
  writeCredential('synthetic-access-old', Date.now() + 90_000);
  const before = authSession.readAuthSnapshot(directory);
  authSession.observeAuthSession(directory, before);
  refreshState('idle');
  const { credential, turn, registration } = await register();
  const initialCalls = providerCalls.length;
  try {
    const first = await request(registration).response;
    assert.equal(first.status, 200);
    assert.equal(first.value.content[0].text, 'SCRIPTED_FORWARD_OK');
    assert.equal(providerCalls.length, initialCalls + 1);
    assert.equal(providerCalls.at(-1).authorization, 'Bearer synthetic-access-old');
    assert.equal(providerCalls.at(-1).path, '/v1/messages');

    turn.calls = 0;
    refreshState('refreshing');
    const second = request(registration);
    await until(() => turn.calls === 1, 'Forwarder must enter its credential refresh wait');
    await new Promise(resolveWait => setTimeout(resolveWait, 80));
    assert.equal(providerCalls.length, initialCalls + 1, 'A refreshing token must not reach the provider');

    writeCredential('synthetic-access-new', Date.now() + 28_800_000);
    assert.equal(authSession.acceptAuthRefresh(directory, before, authSession.readAuthSnapshot(directory)), true);
    refreshState('idle');
    const refreshed = settings.getUpstreamCredential();
    assert.equal(refreshed.stateIdentity, credential.stateIdentity);
    assert.equal(upstreamStateScope(providerBase, refreshed), turn.scope);

    const result = await second.response;
    assert.equal(result.status, 200);
    assert.equal(providerCalls.length, initialCalls + 2);
    assert.equal(providerCalls.at(-1).authorization, 'Bearer synthetic-access-new');
    assert.equal(turn.calls, 1, 'A caller turn forwards exactly one model request');
    await new Promise(resolveWait => setTimeout(resolveWait, 80));
    assert.equal(providerCalls.length, initialCalls + 2, 'Refresh does not create another model request');
  } finally { turn.active = false; registration.close(); registrations.delete(registration); }
});

test('closing a caller during credential refresh never starts a provider request afterward', async () => {
  writeCredential('synthetic-access-cancelled', Date.now() + 90_000);
  authSession.observeAuthSession(directory, authSession.readAuthSnapshot(directory));
  refreshState('refreshing');
  const { turn, registration } = await register();
  const initialCalls = providerCalls.length;
  const pending = request(registration);
  try {
    await until(() => turn.calls === 1, 'Forwarder must be inside its credential refresh wait before cancellation');
    await new Promise(resolveWait => setTimeout(resolveWait, 70));
    assert.equal(providerCalls.length, initialCalls);
    turn.active = false;
    registration.close();
    registrations.delete(registration);
    pending.req.destroy(new Error('Synthetic caller cancellation'));
    await assert.rejects(pending.response);
    refreshState('idle');
    // resolveUpstreamCredential polls at 50ms; wait beyond its next two polls.
    await new Promise(resolveWait => setTimeout(resolveWait, 160));
    assert.equal(providerCalls.length, initialCalls, 'An already-cancelled refresh wait must not launch inference');
    assert.equal(turn.outgoing, undefined);
  } finally { refreshState('idle'); turn.active = false; registration.close(); registrations.delete(registration); }
});
