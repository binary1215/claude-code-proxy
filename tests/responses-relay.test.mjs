import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { after, test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { CODEX_APPLY_PATCH_GRAMMAR } from '../dist/services/responsesPatchGrammar.js';

process.env.DATABASE_PATH = ':memory:';
process.env.AUTH_DISABLED = 'false';
process.env.ADMIN_API_SECRET = randomBytes(24).toString('hex');
process.env.ANTHROPIC_API_KEY = 'sk-ant-api-responses-synthetic-only';
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
process.env.RESPONSES_ENABLED = 'true';
process.env.RESPONSES_STATE_KEY = randomBytes(32).toString('base64');
process.env.RESPONSES_APPLY_PATCH_MODE = 'validated';
process.env.UPSTREAM_TIMEOUT_MS = '800';
const privateText = 'PRIVATE_RESPONSES_REASONING_TOOL_RESULT';
const model = 'fixture-response-model';
const patchText = '*** Begin Patch\n*** Add File: synthetic.txt\n+fixture only\n*** End Patch\n';
const patchTool = {type:'custom',name:'apply_patch',format:{type:'grammar',syntax:'lark',definition:CODEX_APPLY_PATCH_GRAMMAR}};
const content = [
  {type:'thinking',thinking:`한글🙂 ${privateText}`,signature:'fragmented-signature+/='},
  {type:'thinking',thinking:'',signature:'signed-empty+/='},
  {type:'redacted_thinking',data:'redacted-opaque+/='},
  {type:'tool_use',id:'toolu_fixture_01',name:'local_tool',input:{text:privateText}},
];
const usage = {input_tokens:3,output_tokens:9,cache_read_input_tokens:70,cache_creation_input_tokens:20,
  cache_creation:{ephemeral_5m_input_tokens:5,ephemeral_1h_input_tokens:15}};
const issued = (blocks=content, stop='tool_use') => ({id:'msg_local_only',type:'message',role:'assistant',model,content:blocks,stop_reason:stop,stop_sequence:null,usage});
const ev = (type,extra={}) => `event: ${type}\r\ndata: ${JSON.stringify({type,...extra})}\r\n\r\n`;
function wire(message) {
  let result = ev('message_start',{message:{...message,content:[],stop_reason:null,
    ...(Object.hasOwn(message,'stop_details')?{stop_details:null}:{}),usage:{...usage,output_tokens:0}}});
  message.content.forEach((b,index) => {
    const start = b.type==='thinking'?{...b,thinking:'',signature:''}: b.type==='text'?{...b,text:''}: b.type==='tool_use'?{...b,input:{}}:b;
    result+=ev('content_block_start',{index,content_block:start});
    if(b.type==='thinking') {
      result+=ev('content_block_delta',{index,delta:{type:'thinking_delta',thinking:b.thinking}});
      result+=ev('content_block_delta',{index,delta:{type:'signature_delta',signature:b.signature.slice(0,8)}});
      result+=ev('content_block_delta',{index,delta:{type:'signature_delta',signature:b.signature.slice(8)}});
    }
    if(b.type==='tool_use') {
      const args=JSON.stringify(b.input);
      for(const partial_json of [args.slice(0,7),args.slice(7)]) result+=ev('content_block_delta',{index,delta:{type:'input_json_delta',partial_json}});
    }
    if(b.type==='text') result+=ev('content_block_delta',{index,delta:{type:'text_delta',text:b.text}});
    result+=ev('content_block_stop',{index});
  });
  const finalUsage=Object.hasOwn(message,'diagnostics')?{...usage,input_tokens:null,cache_read_input_tokens:null,
    cache_creation_input_tokens:null,server_tool_use:null,output_tokens_details:null}:usage;
  return result+ev('message_delta',{delta:{stop_reason:message.stop_reason,stop_sequence:null,
    ...(Object.hasOwn(message,'stop_details')?{stop_details:message.stop_details}:{}),
    ...(Object.hasOwn(message,'container')?{container:message.container}:{})},usage:finalUsage})+ev('message_stop');
}
const calls=[];
const closed=new Set();
const upstream=http.createServer(async(req,res)=>{
  const chunks=[]; for await(const chunk of req) chunks.push(chunk);
  const body=JSON.parse(Buffer.concat(chunks));
  const scenario=body.messages[0].content[0].text;
  calls.push({headers:req.headers,body,url:req.url,scenario});
  res.on('close',()=>closed.add(scenario));
  res.setHeader('request-id','req_011abcdefghijklmnopqrstuv');
  if(scenario==='no-headers') return;
  if(scenario==='rejected') {res.writeHead(400,{'content-type':'application/json'});res.end('{"type":"error","error":{"type":"invalid_request_error","message":"Invalid synthetic signature"}}');return;}
  if(scenario==='redirect') {res.writeHead(307,{location:'http://127.0.0.1:1/never-follow'});res.end('redirect-not-followed');return;}
  const hasResult=body.messages.some(m=>m.content.some(b=>b.type==='tool_result'));
  let message=hasResult?issued([{type:'text',text:'COMPLETE'}],'end_turn'):issued();
  if(scenario==='history-only-illegal-tool') message=issued();
  if(scenario.startsWith('patch-')&&!hasResult) message=issued([...content.slice(0,3),
    {type:'tool_use',id:'toolu_patch',name:'apply_patch',input:{input:scenario==='patch-valid'?patchText:'PRIVATE_INVALID_PATCH'}}]);
  if(scenario==='model-change') message={...message,model:'unexpected-model'};
  if(scenario==='max-tokens') message=issued([{type:'text',text:'partial'}],'max_tokens');
  if(scenario==='unsupported') message=issued([{type:'future_native_block',value:privateText}],'end_turn');
  if(scenario==='metadata') message={...message,container:null,stop_details:null,
    diagnostics:{cache_miss_reason:{type:'system_changed',cache_missed_input_tokens:19}},
    content:message.content.map(block=>block.type==='tool_use'?{...block,caller:{type:'direct'},toolset_name:null}:
      block.type==='text'?{...block,citations:null}:block)};
  if(scenario==='metadata-refusal') message={...issued([{type:'text',text:privateText}],'refusal'),container:null,
    diagnostics:null,stop_details:{type:'refusal',category:null,explanation:'Synthetic decline.'}};
  if(!body.stream) {
    res.writeHead(200,{'content-type':'application/json'});
    if(scenario==='invalid-utf8') {
      const parts=JSON.stringify(message).split(privateText);
      res.end(Buffer.concat([Buffer.from(parts.shift()),Buffer.from([0xff]),Buffer.from(parts.join(privateText))]));
    } else res.end(JSON.stringify(message));
    return;
  }
  if(scenario==='encoded') {res.writeHead(200,{'content-type':'text/event-stream','content-encoding':'gzip'});res.end(gzipSync(wire(message)));return;}
  res.writeHead(200,{'content-type':'text/event-stream'});
  const start=ev('message_start',{message:{...issued(),content:[],stop_reason:null,usage:{...usage,output_tokens:0}}});
  if(['hold','disconnect','admin-cancel'].includes(scenario)){res.write(start);return;}
  if(scenario==='aborted') {res.write(start);setTimeout(()=>res.destroy(),10);return;}
  if(scenario==='provider-error'){res.end(start+ev('error',{error:{type:'api_error',message:privateText}}));return;}
  if(scenario==='truncated'){res.end(start);return;}
  let bytes=Buffer.from(wire(message));
  if(scenario==='late-invalid') bytes=Buffer.concat([bytes,Buffer.from(ev('future_event',{data:privateText}))]);
  for(let offset=0;offset<bytes.length;offset+=7){if(res.destroyed)break;res.write(bytes.subarray(offset,offset+7));await new Promise(r=>setImmediate(r));}
  res.end();
});
upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
process.env.ANTHROPIC_BASE_URL=`http://127.0.0.1:${upstream.address().port}/v1/`;
const {app}=await import('../dist/app.js');
const {db}=await import('../dist/db/connection.js');
const keys=await import('../dist/services/apiKeyService.js');
const {listTasks}=await import('../dist/services/taskTracker.js');
const key=keys.createApiKey('responses-fixture');
const otherKey=keys.createApiKey('responses-other-principal');
for(const k of [key,otherKey]) keys.updateApiKey(k.id,{rate_limit_rpm:200,allowed_models:JSON.stringify([model,'other-model'])});
db.exec(`CREATE TEMP TABLE responses_completion_audit (request_id INTEGER, status TEXT);
  CREATE TEMP TRIGGER responses_audit_completion AFTER UPDATE OF status ON request_log WHEN NEW.status <> 'pending'
  BEGIN INSERT INTO responses_completion_audit VALUES (NEW.id, NEW.status); END;`);
const server=app.listen(0,'127.0.0.1');await once(server,'listening');
const base=`http://127.0.0.1:${server.address().port}`;
const body=(input='seed',extra={})=>({model,input,store:false,stream:true,tools:[{type:'function',name:'local_tool',strict:false,parameters:{type:'object',properties:{text:{type:'string'}},required:['text']}}],...extra});
function request(payload, credential=key.key, path='/v1/responses', extraHeaders={}) {
  return new Promise((resolve,reject)=>{
    const req=http.request(base+path,{method:'POST',headers:{'content-type':'application/json',...(credential?{authorization:`Bearer ${credential}`} :{}),...extraHeaders}},res=>{
      const parts=[];let ended=false;let settled=false;
      const done=()=>{if(settled)return;settled=true;resolve({status:res.statusCode,body:Buffer.concat(parts).toString(),headers:res.headers,ended});};
      res.on('data',p=>parts.push(p));res.on('end',()=>{ended=true;done();});res.on('error',done);res.on('aborted',done);res.on('close',done);
    });
    req.on('error',reject);req.setTimeout(4000,()=>req.destroy(new Error('Fixture deadline')));req.end(JSON.stringify(payload));
  });
}
const events=r=>r.body.split('\n').filter(l=>l.startsWith('data: ')).map(l=>JSON.parse(l.slice(6)));
const completed=r=>events(r).find(e=>e.type==='response.completed')?.response;
const lastLog=()=>db.prepare('SELECT * FROM request_log ORDER BY id DESC LIMIT 1').get();
async function settled(){for(let n=0;n<100;n++){if(!listTasks().length)return;await new Promise(r=>setTimeout(r,10));}assert.fail('Pending task remained');}
function assertOneFinalization(row){assert.equal(db.prepare('SELECT COUNT(*) AS n FROM responses_completion_audit WHERE request_id=?').get(row.id).n,1);}
after(async()=>{for(const s of [server,upstream]){s.closeAllConnections();await new Promise(resolve=>s.close(resolve));}db.close();});

let seed;
test('HTTP metadata survives both modes and signed tool replay without persistence or retry',async()=>{
  for(const stream of [true,false]) {
    const before=calls.length;
    const first=await request(body('metadata',{stream})); await settled();
    assert.equal(first.status,200);
    const response=stream?completed(first):JSON.parse(first.body);
    assert(response);
    assert.deepEqual(response.anthropic_metadata,{container:null,diagnostics:{cache_miss_reason:{type:'system_changed',cache_missed_input_tokens:19}},
      stop_details:null,stop_reason:'tool_use',stop_sequence:null});
    const second=await request(body([{role:'user',content:'metadata'},...response.output,
      {type:'function_call_output',call_id:'toolu_fixture_01',output:'synthetic result'}],{stream})); await settled();
    assert.equal(second.status,200); assert.equal(calls.length,before+2);
    assert.deepEqual(calls.at(-1).body.messages.find(message=>message.role==='assistant').content,content);
    const row=lastLog(); assert.equal(row.status,'success'); assert.equal(row.cache_read_input_tokens,usage.cache_read_input_tokens);
    assert.equal(row.full_response,null); assert.equal(row.full_prompt,null); assert.equal(row.prompt_preview,null);
  }
});

test('HTTP provider refusal is a structured failed result in both modes, not a retryable 502',async()=>{
  for(const stream of [true,false]) {
    const before=calls.length;
    const result=await request(body('metadata-refusal',{stream})); await settled();
    assert.equal(result.status,200); assert.equal(calls.length,before+1);
    const response=stream?events(result).at(-1).response:JSON.parse(result.body);
    assert.equal(response.status,'failed'); assert.equal(response.error.code,'provider_refusal');
    assert.equal(response.anthropic_metadata.stop_reason,'refusal');
    assert.deepEqual(response.anthropic_metadata.stop_details,{type:'refusal',category:null,explanation:'Synthetic decline.'});
    assert.equal(response.output[0].content[0].text,privateText);
    if(stream) assert(!events(result).some(event=>event.type==='response.completed'||event.type==='response.incomplete'));
    const row=lastLog(); assert.equal(row.status,'error'); assert.equal(row.output_tokens,usage.output_tokens);
    assert.equal(row.full_response,null); assert.equal(row.full_prompt,null); assert.equal(row.prompt_preview,null);
    assertOneFinalization(row);
  }
});

test('actual HTTP streaming adapter preserves all reasoning blocks and seals identical done/completed items',async()=>{
  const response=await request(body(),key.key,'/v1/responses',{'anthropic-beta':'future-beta-local-test','x-api-key':'untrusted-caller-key'});
  assert.equal(response.status,200);assert.equal(response.ended,true);seed=completed(response);assert(seed);
  const parsed=events(response);
  assert.deepEqual(parsed.map(e=>e.sequence_number),parsed.map((_,i)=>i));
  const done=parsed.filter(e=>e.type==='response.output_item.done').map(e=>e.item);
  assert.deepEqual(done,seed.output);
  assert.deepEqual(seed.output.map(i=>i.type),['reasoning','reasoning','reasoning','function_call']);
  for(const item of seed.output.filter(i=>i.type==='reasoning')) assert(item.encrypted_content.startsWith('ccpr1.'));
  assert(!JSON.stringify(seed.output).includes('fragmented-signature'));
  assert.equal(seed.output[3].call_id,content[3].id);
  assert.equal(calls.at(-1).headers.authorization,undefined);
  assert.equal(calls.at(-1).headers['x-api-key'],process.env.ANTHROPIC_API_KEY);
  assert.equal(calls.at(-1).headers['anthropic-beta'],'future-beta-local-test');
  assert.equal(calls.at(-1).url,'/v1/messages');
  assert(!JSON.stringify(calls.at(-1)).includes(key.key));
  await settled();const row=lastLog();assert.equal(row.status,'success');assert.equal(row.usage_complete,1);
  assert.equal(row.input_tokens,3);assert.equal(row.cache_read_input_tokens,70);assert.equal(row.cache_creation_1h_tokens,15);assert.equal(row.total_cost_usd,null);assertOneFinalization(row);
});
const continuation=()=>body([{role:'user',content:'seed'},...structuredClone(seed.output),{type:'function_call_output',call_id:content[3].id,output:privateText}]);
test('returned history replays exact ordered native blocks and repeated continuations keep identical cache-prefix inputs',async()=>{
  const first=await request(continuation());assert.equal(completed(first).output[0].content[0].text,'COMPLETE');
  const sent=structuredClone(calls.at(-1).body);
  assert.deepEqual(sent.messages.find(m=>m.role==='assistant').content,content);
  assert.equal(sent.messages.at(-1).content[0].tool_use_id,content[3].id);
  const second=await request(continuation());assert(completed(second));assert.deepEqual(calls.at(-1).body,sent);
});

test('history-only compaction replays sealed state without adding callable tools; stale upstream calls fail',async()=>{
  for(const stream of [false,true]) {
    const payload=continuation();payload.tools=[];payload.stream=stream;
    payload.input.push({role:'user',content:'Summarize the existing tool round trip.'});
    const before=calls.length;const response=await request(payload);
    assert.equal(response.status,200);assert.equal(calls.length,before+1);
    const result=stream?completed(response):JSON.parse(response.body);assert.equal(result.status,'completed');
    assert.deepEqual(calls.at(-1).body.messages.find(m=>m.role==='assistant').content,content);
    assert.equal(Object.hasOwn(calls.at(-1).body,'tools'),false);
    assert.equal(Object.hasOwn(calls.at(-1).body,'tool_choice'),false);
    const invalid=structuredClone(payload);invalid.input[0].content='history-only-illegal-tool';
    const failed=await request(invalid);assert.equal(calls.length,before+2);
    if(stream) {
      const parsed=events(failed);
      assert.equal(failed.status,200);assert.equal(completed(failed),undefined);
      assert.equal(parsed.at(-1).type,'response.failed');
      assert.equal(parsed.at(-1).response.error.code,'unknown_upstream_tool');
      assert.equal(parsed.some(e=>e.type==='response.output_item.done'&&e.item.type==='function_call'),false);
    } else {
      // Nonstream relay failures deliberately use the sanitized public envelope.
      assert.equal(failed.status,502);assert.equal(JSON.parse(failed.body).error.code,'upstream_error');
    }
    await settled();assert.equal(lastLog().status,'error');assertOneFinalization(lastLog());
  }
});
test('nonstream output uses the same sealed-state replay contract and never claims fabricated prices',async()=>{
  const response=await request(body('seed',{stream:false}));assert.equal(response.status,200);
  const result=JSON.parse(response.body);assert.equal(result.status,'completed');
  assert.deepEqual(result.output.map(i=>i.type),seed.output.map(i=>i.type));
  assert.equal(result.usage.input_tokens,93);assert.equal(result.usage.input_tokens_details.cached_tokens,70);
  const next=continuation();next.input.splice(1,seed.output.length,...result.output);assert(completed(await request(next)));
});

test('nonstream malformed UTF-8 fails instead of replacing bytes inside signed content',async()=>{
  const n=calls.length;const response=await request(body('invalid-utf8',{stream:false}));
  assert.equal(response.status,502);assert.equal(calls.length,n+1);
  assert(!response.body.includes('ccpr1.'));assert(!response.body.includes(privateText));
  await settled();assert.equal(lastLog().status,'error');assert.equal(lastLog().usage_complete,0);assertOneFinalization(lastLog());
});
test('tampered, missing, foreign principal/model/credential state is rejected before upstream contact',async()=>{
  const n=calls.length;
  const tampered=continuation();tampered.input[1].encrypted_content+='x';assert.equal((await request(tampered)).status,409);
  const missing=continuation();delete missing.input[1].encrypted_content;assert.equal((await request(missing)).status,400);
  assert.equal((await request(continuation(),otherKey.key)).status,409);
  const different=continuation();different.model='other-model';assert.equal((await request(different)).status,409);
  const original=process.env.ANTHROPIC_API_KEY;process.env.ANTHROPIC_API_KEY='sk-ant-api-rotated-synthetic-only';
  try{assert.equal((await request(continuation())).status,409);}finally{process.env.ANTHROPIC_API_KEY=original;}
  assert.equal(calls.length,n);
});
test('auth, model ACL, unsupported state/features and query parameters fail before upstream contact',async()=>{
  const n=calls.length;
  assert.equal((await request(body(),null)).status,401);
  assert.equal((await request(body('seed',{model:'not-allowed'}))).status,403);
  for(const extra of [{previous_response_id:'resp_old'},{store:true},{background:true},{tools:[{type:'web_search'}]}]) assert.equal((await request(body('seed',extra))).status,400);
  assert.equal((await request(body(),key.key,'/v1/responses?unknown=1')).status,400);
  assert.equal((await request(body(),key.key,'/v1/responses/compact')).status,404);
  assert.equal(calls.length,n);
});
test('explicit request-native cache/thinking header works without global TTL settings or forwarding the header',async()=>{
  const options={cache_control:{type:'ephemeral',ttl:'1h'},thinking:{type:'adaptive'},output_config:{effort:'high'}};
  const response=await request(body('seed',{reasoning:{effort:'high'}}),key.key,'/v1/responses',{'x-claude-proxy-native-options':JSON.stringify(options)});
  assert(completed(response));
  assert.deepEqual(calls.at(-1).body.cache_control,options.cache_control);assert.deepEqual(calls.at(-1).body.thinking,options.thinking);
  assert.deepEqual(calls.at(-1).body.output_config,options.output_config);
  assert.equal(calls.at(-1).headers['x-claude-proxy-native-options'],undefined);
  const n=calls.length;
  for(const header of ['broken',JSON.stringify({unknown:true}),JSON.stringify({cache_control:{type:'ephemeral',ttl:'2h'}}),'x'.repeat(4097)]){
    assert.equal((await request(body(),key.key,'/v1/responses',{'x-claude-proxy-native-options':header})).status,400);
  }
  assert.equal((await request(body('seed',{anthropic:options}),key.key,'/v1/responses',{'x-claude-proxy-native-options':JSON.stringify(options)})).status,400);
  assert.equal(calls.length,n);
});
test('HTTP signature rejection and redirect are returned once with no stripping, retry or follow',async()=>{
  for(const scenario of ['rejected','redirect']){
    const n=calls.length;const response=await request(body(scenario));
    assert.equal(response.status,scenario==='rejected'?400:307);assert.equal(calls.length,n+1);
    assert(response.body.includes(scenario==='rejected'?'Invalid synthetic signature':'redirect-not-followed'));
    await settled();assert.equal(lastLog().status,'error');assertOneFinalization(lastLog());
  }
});
test('max_tokens is incomplete, never a fabricated successful completed terminal',async()=>{
  const response=await request(body('max-tokens'));const parsed=events(response);
  assert(!parsed.some(e=>e.type==='response.completed'));assert(parsed.some(e=>e.type==='response.incomplete'));
});
test('malformed, unsupported, truncated, encoded, changed-model and upstream-error streams never claim completion',async()=>{
  for(const scenario of ['provider-error','truncated','unsupported','encoded','model-change','late-invalid','aborted']){
    const n=calls.length;const response=await request(body(scenario));
    assert(!response.body.includes('"type":"response.completed"'),scenario);
    assert.equal(calls.length,n+1);await settled();assert.equal(lastLog().status,'error',scenario);assert.equal(lastLog().usage_complete,0);assertOneFinalization(lastLog());
    if(scenario==='provider-error')assert(!response.body.includes(privateText));
  }
});
test('deadlines close owned upstream work before or after streaming headers exactly once',async()=>{
  for(const scenario of ['no-headers','hold']){
    const n=calls.length;const response=await request(body(scenario));
    assert(!response.body.includes('"type":"response.completed"'));if(scenario==='no-headers')assert.equal(response.status,502);
    await settled();assert.equal(calls.length,n+1);assert.equal(lastLog().status,'error');assert.equal(lastLog().upstream_diagnostic,'timeout');assertOneFinalization(lastLog());
  }
});
test('downstream disconnect cancels the upstream without leaving a pending request',async()=>{
  await new Promise((resolve,reject)=>{
    const req=http.request(base+'/v1/responses',{method:'POST',headers:{authorization:`Bearer ${key.key}`,'content-type':'application/json'}},res=>{
      res.once('data',()=>{res.destroy();resolve();});res.on('error',()=>{});
    });req.on('error',reject);req.end(JSON.stringify(body('disconnect')));
  });
  await settled();assert.equal(lastLog().status,'cancelled');assertOneFinalization(lastLog());
});

test('authenticated admin cancellation closes Responses upstream and finalizes once',async()=>{
  let opened;
  const received=new Promise(resolve=>{opened=resolve;});
  const streamDone=new Promise((resolve,reject)=>{
    const req=http.request(base+'/v1/responses',{method:'POST',headers:{authorization:`Bearer ${key.key}`,'content-type':'application/json'}},res=>{
      res.once('data',opened);res.on('data',()=>{});res.on('error',()=>{});res.on('close',resolve);
    });req.on('error',reject);req.end(JSON.stringify(body('admin-cancel')));
  });
  await received;const task=listTasks()[0];assert(task);
  const response=await request({},process.env.ADMIN_API_SECRET,`/api/admin/tasks/${encodeURIComponent(task.id)}/cancel`);
  assert.equal(response.status,200);await streamDone;await settled();
  for(let n=0;n<100&&!closed.has('admin-cancel');n++)await new Promise(r=>setTimeout(r,10));
  assert(closed.has('admin-cancel'));assert.equal(lastLog().status,'cancelled');
  assert.equal(lastLog().upstream_diagnostic,'cancelled');assertOneFinalization(lastLog());
});
test('history never persists plaintext, tool arguments, signatures or encrypted capsules',async()=>{
  await settled();const rows=db.prepare('SELECT * FROM request_log').all();
  for(const row of rows){assert.equal(row.full_prompt,null);assert.equal(row.full_response,null);assert.equal(row.prompt_preview,null);assert.notEqual(row.status,'pending');}
  const serialized=JSON.stringify(rows);for(const value of [privateText,'signed-empty','ccpr1.',key.key])assert(!serialized.includes(value));
});

test('validated apply_patch HTTP stream/nonstream and signed replay succeed; invalid patch never becomes executable',async()=>{
  for(const stream of [true,false]) {
    const payload=body('patch-valid',{stream,tools:[patchTool]});
    const response=await request(payload);assert.equal(response.status,200);
    const result=stream?completed(response):JSON.parse(response.body);
    const tool=result.output.at(-1);assert.equal(tool.type,'custom_tool_call');assert.equal(tool.input,patchText);
    const replay=await request({...payload,input:[{role:'user',content:'patch-valid'},...result.output,
      {type:'custom_tool_call_output',call_id:'toolu_patch',output:'synthetic tool result'}]});
    assert.equal(replay.status,200);
    assert.deepEqual(calls.at(-1).body.messages[1].content,[...content.slice(0,3),
      {type:'tool_use',id:'toolu_patch',name:'apply_patch',input:{input:patchText}}]);
    await settled();assert.equal(lastLog().status,'success');assertOneFinalization(lastLog());

    const n=calls.length;const bad=await request({...payload,input:'patch-invalid'});
    assert.equal(calls.length,n+1);assert(!bad.body.includes('PRIVATE_INVALID_PATCH'));
    assert(!bad.body.includes('"type":"response.completed"'));
    if(stream) {
      const parsed=events(bad);assert.equal(parsed.at(-1).response.error.code,'invalid_tool_grammar');
      assert(!parsed.some(e=>e.type.startsWith('response.custom_tool_call_input.')));
      assert(!parsed.some(e=>e.type==='response.output_item.done'&&e.item.type==='custom_tool_call'));
    } else assert.equal(bad.status,502);
    await settled();assert.equal(lastLog().status,'error');assertOneFinalization(lastLog());
  }
  const n=calls.length;
  assert.equal((await request(body('patch-valid',{tools:[{...patchTool,format:{...patchTool.format,definition:CODEX_APPLY_PATCH_GRAMMAR+' '}}]}))).status,400);
  assert.equal(calls.length,n);
  const rows=db.prepare('SELECT * FROM request_log').all();
  for(const value of [patchText,'PRIVATE_INVALID_PATCH','ccpr1.']) assert(!JSON.stringify(rows).includes(value));
});
