import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('login helper quotes email, preserves terminal stdin and isolates provider environment',
  { skip: process.platform === 'win32' }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-helper-fixture-'));
    const config = join(dir, 'auth');
    mkdirSync(config);
    const stub = join(dir, 'stub.mjs');
    writeFileSync(stub, `import fs from 'node:fs';
      console.log(JSON.stringify({args:process.argv.slice(2),input:fs.readFileSync(0,'utf8'),
      cwd:process.cwd(),config:process.env.CLAUDE_CONFIG_DIR,
      overrides:['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN',
      'ANTHROPIC_BASE_URL','CLAUDE_CODE_USE_BEDROCK'].filter(k=>process.env[k])}));`);
    writeFileSync(join(dir, 'claude'), '#!/bin/sh\nexec "$FIXTURE_NODE" "$FIXTURE_SCRIPT" "$@"\n', { mode: 0o700 });
    const email = 'fixture+literal;$(false)@example.invalid';
    const env = { ...process.env, PATH: dir + ':' + process.env.PATH,
      FIXTURE_NODE: process.execPath, FIXTURE_SCRIPT: stub, CLAUDE_CONFIG_DIR: config,
      CLAUDE_AUTH_EMAIL: email, ANTHROPIC_API_KEY: 'fixture', ANTHROPIC_AUTH_TOKEN: 'fixture',
      CLAUDE_CODE_OAUTH_TOKEN: 'fixture', ANTHROPIC_BASE_URL: 'http://fixture.invalid',
      CLAUDE_CODE_USE_BEDROCK: '1' };
    try {
      for (const action of ['login', 'logout']) {
        const child = spawnSync('/bin/sh', [resolve('bin/claude-auth'), action],
          { env, input: 'synthetic-callback-code\n', encoding: 'utf8', timeout: 5000 });
        assert.equal(child.status, 0, child.stderr);
        const result = JSON.parse(child.stdout);
        assert.deepEqual(result.args, action === 'login' ? ['auth', 'login', '--email', email] : ['auth', 'logout']);
        assert.equal(result.input, 'synthetic-callback-code\n');
        assert.equal(result.cwd, config);
        assert.deepEqual(result.overrides, []);
      }
      delete env.CLAUDE_AUTH_EMAIL;
      const child = spawnSync('/bin/sh', [resolve('bin/claude-auth'), 'login'],
        { env, input: '', encoding: 'utf8', timeout: 5000 });
      assert.equal(child.status, 0, child.stderr);
      assert.deepEqual(JSON.parse(child.stdout).args, ['auth', 'login']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
