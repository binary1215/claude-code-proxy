import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UsageObserver } from '../dist/services/usageObserver.js';

test('observer accepts multiline SSE data, CR-only delimiters and cumulative usage across byte cuts', () => {
  const observer = new UsageObserver(true);
  const stream = Buffer.from(
    ': comment\r\r' +
    'event: message_start\rdata: {"type":"message_start",\r' +
    'data: "message":{"content":[{"type":"text","text":"한글🙂"}],"usage":{"input_tokens":0,"output_tokens":0}}}\r\r' +
    'event: message_delta\rdata: {"type":"message_delta","usage":{"output_tokens":2}}\r\r' +
    'event: message_delta\rdata: {"type":"message_delta","usage":{"output_tokens":7}}\r\r' +
    'event: message_stop\rdata: {"type":"message_stop"}\r\r');
  for (let offset = 0; offset < stream.length; offset++) observer.write(stream.subarray(offset, offset + 1));
  observer.end();
  assert.equal(observer.canObserve, true);
  assert.equal(observer.streamComplete, true);
  const usage = observer.snapshot();
  assert.equal(usage.usageComplete, true);
  assert.equal(usage.inputTokens, 0);
  assert.equal(usage.outputTokens, 7); // cumulative, not 2 + 7
  assert.equal(usage.cacheReadInputTokens, null);
});

test('observer leaves invalid/unreported counters unknown and cannot fabricate terminal state', () => {
  const observer = new UsageObserver(true);
  observer.write(Buffer.from('data: {"type":"message_start","message":{"usage":{"input_tokens":-1,"output_tokens":"7"}}}\n\n'));
  observer.write(Buffer.from('data: {"type":"content_block_delta","delta":{"text":"message_stop"}}\n\n'));
  observer.end();
  assert.equal(observer.streamComplete, false);
  assert.equal(observer.snapshot().usageComplete, false);
  assert.equal(observer.snapshot().inputTokens, null);
  assert.equal(observer.snapshot().outputTokens, null);
});

test('usage observer bounds events consisting only of empty data lines', () => {
  const observer = new UsageObserver(true);
  observer.write(Buffer.from('data:\n'.repeat(1024 * 1024 + 1)));
  observer.write(Buffer.from('\ndata: {"type":"message_stop"}\n\n'));
  observer.end();
  assert.equal(observer.canObserve, false);
  assert.equal(observer.snapshot().usageComplete, false);
});
