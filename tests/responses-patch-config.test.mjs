import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';

test('grammar adaptation is explicit opt-in and misspelled modes fail startup without echoing input', () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    ['SYSTEMROOT','WINDIR','PATH','PATHEXT','TEMP','TMP'].includes(name.toUpperCase())));
  env.DATABASE_PATH = ':memory:';
  const url = new URL('../dist/config.js', import.meta.url).href;
  const code = `import {RESPONSES_APPLY_PATCH_MODE} from ${JSON.stringify(url)}; console.log(RESPONSES_APPLY_PATCH_MODE);`;
  for (const [mode, expected] of [[undefined, 'reject'], ['reject', 'reject'], ['validated', 'validated'], ['', null], ['PRIVATE_BAD_MODE', null]]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      env: {...env, ...(mode === undefined ? {} : {RESPONSES_APPLY_PATCH_MODE: mode})},
      encoding: 'utf8', timeout: 5000, windowsHide: true,
    });
    assert(!result.error);
    if (expected) { assert.equal(result.status, 0); assert.equal(result.stdout.trim(), expected); }
    else { assert.notEqual(result.status, 0); assert(result.stderr.includes('must be reject or validated')); }
    assert(!result.stderr.includes('PRIVATE_BAD_MODE'));
  }
});
