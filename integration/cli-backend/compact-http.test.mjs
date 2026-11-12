import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, resolve, join, sep } from 'node:path';
import { after, test } from 'node:test';

// Real SDK and HTTP facade, scripted local provider. No account/model charges.
const runtime=mkdtempSync(join(tmpdir(),'claude-compact-http-'));
const calls=[], model='claude-opus-5-5', target='PROJECT_COPPER_731';
let phase='compact';
const emit=(type,extra={})=>`event: ${type}\ndata: ${JSON.stringify({type,...extra})}\n\n`;
const nativeUsage={input_tokens:17,output_tokens:13,cache_read_input_tokens:7,cache_creation_input_tokens:3};
const provider=http.createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const body=chunks.length?JSON.parse(Buffer.concat(chunks)):{};
  if(req.url.includes('/models'))return res.end(JSON.stringify({data:[{id:model,type:'model'}],has_more:false}));
  if(req.url.includes('count_tokens'))return res.end('{"input_tokens":5000}');
  calls.push({body,phase});
  if(phase==='failure'){
    res.writeHead(429,{'content-type':'application/json'});
    return res.end(JSON.stringify({type:'error',error:{type:'rate_limit_error',message:'Scripted compact rejection.'}}));
  }
  const text=phase==='compact'?`# Summary\nThe retained project fact is ${target}. Prior investigation is complete.`:'CONTINUED_FROM_COMPACT';
  res.writeHead(200,{'content-type':'text/event-stream'});
  res.end(emit('message_start',{message:{id:'msg_fixture_'+calls.length,type:'message',role:'assistant',model,content:[],stop_reason:null,
    stop_sequence:null,usage:{...nativeUsage,output_tokens:0}}})+
    emit('content_block_start',{index:0,content_block:{type:'text',text:''}})+
    emit('content_block_delta',{index:0,delta:{type:'text_delta',text}})+emit('content_block_stop',{index:0})+
    emit('message_delta',{delta:{stop_reason:'end_turn',stop_sequence:null},usage:nativeUsage})+emit('message_stop'));
});
provider.listen(0,'127.0.0.1');await once(provider,'listening');
Object.assign(process.env,{DATABASE_PATH:':memory:',AUTH_DISABLED:'false',ADMIN_API_SECRET:randomBytes(24).toString('hex'),
  UPSTREAM_AUTH_SOURCE:'configured',ANTHROPIC_API_KEY:'synthetic-compact-http',
  ANTHROPIC_BASE_URL:`http://127.0.0.1:${provider.address().port}`,CLAUDE_INFERENCE_BACKEND:'cli',CLAUDE_AUTH_AUTO_REFRESH:'false',
  CLAUDE_CLI_RUNTIME_DIR:runtime,CLAUDE_CLI_WORKER_PATH:new URL('./worker.mjs',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1'),
  UPSTREAM_TIMEOUT_MS:'30000',RESPONSES_ENABLED:'true',RESPONSES_STATE_KEY:randomBytes(32).toString('base64'),RESPONSES_DEVELOPER_MESSAGE_MODE:'hoist'});
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
const {app}=await import('../../dist/app.js');
const {db}=await import('../../dist/db/connection.js');
const {createApiKey,updateApiKey}=await import('../../dist/services/apiKeyService.js');
const {closeCliSessions,cliSessionCount}=await import('../../dist/services/cliSessions.js');
const {listTasks}=await import('../../dist/services/taskTracker.js');
const key=createApiKey('compact-http');updateApiKey(key.id,{allowed_models:JSON.stringify([model]),rate_limit_rpm:200});
const other=createApiKey('compact-other');updateApiKey(other.id,{rate_limit_rpm:200});
const server=app.listen(0,'127.0.0.1');await once(server,'listening');
const base=`http://127.0.0.1:${server.address().port}`;
async function post(path,body,credential=key.key){
  const response=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json',...(credential?{authorization:`Bearer ${credential}`}:{})},body:JSON.stringify(body)});
  return {status:response.status,headers:response.headers,value:await response.json()};
}
const instruction={type:'message',role:'developer',content:[{type:'input_text',text:'Preserve exact project facts.'}]};
const input=[instruction,...Array.from({length:8},(_,i)=>[
  {role:'user',content:`ARCHIVE_${i} ${target} `+('past completed research '.repeat(1000))},
  {role:'assistant',content:[{type:'output_text',text:`Completed investigation ${i}.`}]},
]).flat()];
const body={model,instructions:'Continue the project faithfully.',input};
let compacted,continued;
after(async()=>{
  await closeCliSessions();
  for(const instance of[server,provider]){instance.closeAllConnections();await new Promise(done=>instance.close(done));}
  db.close();const target=resolve(runtime);
  assert.ok(target.startsWith(resolve(tmpdir())+sep)&&basename(target).startsWith('claude-compact-http-'));
  rmSync(target,{recursive:true,force:true,maxRetries:5,retryDelay:200});
});

test('compact HTTP performs only genuine summarization and returns canonical stateless state with actual usage',async()=>{
  const before=calls.length;const response=await post('/v1/responses/compact',body);
  assert.equal(response.status,200,JSON.stringify(response.value));compacted=response.value;
  assert.equal(compacted.object,'response.compaction');assert.ok(compacted.id);assert.ok(compacted.created_at);
  assert.deepEqual(compacted.output[0],instruction);
  assert.equal(compacted.output[1].type,'compaction');assert.ok(compacted.output[1].encrypted_content.startsWith('ccpc1.'));
  assert.equal(cliSessionCount(),0);assert.deepEqual(listTasks(),[]);
  const actual=calls.length-before;assert.ok(actual>=1);
  assert.ok(calls.slice(before).every(call=>/summary|summariz/i.test(JSON.stringify(call.body))));
  assert.deepEqual(compacted.usage,{input_tokens:actual*27,output_tokens:actual*13,total_tokens:actual*40,
    input_tokens_details:{cached_tokens:actual*7,cache_write_tokens:actual*3}});
  const row=db.prepare('SELECT * FROM request_log ORDER BY id DESC LIMIT 1').get();
  assert.equal(row.status,'success');assert.equal(row.input_tokens,actual*17);assert.equal(row.output_tokens,actual*13);
  assert.equal(row.cache_read_input_tokens,actual*7);assert.equal(row.usage_complete,1);
  assert.ok(JSON.stringify(compacted.output).length<JSON.stringify(body.input).length);
});

test('only compact output plus next user restores after all workers close',async()=>{
  await closeCliSessions();phase='continue';const before=calls.length;
  const response=await post('/v1/responses',{model,instructions:body.instructions,input:[...compacted.output,{role:'user',content:'Continue.'}],store:false});
  assert.equal(response.status,200,JSON.stringify(response.value));continued=response.value;
  assert.equal(calls.length,before+1);assert.equal(response.headers.get('x-claude-proxy-cli-history'),'imported');
  const native=JSON.stringify(calls.at(-1).body.messages);
  assert.ok(native.includes(target));assert.equal(native.includes('ARCHIVE_0'),false);
  assert.ok(JSON.stringify(calls.at(-1).body.system).includes('Preserve exact project facts.'));
  assert.equal(continued.status,'completed');
});

test('repeated compact replaces the previous window and still restores cold',async()=>{
  phase='compact';
  const response=await post('/v1/responses/compact',{model,instructions:body.instructions,
    input:[...compacted.output,{role:'user',content:'Continue.'},...continued.output]});
  assert.equal(response.status,200,JSON.stringify(response.value));
  assert.equal(response.value.output.filter(item=>item.type==='compaction').length,1);
  await closeCliSessions();phase='continue';
  const next=await post('/v1/responses',{model,instructions:body.instructions,input:[...response.value.output,{role:'user',content:'Continue again.'}]});
  assert.equal(next.status,200,JSON.stringify(next.value));
  assert.ok(JSON.stringify(calls.at(-1).body.messages).includes(target));
});

test('compact and replay share authentication/model/policy validation without extra provider requests',async()=>{
  const before=calls.length;
  assert.equal((await post('/v1/responses/compact',body,null)).status,401);
  assert.equal((await post('/v1/responses/compact',{...body,model:'unpermitted'})).status,403);
  assert.equal((await post('/v1/responses/compact',{...body,stream:true})).status,400);
  assert.equal((await post('/v1/responses/compact?extra=true',body)).status,400);
  for(const changes of [{instructions:'Changed'},{},]){
    const replay={model,...changes,input:[...compacted.output,{role:'user',content:'Continue.'}]};
    assert.equal((await post('/v1/responses',replay)).status,409);
  }
  assert.equal((await post('/v1/responses',{model,instructions:body.instructions,input:[...compacted.output,{role:'user',content:'Continue.'}]},other.key)).status,409);
  assert.equal(calls.length,before);
});

test('upstream compact rejection retains HTTP status and releases the task and worker',async()=>{
  await closeCliSessions();phase='failure';const before=calls.length;
  const response=await post('/v1/responses/compact',body);
  assert.equal(response.status,429,JSON.stringify(response.value));
  assert.equal(response.value.error.type,'rate_limit_error');assert.ok(calls.length>before);
  assert.equal(cliSessionCount(),0);assert.deepEqual(listTasks(),[]);
  const row=db.prepare('SELECT * FROM request_log ORDER BY id DESC LIMIT 1').get();
  assert.equal(row.status,'error');assert.equal(row.usage_complete,0);
});
