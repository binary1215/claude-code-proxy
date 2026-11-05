import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { after, test } from 'node:test';
import { randomBytes } from 'node:crypto';

const dir = mkdtempSync(join(tmpdir(), 'cli-transition-'));
process.env.DATABASE_PATH = ':memory:';
process.env.UPSTREAM_AUTH_SOURCE = 'claude_cli';
process.env.CLAUDE_AUTH_AUTO_REFRESH = 'true';
process.env.CLAUDE_CONFIG_DIR = dir;
const settings = await import('../dist/services/settingsService.js');
const session = await import('../dist/services/claudeCliSession.js');
const { saveRefreshRecord } = await import('../dist/services/authRefreshStatus.js');
const { ResponsesStateCodec, upstreamStateScope } = await import('../dist/services/responsesState.js');
const { db } = await import('../dist/db/connection.js');
after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
function write(token, expiresAt) {
  writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: {
    accessToken: token, refreshToken: 'synthetic-refresh', expiresAt } }));
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'fixture-a', organizationUuid: 'fixture-o' } }));
}
function refreshState(state, checked = new Date().toISOString()) {
  saveRefreshRecord(dir, { state, checked_at: checked, last_success_at: null,
    next_attempt_at: null, failures: 0, successes: 0, reason: null, access_digest: null, refresh_digest: null });
}
test('request waits for coordinated token/session commit and preserves original reasoning capsule', async () => {
  write('synthetic-access-before', Date.now() + 90_000);
  const before = session.readAuthSnapshot(dir);
  session.observeAuthSession(dir, before);
  const credential = settings.getUpstreamCredential();
  const codec = new ResponsesStateCodec(randomBytes(32).toString('base64'), 600);
  const context = { model: 'fixture-model', principal: 'fixture-key', upstream: upstreamStateScope('https://fixture/messages', credential) };
  const block = { type: 'thinking', thinking: 'keep this exactly', signature: 'opaque-signed-fixture' };
  const capsule = codec.seal(block, context, 'rs_fixture');
  refreshState('refreshing');
  let oldResolved = false;
  const oldPending = settings.resolveUpstreamCredential().then(value => { oldResolved = true; return value; });
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(oldResolved, false, 'New requests also wait while the old access token remains stored');
  write('synthetic-access-after', Date.now() + 28_800_000);
  let resolved = false;
  const pending = settings.resolveUpstreamCredential().then(value => { resolved = true; return value; });
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(resolved, false);
  session.acceptAuthRefresh(dir, before, session.readAuthSnapshot(dir));
  refreshState('refreshed');
  const next = await pending;
  assert.equal((await oldPending).token, next.token);
  assert.equal(next.stateIdentity, credential.stateIdentity);
  assert.deepEqual(codec.open(capsule, { ...context, upstream: upstreamStateScope('https://fixture/messages', next) }),
    { itemId: 'rs_fixture', block });
});
test('abandoned refresh marker does not stall requests and cancellation exits the wait', async () => {
  write('synthetic-external-token', Date.now() + 28_800_000);
  refreshState('refreshing', new Date(Date.now() - 80_000).toISOString());
  assert.equal((await settings.resolveUpstreamCredential()).token, 'synthetic-external-token');
  refreshState('refreshing');
  assert.equal((await settings.resolveUpstreamCredential(() => true)).token, 'synthetic-external-token');
});
