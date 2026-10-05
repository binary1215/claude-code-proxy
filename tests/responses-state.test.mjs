import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { ResponsesStateCodec, upstreamStateScope } from '../dist/services/responsesState.js';

const key = randomBytes(32).toString('base64');
const context = { model: 'synthetic-model', principal: 'proxy-key:1', upstream: upstreamStateScope('http://127.0.0.1:1', {kind:'api_key',token:'local-fixture-only'}) };
const block = {type:'thinking',thinking:'한글🙂',signature:'split+signature/=',cache_control:{type:'ephemeral',ttl:'1h'}};

test('AEAD reasoning capsules preserve complete signed-empty/redacted blocks and survive restart with same key', () => {
  const codec = new ResponsesStateCodec(key, 600);
  for (const value of [block, {...block,thinking:''}, {type:'redacted_thinking',data:'opaque+/='}]) {
    const sealed = codec.seal(value,context,'rs_one');
    assert(!sealed.includes(value.signature || value.data));
    assert.deepEqual(new ResponsesStateCodec(key,600).open(sealed,context,'rs_one'),value);
    assert.notEqual(sealed,codec.seal(value,context,'rs_one'));
  }
});
test('capsules reject mutation, foreign formats, model/key/account/base/item changes and rotation', () => {
  const codec = new ResponsesStateCodec(key,600);
  const sealed = codec.seal(block,context,'rs_one');
  for (const altered of [sealed.slice(0,-6)+'ABCDEF', sealed+'=', '[]', '', 'ccpr1.**']) {
    assert.throws(()=>codec.open(altered,context,'rs_one'),{code:'invalid_reasoning_state'});
  }
  for (const scope of [{...context,model:'another'}, {...context,principal:'proxy-key:2'}, {...context,upstream:'another'}]) {
    assert.throws(()=>codec.open(sealed,scope,'rs_one'),{code:'invalid_reasoning_state'});
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
