import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { ResponsesStateCodec, upstreamStateScope } from '../dist/services/responsesState.js';

const key = randomBytes(32).toString('base64');
const context = { model: 'synthetic-model', principal: 'proxy-key:1', upstream: upstreamStateScope('http://127.0.0.1:1', {kind:'api_key',token:'local-fixture-only'}) };
const block = {type:'thinking',thinking:'한글🙂',signature:'split+signature/=',cache_control:{type:'ephemeral',ttl:'1h'}};

// Produce the previously deployed format independently of the new writer.
function legacySeal(value, bound, itemId, issued = Math.floor(Date.now() / 1000)) {
  const fields = ['claude-proxy-responses-v1', bound.model, bound.principal, bound.upstream, itemId];
  if (bound.instructionScope !== undefined) fields.push('developer-hoist-v1', bound.instructionScope);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'base64'), iv);
  cipher.setAAD(Buffer.from(JSON.stringify(fields)));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify({ v: 1, issued, block: value })), cipher.final()]);
  return 'ccpr1.' + Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}

test('AEAD reasoning capsules preserve complete signed-empty/redacted blocks and survive restart with same key', () => {
  const codec = new ResponsesStateCodec(key, 600);
  for (const value of [block, {...block,thinking:''}, {type:'redacted_thinking',data:'opaque+/='}]) {
    const sealed = codec.seal(value,context,'rs_one');
    assert(sealed.startsWith('ccpr2.'));
    assert(!sealed.includes(value.signature || value.data));
    assert.deepEqual(new ResponsesStateCodec(key,600).open(sealed,context,'rs_one'),{ itemId: 'rs_one', block: value });
    assert.deepEqual(new ResponsesStateCodec(key,600).open(sealed,context),{ itemId: 'rs_one', block: value });
    assert.notEqual(sealed,codec.seal(value,context,'rs_one'));
  }
});
test('capsules reject mutation, foreign formats, model/key/account/base/item changes and rotation', () => {
  const codec = new ResponsesStateCodec(key,600);
  const sealed = codec.seal(block,context,'rs_one');
  for (const altered of [sealed.slice(0,-6)+'ABCDEF', sealed+'=', '[]', '', 'ccpr1.**', sealed.replace('ccpr2.', 'ccpr1.')]) {
    assert.throws(()=>codec.open(altered,context,'rs_one'),{code:'invalid_reasoning_state'});
  }
  for (const scope of [{...context,model:'another'}, {...context,principal:'proxy-key:2'}, {...context,upstream:'another'}]) {
    assert.throws(()=>codec.open(sealed,scope,'rs_one'),{code:'invalid_reasoning_state'});
    assert.throws(()=>codec.open(sealed,scope),{code:'invalid_reasoning_state'});
  }
  assert.throws(()=>codec.open(sealed,context,'rs_other'),{code:'invalid_reasoning_state'});
  assert.throws(()=>new ResponsesStateCodec(randomBytes(32).toString('base64'),600).open(sealed,context,'rs_one'),{code:'invalid_reasoning_state'});
  assert.notEqual(context.upstream,upstreamStateScope('http://127.0.0.1:1',{kind:'api_key',token:'rotated-fixture'}));
});
test('expiry, future timestamps and bounds fail closed without revealing plaintext', () => {
  let now = 1000000;
  const codec = new ResponsesStateCodec(key,60,()=>now);
  const sealed = codec.seal(block,context,'rs_one');
  now += 61000;
  assert.throws(()=>codec.open(sealed,context,'rs_one'), error => error.code==='invalid_reasoning_state' && !error.message.includes(block.signature));
  now = 800000;
  assert.throws(()=>codec.open(sealed,context,'rs_one'),{code:'invalid_reasoning_state'});
  assert.throws(()=>codec.seal({...block,signature:''},context,'rs_one'));
  assert.throws(()=>codec.seal({...block,thinking:'x'.repeat(1024*1024)},context,'rs_one'),{code:'reasoning_state_too_large'});
  assert.throws(()=>codec.open('ccpr1.'+'A'.repeat(2*1024*1024),context,'rs_one'));
  assert.throws(()=>new ResponsesStateCodec('not-a-key',600));
  assert.throws(()=>new ResponsesStateCodec(key,0));
});

test('ID-less v2 replay keeps instruction scope and the existing ID and TTL bounds', () => {
  let now = 1000000;
  const codec = new ResponsesStateCodec(key, 60, () => now);
  const hoisted = { ...context, instructionScope: 'a'.repeat(64) };
  const id = 'x'.repeat(256);
  const sealed = codec.seal(block, hoisted, id);
  assert.deepEqual(codec.open(sealed, hoisted), { itemId: id, block });
  for (const bound of [context, { ...hoisted, instructionScope: 'b'.repeat(64) }]) {
    assert.throws(() => codec.open(sealed, bound), { code: 'invalid_reasoning_state' });
  }
  for (const invalidId of ['', null, 1, 'x'.repeat(257)]) {
    assert.throws(() => codec.seal(block, context, invalidId), { code: 'invalid_reasoning_state' });
    assert.throws(() => codec.open(sealed, hoisted, invalidId), { code: 'invalid_reasoning_state' });
  }
  now += 61000;
  assert.throws(() => codec.open(sealed, hoisted), { code: 'invalid_reasoning_state' });
});

test('legacy v1 capsules retain exact binding and require their external original ID', () => {
  const codec = new ResponsesStateCodec(key, 600);
  const hoisted = { ...context, instructionScope: 'a'.repeat(64) };
  for (const bound of [context, hoisted]) {
    for (const value of [block, { ...block, thinking: '' }, { type: 'redacted_thinking', data: 'opaque+/=' }]) {
      const sealed = legacySeal(value, bound, 'rs_old');
      assert.deepEqual(codec.open(sealed, bound, 'rs_old'), { itemId: 'rs_old', block: value });
      assert.throws(() => codec.open(sealed, bound), error => error.code === 'invalid_reasoning_state' && error.status === 409 && error.message.includes('original item ID'));
      assert.throws(() => codec.open(sealed, bound, 'rs_new'), { code: 'invalid_reasoning_state' });
      assert.throws(() => codec.open(sealed.replace('ccpr1.', 'ccpr2.'), bound, 'rs_old'), { code: 'invalid_reasoning_state' });
      assert.throws(() => codec.open(sealed, { ...bound, upstream: 'changed' }, 'rs_old'), { code: 'invalid_reasoning_state' });
      assert.throws(() => codec.open(sealed, { ...bound, instructionScope: 'b'.repeat(64) }, 'rs_old'), { code: 'invalid_reasoning_state' });
    }
  }
  const clockCodec = new ResponsesStateCodec(key, 60, () => 1000000);
  for (const issued of [900, 1100]) {
    assert.throws(() => clockCodec.open(legacySeal(block, context, 'rs_old', issued), context, 'rs_old'), { code: 'invalid_reasoning_state' });
  }
});
