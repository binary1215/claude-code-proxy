import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readAuthSnapshot, observeAuthSession, acceptAuthRefresh, clearAuthSession,
  credentialStateBinding } from '../dist/services/claudeCliSession.js';
import { ResponsesStateCodec, upstreamStateScope } from '../dist/services/responsesState.js';

const first = 'sk-ant-oat-synthetic-session-first';
const second = 'sk-ant-oat-synthetic-session-second';
const refresh = 'sk-ant-ort-synthetic-session-private';
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'cli-session-test-'));
  const credentials = join(dir, '.credentials.json');
  const config = join(dir, '.claude.json');
  const session = join(dir, '.proxy-auth-session.json');
  const initialExpiry = Date.now() + 60_000;
  function write(accessToken = first, expiresAt = initialExpiry, account = 'synthetic-account-one', org = 'synthetic-org-one', refreshToken = refresh) {
    writeFileSync(credentials, JSON.stringify({ claudeAiOauth: { accessToken, expiresAt, refreshToken } }));
    writeFileSync(config, JSON.stringify({ oauthAccount: { accountUuid: account, organizationUuid: org } }));
    return readAuthSnapshot(dir);
  }
  write();
  return { dir, credentials, config, session, write, initialExpiry,
    close: () => rmSync(dir, { recursive: true, force: true }) };
}

test('session binding persists across process/module reload and stores no raw credentials or IDs', async () => {
  const f = fixture();
  try {
    const snapshot = readAuthSnapshot(f.dir);
    observeAuthSession(f.dir, snapshot);
    const binding = credentialStateBinding(f.dir, first);
    assert.match(binding, /^cli-session:[a-f0-9]{64}:[a-f0-9]{64}$/);
    const initialRecord = readFileSync(f.session, 'utf8');
    observeAuthSession(f.dir, snapshot);
    assert.equal(readFileSync(f.session, 'utf8'), initialRecord);
    const reloaded = await import('../dist/services/claudeCliSession.js?reload=restart-fixture');
    assert.equal(reloaded.credentialStateBinding(f.dir, first), binding);
    const restarted = spawnSync(process.execPath, ['--input-type=module', '-e',
      'const module = await import(process.argv[1]); process.stdout.write(JSON.stringify(module.credentialStateBinding(process.argv[2], process.argv[3])));',
      new URL('../dist/services/claudeCliSession.js', import.meta.url).href, f.dir, first],
      { encoding: 'utf8', timeout: 5000 });
    assert.equal(restarted.status, 0, restarted.stderr);
    assert.equal(JSON.parse(restarted.stdout), binding);
    for (const secret of [first, refresh, 'synthetic-account-one', 'synthetic-org-one']) {
      assert.ok(!initialRecord.includes(secret));
      assert.ok(!JSON.stringify(snapshot).includes(secret));
    }
    if (process.platform !== 'win32') assert.equal(statSync(f.session).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(f.dir).sort(), ['.claude.json', '.credentials.json', '.proxy-auth-session.json']);
  } finally { f.close(); }
});

test('coordinator-verified same-account refresh preserves signed reasoning across restart', () => {
  const f = fixture();
  try {
    const before = readAuthSnapshot(f.dir);
    observeAuthSession(f.dir, before);
    const binding = credentialStateBinding(f.dir, first);
    const key = randomBytes(32).toString('base64');
    const codec = new ResponsesStateCodec(key, 600);
    const upstreamBase = 'https://fixture.invalid/v1/messages';
    const context = { model: 'native-fixture', principal: 'fixture-key',
      upstream: upstreamStateScope(upstreamBase, { kind: 'oauth', token: first, stateIdentity: binding }) };
    const block = { type: 'thinking', thinking: 'unchanged thought', signature: 'opaque-signature' };
    const capsule = codec.seal(block, context, 'rs_fixture');
    const after = f.write(second, Date.now() + 28_800_000, undefined, undefined, refresh + '-rotated');
    assert.equal(credentialStateBinding(f.dir, second), undefined, 'Uncommitted rotation has no stable binding');
    assert.equal(acceptAuthRefresh(f.dir, before, after), true);
    assert.equal(credentialStateBinding(f.dir, second), binding);
    assert.equal(credentialStateBinding(f.dir, first), undefined);
    const renewedContext = { ...context, upstream: upstreamStateScope(upstreamBase,
      { kind: 'oauth', token: second, stateIdentity: credentialStateBinding(f.dir, second) }) };
    assert.equal(renewedContext.upstream, context.upstream);
    assert.deepEqual(new ResponsesStateCodec(key, 600).open(capsule, renewedContext), { itemId: 'rs_fixture', block });
    observeAuthSession(f.dir, after);
    assert.equal(credentialStateBinding(f.dir, second), binding);
  } finally { f.close(); }
});

