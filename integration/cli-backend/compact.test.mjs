import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, resolve, join, sep } from 'node:path';
import { after, test } from 'node:test';

// Real pinned SDK/CLI, fake loopback model only. Exercise compact hooks,
// multiple internal calls, accounting, and continuation after a real boundary.
const directory=mkdtempSync(join(tmpdir(),'claude-cli-compact-'));
const calls=[];
let phase='normal';
let activeSession;
const sse=(type,body={})=>`event: ${type}\ndata: ${JSON.stringify({type,...body})}\n\n`;
const provider=http.createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const body=chunks.length?JSON.parse(Buffer.concat(chunks)):{};
  if(req.url.startsWith('/v1/models'))return res.end(JSON.stringify({data:[{type:'model',id:'claude-haiku-5-5'}],has_more:false}));
  if(req.url.includes('count_tokens'))return res.end(JSON.stringify({input_tokens:phase==='auto'?950000:5000}));
  const compacting=activeSession?.upstream.compacting===true;
  calls.push({phase,body,compacting});
  const text=phase==='compact'||compacting?'# Summary\nThe retained target is TARGET_OPAL_482. Preserve it for follow-up.':phase==='after'||phase==='auto'?'AFTER_COMPACT_OK':'BEFORE_COMPACT_OK';
  // Keep the un-compacted main context near its limit through enough completed
  // rounds to age an older round out of the CLI's protected recent segment.
  // Compaction and its following shortened main context have small real usage.
  const usage={input_tokens:phase==='overflow'&&!compacting&&!(activeSession?.compactions>0)?950000:5,output_tokens:9,cache_read_input_tokens:11,cache_creation_input_tokens:3,
    cache_creation:{ephemeral_5m_input_tokens:3,ephemeral_1h_input_tokens:0}};
  res.writeHead(200,{'content-type':'text/event-stream'});
  res.end(sse('message_start',{message:{id:'msg_compact_'+calls.length,type:'message',role:'assistant',model:body.model,content:[],
    stop_reason:null,stop_sequence:null,usage:{...usage,output_tokens:0}}})+
    sse('content_block_start',{index:0,content_block:{type:'text',text:''}})+
    sse('content_block_delta',{index:0,delta:{type:'text_delta',text}})+sse('content_block_stop',{index:0})+
    sse('message_delta',{delta:{stop_reason:'end_turn',stop_sequence:null},usage})+sse('message_stop'));
});
provider.listen(0,'127.0.0.1');await once(provider,'listening');
Object.assign(process.env,{DATABASE_PATH:':memory:',UPSTREAM_AUTH_SOURCE:'configured',ANTHROPIC_API_KEY:'synthetic-compact-only',
  ANTHROPIC_BASE_URL:`http://127.0.0.1:${provider.address().port}`,CLAUDE_INFERENCE_BACKEND:'cli',CLAUDE_AUTH_AUTO_REFRESH:'false',
  CLAUDE_CLI_RUNTIME_DIR:directory,CLAUDE_CLI_WORKER_PATH:new URL('./worker.mjs',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1'),
  UPSTREAM_TIMEOUT_MS:'20000',RESPONSES_ENABLED:'false'});
process.env.CLAUDE_CLI_AUTO_COMPACT_WINDOW='100000';
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
const {acquireCliSession,closeCliSessions}=await import('../../dist/services/cliSessions.js');
const {db}=await import('../../dist/db/connection.js');
const credential={kind:'api_key',token:process.env.ANTHROPIC_API_KEY};
async function turn(body){
  const lease=await acquireCliSession(body,'synthetic-compact-principal',credential);
  const events=[];for await(const event of lease.session.events())events.push(event);
  lease.session.commit(lease.messages);lease.detach();
  return {session:lease.session,message:structuredClone(lease.session.message),events};
}
after(async()=>{
  await closeCliSessions();provider.closeAllConnections();await new Promise(done=>provider.close(done));db.close();
  const target=resolve(directory);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&basename(target).startsWith('claude-cli-compact-'));
  rmSync(target,{recursive:true,force:true,maxRetries:5,retryDelay:200});
});
test('genuine CLI compact boundary accounts all internal calls and its live conversation continues',async()=>{
  const body={model:'claude-haiku-5-5',max_tokens:2048,output_config:{effort:'low'},messages:[{role:'user',content:
    'Remember TARGET_OPAL_482. '+Array.from({length:1800},(_,i)=>`context${i} synthetic-note`).join(' ')}]};
  const first=await turn(body);
  assert.equal(first.message.content[0].text,'BEFORE_COMPACT_OK');
  assert.equal(calls.length,1);
  phase='compact';const before=calls.length;
  const compact=await first.session.compact('Retain TARGET_OPAL_482 and summarize the completed conversation.');
  const actual=calls.length-before;
  assert.equal(compact.compacted,true,'Success alone is not proof compaction ran');
  assert.equal(compact.metadata.trigger,'manual');assert.ok(actual>=1);
  assert.equal(compact.providerCalls,actual);
  assert.equal(compact.usage.inputTokens,actual*5);assert.equal(compact.usage.outputTokens,actual*9);
  assert.equal(compact.usage.cacheReadInputTokens,actual*11);assert.equal(compact.usage.cacheCreationInputTokens,actual*3);
  assert.equal(compact.usage.usageComplete,true);
  assert.ok(calls.slice(before).every(call=>call.body.model===body.model));
  phase='after';
  const next=await turn({...body,messages:[...body.messages,{role:'assistant',content:first.message.content},
    {role:'user',content:'Continue from the retained target.'}]});
  assert.equal(next.session,first.session,'The internal compact must retain the live caller history index');
  assert.equal(next.message.content[0].text,'AFTER_COMPACT_OK');
  assert.ok(JSON.stringify(calls.at(-1).body.messages).includes('The retained target is TARGET_OPAL_482'));
  assert.equal(next.message.usage.input_tokens,5,'Prior compaction counters must not be charged again');
  assert.equal(next.message.usage.output_tokens,9);
});

