import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, before, mock, test } from 'node:test';
import { randomBytes } from 'node:crypto';

// Isolated process: verify the legacy opt-in cannot bypass per-key permission.
process.env.DATABASE_PATH = ':memory:';
process.env.ADMIN_API_SECRET = randomBytes(24).toString('hex');
process.env.AUTH_DISABLED = 'false';
process.env.ALLOW_SERVER_SIDE_TOOLS = 'true';
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
delete process.env.ANTHROPIC_API_KEY;
const sdkCalls = [];
mock.module('@anthropic-ai/claude-agent-sdk', {
  namedExports: {
    tool: (name, description, schema, handler) => ({ name, description, schema, handler }),
    createSdkMcpServer: (config) => config,
    query: (params) => {
      sdkCalls.push(params);
      const generator = (async function* () {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'mock only' }] } };
        yield { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0 };
      })();
      generator.interrupt = async () => {};
      return generator;
    },
  },
});
const { app } = await import('../dist/app.js');
const { db } = await import('../dist/db/connection.js');
const keys = await import('../dist/services/apiKeyService.js');
let server, base, key;
before(async () => {
  key = keys.createApiKey('legacy-permission-test');
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  console.log(JSON.stringify({ pid: process.pid, ppid: process.ppid, cwd: process.cwd(), port: server.address().port, sdk: 'mock-legacy-permission' }));
});
after(async () => {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  db.close();
});
async function request(tools, headers = {}) {
  return fetch(base + '/v1/messages', {
    method: 'POST', signal: AbortSignal.timeout(5000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key.key}`, ...headers },
    body: JSON.stringify({ model: 'sonnet', max_tokens: 32, messages: [{ role: 'user', content: 'mock only' }], ...(tools ? { tools } : {}) }),
  });
}
test('global opt-in still denies server mapping and header without key grant', async () => {
  assert.equal((await request([{ type: 'web_search_20260209', name: 'web_search' }])).status, 403);
  assert.equal((await request(undefined, { 'x-enable-builtin-tools': 'true' })).status, 403);
  assert.equal(sdkCalls.length, 0);
});
test('legacy mapped tool reaches only mocked SDK after BOTH grants', async () => {
  keys.updateApiKeyBuiltinTools(key.id, true);
  assert.equal((await request([{ type: 'web_search_20260209', name: 'web_search' }])).status, 200);
  assert.deepEqual(sdkCalls.at(-1).options.tools, ['WebSearch']);
  assert.equal(sdkCalls.at(-1).options.persistSession, false);
});
