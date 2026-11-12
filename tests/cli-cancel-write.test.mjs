import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { after, test } from 'node:test';

// Exercise a connected, blocked HTTP response without starting a CLI, network
// listener, credential reader or provider request.
Object.assign(process.env, {
  DATABASE_PATH: ':memory:', AUTH_DISABLED: 'true', UPSTREAM_AUTH_SOURCE: 'configured',
  CLAUDE_INFERENCE_BACKEND: 'http', CLAUDE_AUTH_AUTO_REFRESH: 'false', RESPONSES_ENABLED: 'false',
});
const { writeCliBytes } = await import('../dist/services/cliRelay.js');
const { db } = await import('../dist/db/connection.js');
after(() => db.close());

class MockResponse extends EventEmitter {
  destroyed = false;
  writes = [];
  constructor(acceptsMore = false) { super(); this.acceptsMore = acceptsMore; }
  write(bytes) { this.writes.push(Buffer.from(bytes)); return this.acceptsMore; }
}

function noWaitListeners(response, signal) {
  assert.equal(response.listenerCount('drain'), 0);
  assert.equal(response.listenerCount('close'), 0);
  assert.equal(getEventListeners(signal, 'abort').length, 0);
}

async function boundedOutcome(pending) {
  let timer;
  try {
    return await Promise.race([
      pending.then(() => ({ kind: 'resolved' }), error => ({ kind: 'rejected', error })),
      new Promise(resolve => { timer = setTimeout(() => resolve({ kind: 'stalled' }), 250); }),
    ]);
  } finally { clearTimeout(timer); }
}

test('abort interrupts a connected backpressured CLI write without needing drain or socket close', async () => {
  const response = new MockResponse(false), controller = new AbortController();
  const pending = writeCliBytes(response, Buffer.from('synthetic SSE bytes'), controller.signal);
  void pending.catch(() => {});
  assert.equal(response.writes.length, 1);
  assert.equal(response.listenerCount('drain'), 1);
  controller.abort();
  let outcome;
  try {
    outcome = await boundedOutcome(pending);
    assert.equal(outcome.kind, 'rejected', 'Cancellation must settle a blocked write even while the client remains connected');
    assert.equal(outcome.error.code, 'request_cancelled');
    assert.equal(outcome.error.status, 499);
    assert.equal(response.destroyed, false, 'The helper must not depend on a socket-close event');
    noWaitListeners(response, controller.signal);
  } finally {
    // Also release the historical implementation if this regression fails.
    response.emit('close');
    await pending.catch(() => {});
  }
});

test('normal drain completes a blocked CLI write and removes all alternate completion listeners', async () => {
  const response = new MockResponse(false), controller = new AbortController();
  const pending = writeCliBytes(response, Buffer.from('synthetic drain fixture'), controller.signal);
  assert.equal(response.listenerCount('drain'), 1);
  assert.equal(response.listenerCount('close'), 1);
  response.emit('drain');
  await pending;
  noWaitListeners(response, controller.signal);
  controller.abort();
  noWaitListeners(response, controller.signal);
});

test('socket close rejects a blocked CLI write and removes drain and abort listeners', async () => {
  const response = new MockResponse(false), controller = new AbortController();
  const pending = writeCliBytes(response, Buffer.from('synthetic close fixture'), controller.signal);
  void pending.catch(() => {});
  response.destroyed = true;
  response.emit('close');
  await assert.rejects(pending);
  noWaitListeners(response, controller.signal);
});

test('already-cancelled CLI writes never enqueue another response chunk', async () => {
  const response = new MockResponse(false), controller = new AbortController();
  controller.abort();
  await assert.rejects(writeCliBytes(response, Buffer.from('must not be written'), controller.signal), { code: 'request_cancelled', status: 499 });
  assert.equal(response.writes.length, 0);
  noWaitListeners(response, controller.signal);
});