test('automatic CLI compaction preserves wire context usage while accounting its internal model calls',async(t)=>{
  phase='overflow';
  const body={model:'claude-haiku-5-5',max_tokens:2048,output_config:{effort:'low'},messages:[{role:'user',content:
    'AUTO_COMPACT_USAGE_FIXTURE: Remember TARGET_OPAL_482 and return BEFORE_COMPACT_OK. '+('synthetic context '.repeat(50000))}]};
  const first=await turn(body);activeSession=first.session;
  assert.equal(first.message.usage.input_tokens,950000);
  // The first oversized input and the most recent completed exchange are
  // protected. An attempted auto-compact can legitimately emit failed status
  // without a boundary when no older complete round can be summarized yet.
  const warmMessages=[...body.messages,{role:'assistant',content:first.message.content},
    {role:'user',content:'Complete another round before older context becomes eligible for compaction.'}];
  let before=calls.length;
  let next=await turn({...body,messages:warmMessages});
  if(!next.session.compactions){
    phase='auto';before=calls.length;
    next=await turn({...body,messages:[...warmMessages,{role:'assistant',content:next.message.content},
      {role:'user',content:'Continue after any required context compaction.'}]});
  }
  const actual=calls.slice(before);
  assert.ok(next.session.compactions>0,'Reported near-limit context must trigger genuine CLI automatic compaction');
  assert.equal(next.session.lastCompaction.trigger,'auto');
  assert.ok(actual.some(call=>call.compacting));
  assert.equal(actual.filter(call=>!call.compacting).length,1);
  assert.equal(next.message.usage.input_tokens,5,'Client context size must exclude compaction input');
  assert.equal(next.session.turnUsage.inputTokens,actual.length*5,'Admin accounting includes every actual internal call');
  assert.equal(next.session.turnUsage.outputTokens,actual.length*9);
  assert.equal(next.session.turnUsage.cacheReadInputTokens,actual.length*11);
  t.diagnostic(`Observed auto boundary: ${actual.filter(call=>call.compacting).length} compaction requests + 1 inference; wire input 5, admin turn input ${next.session.turnUsage.inputTokens}.`);
});