test('unexplained credential/account changes and explicit logout create a different binding', () => {
  const f = fixture();
  try {
    observeAuthSession(f.dir, readAuthSnapshot(f.dir));
    const initial = credentialStateBinding(f.dir, first);
    const changed = f.write(second, Date.now() + 3_600_000);
    assert.equal(credentialStateBinding(f.dir, second), undefined);
    observeAuthSession(f.dir, changed);
    const externalBinding = credentialStateBinding(f.dir, second);
    assert.notEqual(externalBinding, initial);
    const otherAccount = f.write(second, Date.now() + 7_200_000, 'synthetic-account-two');
    assert.equal(credentialStateBinding(f.dir, second), undefined);
    assert.equal(acceptAuthRefresh(f.dir, changed, otherAccount), false);
    const otherBinding = credentialStateBinding(f.dir, second);
    assert.notEqual(otherBinding, externalBinding);
    const otherOrg = f.write(second, Date.now() + 7_200_000, 'synthetic-account-two', 'synthetic-org-two');
    assert.equal(credentialStateBinding(f.dir, second), undefined);
    observeAuthSession(f.dir, otherOrg);
    const otherOrgBinding = credentialStateBinding(f.dir, second);
    assert.notEqual(otherOrgBinding, otherBinding);
    clearAuthSession(f.dir);
    assert.equal(credentialStateBinding(f.dir, second), undefined);
    clearAuthSession(f.dir);
    observeAuthSession(f.dir, otherOrg);
    assert.notEqual(credentialStateBinding(f.dir, second), otherOrgBinding);
  } finally { f.close(); }
});

test('stale pre-refresh observation, missing identity and invalid renewal cannot inherit a session', () => {
  const f = fixture();
  try {
    const before = readAuthSnapshot(f.dir);
    observeAuthSession(f.dir, before);
    const initial = credentialStateBinding(f.dir, first);
    const unrelated = f.write('sk-ant-oat-synthetic-unrelated', Date.now() + 3_600_000);
    observeAuthSession(f.dir, unrelated);
    const after = f.write(second, Date.now() + 28_800_000);
    assert.equal(acceptAuthRefresh(f.dir, before, after), false);
    assert.notEqual(credentialStateBinding(f.dir, second), initial);
    const prior = credentialStateBinding(f.dir, second);
    const nonRenewal = f.write(first, Date.now() - 1000);
    assert.equal(acceptAuthRefresh(f.dir, after, nonRenewal), false);
    assert.notEqual(credentialStateBinding(f.dir, first), prior);
    assert.ok(readAuthSnapshot(f.dir), 'Expired snapshots still allow the coordinator to attempt refresh');
    writeFileSync(f.config, '{}');
    const missingAccount = readAuthSnapshot(f.dir);
    assert.equal(missingAccount.accountDigest, null);
    observeAuthSession(f.dir, missingAccount);
    assert.equal(credentialStateBinding(f.dir, first), undefined);
    const renewedWithoutAccount = { ...missingAccount, accessDigest: after.accessDigest, expiresAt: Date.now() + 28_800_000 };
    assert.equal(acceptAuthRefresh(f.dir, missingAccount, renewedWithoutAccount), false);
  } finally { f.close(); }
});

test('malformed or oversized reads remain unavailable and lookup never repairs stored data', () => {
  const f = fixture();
  try {
    observeAuthSession(f.dir, readAuthSnapshot(f.dir));
    writeFileSync(f.session, '{ malformed');
    assert.equal(credentialStateBinding(f.dir, first), undefined);
    assert.equal(readFileSync(f.session, 'utf8'), '{ malformed');
    writeFileSync(f.credentials, 'x'.repeat(256 * 1024 + 1));
    assert.equal(readAuthSnapshot(f.dir), null);
    writeFileSync(f.credentials, '{"claudeAiOauth":null}');
    assert.equal(readAuthSnapshot(f.dir), null);
    f.write();
    writeFileSync(f.config, '{"oauthAccount":');
    assert.equal(readAuthSnapshot(f.dir).accountDigest, null);
    assert.equal(readAuthSnapshot(join(f.dir, 'missing')), null);
  } finally { f.close(); }
});
