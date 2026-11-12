import assert from 'node:assert/strict';
import {after,test} from 'node:test';
Object.assign(process.env,{DATABASE_PATH:':memory:',CLAUDE_INFERENCE_BACKEND:'http',UPSTREAM_AUTH_SOURCE:'configured',CLAUDE_AUTH_AUTO_REFRESH:'false'});
const {UsageObserver}=await import('../dist/services/usageObserver.js');
const {cliTurnUsage}=await import('../dist/services/cliUpstream.js');
const {db}=await import('../dist/db/connection.js');
after(()=>db.close());
const success=()=>{
 const observer=new UsageObserver(true);
 observer.write(Buffer.from('data: '+JSON.stringify({type:'message_start',message:{usage:{input_tokens:12,output_tokens:0,cache_read_input_tokens:5,cache_creation_input_tokens:2}}})+'\n\n'));
 observer.write(Buffer.from('data: '+JSON.stringify({type:'message_delta',usage:{output_tokens:8}})+'\n\ndata: {"type":"message_stop"}\n\n'));
 observer.end();return observer;
};
test('successful compaction usage survives a following failed or cancelled inference as a known subtotal',async()=>{
 const usage=await cliTurnUsage({requests:[{kind:'compaction',usage:success(),done:Promise.resolve()},
  {kind:'inference',usage:new UsageObserver(true),done:Promise.resolve()}]});
 assert.equal(usage.inputTokens,12);assert.equal(usage.outputTokens,8);assert.equal(usage.cacheReadInputTokens,5);
 assert.equal(usage.cacheCreationInputTokens,2);assert.equal(usage.cacheCreation1hTokens,null);assert.equal(usage.usageComplete,false);
});
test('turn accounting waits for its own requests and never switches to a subsequent turn array',async()=>{
 let finish;const pending=new Promise(resolve=>{finish=resolve;});
 const original={kind:'inference',usage:new UsageObserver(true),done:pending};const turn={requests:[original]};
 const result=cliTurnUsage(turn);turn.requests=[{kind:'inference',usage:success(),done:Promise.resolve()}];
 original.usage=success();finish();
 const usage=await result;assert.equal(usage.inputTokens,12);assert.equal(usage.outputTokens,8);assert.equal(usage.usageComplete,true);
});
