import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// The historical native-relay regression suite deliberately selects HTTP.
// CLI integration tests select their own backend in the optional worker package.
const root = fileURLToPath(new URL('../', import.meta.url));
const files = readdirSync(join(root, 'tests')).filter(name => name.endsWith('.test.mjs'))
  .sort().map(name => join('tests', name));
const result = spawnSync(process.execPath, ['--test', ...files], {
  cwd: root,
  env: { ...process.env, CLAUDE_INFERENCE_BACKEND: 'http' },
  stdio: 'inherit',
  windowsHide: true,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
