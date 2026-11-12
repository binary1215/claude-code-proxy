import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { after, test } from 'node:test';

// Genuine pinned SDK/CLI against a scripted loopback provider. No provider
// account, production credential, project mount or network model call is used.
const runtime=mkdtempSync(join(tmpdir(),'claude-cli-http-'));
const calls=[];
const closedScenarios=new Set();
const failureMessage='PRIVATE_PROVIDER_FAILURE_NOT_FOR_HISTORY';
let validationRejections=0;
const model='claude-haiku-5-5';
const emit=(type,extra={})=>`event: ${type}\ndata: ${JSON.stringify({type,...extra})}\n\n`;
const upstream=http.createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const body=chunks.length?JSON.parse(Buffer.concat(chunks)):{};
  if(req.url.startsWith('/v1/models'))return res.end(JSON.stringify({data:[{id:model,type:'model',display_name:model}],has_more:false}));
  if(req.url.startsWith('/v1/messages/count_tokens'))return res.end('{"input_tokens":200}');
  calls.push({headers:req.headers,body,path:req.url});
  const contents=(body.messages??[]).flatMap(m=>Array.isArray(m.content)?m.content:[{type:'text',text:m.content}]);
  const hasResult=contents.some(b=>b.type==='tool_result');
  const wantsTool=contents.some(b=>b.type==='text'&&b.text?.includes('REQUEST_CALLER_TOOL'));
  const wantsParallel=contents.some(b=>b.type==='text'&&b.text?.includes('REQUEST_CALLER_TOOL_PARALLEL'));
  const wantsSigned=contents.some(b=>b.type==='text'&&b.text?.includes('RESPONSES_SIGNED'));
  const wantsResponsesTool=contents.some(b=>b.type==='text'&&b.text?.includes('REQUEST_CALLER_TOOL_RESPONSES'));
  const failure=contents.some(b=>b.type==='text'&&b.text?.includes('REQUEST_PROVIDER_FAILURE'));
  const hold=contents.some(b=>b.type==='text'&&b.text?.includes('REQUEST_PROVIDER_HOLD'));
  if(failure){
    calls.at(-1).scenario='failure';
    res.writeHead(429,{'content-type':'application/json','request-id':'req_011abcdefghijklmnopqrstuv','retry-after':'7'});
    return res.end(JSON.stringify({type:'error',error:{type:'rate_limit_error',message:failureMessage}}));
  }
  if(hold)calls.at(-1).scenario='hold';
  let blocks;
  if(wantsTool&&!hasResult){
    const tool=body.tools.find(t=>t.name.startsWith('mcp__caller__'));
    assert.ok(tool,'Caller MCP tool must be declared by the real CLI');
    blocks=[{type:'thinking',thinking:'Synthetic signed thought',signature:'synthetic-provider-signature'},
      ...Array.from({length:wantsParallel?2:1},(_,index)=>({type:'tool_use',id:`toolu_real_cli_fixture_${calls.length}_${index}`,name:tool.name,
        caller:{type:'direct'},toolset_name:null,
        input:{input:wantsResponsesTool?{zeta:7,alpha:'original-order',nested:{zulu:3,alpha:4}}:{value:7}}}))];
  }else blocks=[...(wantsSigned?[
    {type:'thinking',thinking:'',signature:'synthetic-signed-empty'},
    {type:'thinking',thinking:'Synthetic visible reasoning',signature:'synthetic-signed-visible'},
  ]:[]),{type:'text',text:hasResult?'CALLER_RESULT_ACCEPTED':'CLI_HTTP_OK',citations:hasResult?[]:null}];
  const usage={input_tokens:5,output_tokens:9,cache_read_input_tokens:11,cache_creation_input_tokens:3};
  res.writeHead(200,{'content-type':'text/event-stream','request-id':'req_011abcdefghijklmnopqrstuv'});
  res.write(emit('message_start',{message:{id:'msg_real_cli_fixture_'+calls.length,type:'message',role:'assistant',model,
    content:[],stop_reason:null,stop_sequence:null,context_management:null,usage:{...usage,output_tokens:0}}}));
  if(hold){res.on('close',()=>closedScenarios.add('hold'));return;}
  blocks.forEach((b,index)=>{
    const start=b.type==='thinking'?{...b,thinking:'',signature:''}:b.type==='tool_use'?{...b,input:{}}:{...b,text:''};
    res.write(emit('content_block_start',{index,content_block:start}));
    if(b.type==='thinking'){
      res.write(emit('content_block_delta',{index,delta:{type:'thinking_delta',thinking:b.thinking}}));
      res.write(emit('content_block_delta',{index,delta:{type:'signature_delta',signature:b.signature}}));
    }else if(b.type==='tool_use')res.write(emit('content_block_delta',{index,delta:{type:'input_json_delta',partial_json:JSON.stringify(b.input)}}));
    else res.write(emit('content_block_delta',{index,delta:{type:'text_delta',text:b.text}}));
    res.write(emit('content_block_stop',{index}));
  });
  res.end(emit('message_delta',{delta:{stop_reason:blocks.at(-1).type==='tool_use'?'tool_use':'end_turn',stop_sequence:null},usage,context_management:null})+emit('message_stop'));
});
upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
Object.assign(process.env,{DATABASE_PATH:':memory:',AUTH_DISABLED:'false',ADMIN_API_SECRET:randomBytes(24).toString('hex'),
  UPSTREAM_AUTH_SOURCE:'configured',ANTHROPIC_API_KEY:'sk-ant-api-scripted-provider-not-a-real-credential',
  ANTHROPIC_BASE_URL:`http://127.0.0.1:${upstream.address().port}`,CLAUDE_INFERENCE_BACKEND:'cli',
  CLAUDE_CLI_RUNTIME_DIR:runtime,CLAUDE_CLI_WORKER_PATH:new URL('./worker.mjs',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1'),
  UPSTREAM_TIMEOUT_MS:'30000',RESPONSES_ENABLED:'true',RESPONSES_STATE_KEY:randomBytes(32).toString('base64'),
  CLAUDE_AUTH_AUTO_REFRESH:'false'});
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
const {app}=await import('../../dist/app.js');
const {db}=await import('../../dist/db/connection.js');
const {createApiKey,updateApiKey}=await import('../../dist/services/apiKeyService.js');
const {closeCliSessions}=await import('../../dist/services/cliSessions.js');
const key=createApiKey('actual-cli-loopback');updateApiKey(key.id,{rate_limit_rpm:200});
const server=app.listen(0,'127.0.0.1');await once(server,'listening');
const base=`http://127.0.0.1:${server.address().port}`;
async function request(path,body){
  const response=await fetch(base+path,{method:'POST',headers:{authorization:`Bearer ${key.key}`,'content-type':'application/json'},body:JSON.stringify(body)});
  const text=await response.text();
  if(response.headers.get('content-type')?.includes('text/event-stream')){
    const events=text.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>JSON.parse(line.slice(5)));
    return {status:response.status,text,events,value:events.at(-1)?.response};
  }
  return {status:response.status,text,value:JSON.parse(text)};
}
after(async()=>{
  await closeCliSessions();
  for(const value of[server,upstream]){value.closeAllConnections();await new Promise(resolve=>value.close(resolve));}
  db.close();
  // Resolve and check the exact fixture-owned path before recursive cleanup.
  const target=resolve(runtime);
  assert.ok(target.startsWith(resolve(tmpdir())+sep)&&basename(target).startsWith('claude-cli-http-'));
  rmSync(target,{recursive:true,force:true,maxRetries:5,retryDelay:200});
});

test('actual CLI answers native Messages and continues the exact caller history',async()=>{
  const body={model,max_tokens:1024,messages:[{role:'user',content:'Return CLI_HTTP_OK.'}]};
  const first=await request('/v1/messages',body);
  assert.equal(first.status,200,first.text);
  assert.equal(first.value.content.find(b=>b.type==='text').text,'CLI_HTTP_OK');
  assert.equal(calls.length,1);
  assert.equal(calls[0].headers['x-api-key'],process.env.ANTHROPIC_API_KEY);
  assert.equal(calls[0].body.max_tokens,1024);
  const second=await request('/v1/messages',{...body,messages:[...body.messages,{role:'assistant',content:first.value.content},
    {role:'user',content:'Continue and return CLI_HTTP_OK.'}]});
  assert.equal(second.status,200,second.text);
  assert.equal(calls.length,2);
  assert.ok(calls[1].body.messages.some(m=>m.role==='assistant'&&m.content.some(b=>b.type==='text'&&b.text==='CLI_HTTP_OK')));
});

test('independent identical conversations both support concurrent identical continuations',async()=>{
  const body={model,max_tokens:1024,messages:[{role:'user',content:'IDENTICAL_FRESH_CONVERSATION Return CLI_HTTP_OK.'}]};
  const before=calls.length;
  const first=await Promise.all([request('/v1/messages',body),request('/v1/messages',body)]);
  for(const response of first)assert.equal(response.status,200,response.text);
  assert.deepEqual(first[0].value.content,first[1].value.content,'Visible history must collide to exercise the independent-session index');
  assert.equal(calls.length,before+2);
  const continuation={...body,messages:[...body.messages,{role:'assistant',content:first[0].value.content},
    {role:'user',content:'IDENTICAL_CONTINUATION Return CLI_HTTP_OK.'}]};
  const second=await Promise.all([request('/v1/messages',continuation),request('/v1/messages',continuation)]);
  for(const response of second){
    assert.equal(response.status,200,response.text);
    assert.equal(response.value.content.find(b=>b.type==='text').text,'CLI_HTTP_OK');
  }
  assert.equal(calls.length,before+4);
});

test('actual CLI tool intent returns to caller, then exact-id result resumes its own signed history',async()=>{
  const tools=[{name:'caller_only',description:'Caller executes this tool, never the proxy.',input_schema:{type:'object',properties:{value:{type:'integer'}},required:['value'],additionalProperties:false}}];
  const body={model,max_tokens:1024,tools,messages:[{role:'user',content:'REQUEST_CALLER_TOOL'}]};
  const before=calls.length;
  const first=await request('/v1/messages',body);
  assert.equal(first.status,200,first.text);
  assert.equal(first.value.stop_reason,'tool_use');
  const call=first.value.content.find(b=>b.type==='tool_use');
  assert.equal(call.name,'caller_only');assert.deepEqual(call.input,{value:7});
  assert.equal(calls.length,before+1);
  const second=await request('/v1/messages',{...body,messages:[...body.messages,{role:'assistant',content:first.value.content},
    {role:'user',content:[{type:'tool_result',tool_use_id:call.id,content:'CALLER_COMPUTED_42'}]}]});
  assert.equal(second.status,200,second.text);
  assert.equal(calls.length,before+2);
  const history=calls.at(-1).body.messages.flatMap(m=>Array.isArray(m.content)?m.content:[]);
  assert.ok(history.some(b=>b.type==='thinking'&&b.signature==='synthetic-provider-signature'));
  const result=history.find(b=>b.type==='tool_result'&&b.tool_use_id===call.id);
  assert.ok(JSON.stringify(result).includes('CALLER_COMPUTED_42'));
  assert.equal(second.value.content.find(b=>b.type==='text').text,'CALLER_RESULT_ACCEPTED');
});

const callerTools=[{name:'caller_only',description:'Caller executes this tool, never the proxy.',
  input_schema:{type:'object',properties:{value:{type:'integer'}},required:['value'],additionalProperties:false}}];
const providerBlocks=call=>call.body.messages.flatMap(m=>Array.isArray(m.content)?m.content:[]);
async function until(predicate,label){
  for(let n=0;n<200;n++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.fail(label);
}

test('duplicate parallel tool arguments keep native IDs when caller results arrive in reverse order',async()=>{
  const body={model,max_tokens:1024,tools:callerTools,messages:[{role:'user',content:'REQUEST_CALLER_TOOL_PARALLEL'}]};
  const before=calls.length;
  const first=await request('/v1/messages',body);
  assert.equal(first.status,200,first.text);
  const tools=first.value.content.filter(b=>b.type==='tool_use');
  assert.equal(tools.length,2);assert.notEqual(tools[0].id,tools[1].id);
  for(const tool of tools){assert.equal(tool.name,'caller_only');assert.deepEqual(tool.input,{value:7});}
  assert.equal(calls.length,before+1);
  const results=tools.map((tool,index)=>({type:'tool_result',tool_use_id:tool.id,content:`CALLER_RESULT_${index}_FOR_${tool.id}`}));
  const second=await request('/v1/messages',{...body,messages:[...body.messages,{role:'assistant',content:first.value.content},
    {role:'user',content:[...results].reverse()}]});
  assert.equal(second.status,200,second.text);
  assert.equal(calls.length,before+2);
  const history=providerBlocks(calls.at(-1));
  for(const result of results){
    const actual=history.find(block=>block.type==='tool_result'&&block.tool_use_id===result.tool_use_id);
    assert.ok(actual,`Missing result for ${result.tool_use_id}`);
    assert.ok(JSON.stringify(actual).includes(result.content),`Wrong association for ${result.tool_use_id}`);
  }
});

test('actual MCP error result reaches the provider as native is_error',async()=>{
  const body={model,max_tokens:1024,tools:callerTools,messages:[{role:'user',content:'REQUEST_CALLER_TOOL_ERROR'}]};
  const before=calls.length;
  const first=await request('/v1/messages',body);
  assert.equal(first.status,200,first.text);
  const tool=first.value.content.find(b=>b.type==='tool_use');
  const second=await request('/v1/messages',{...body,messages:[...body.messages,{role:'assistant',content:first.value.content},
    {role:'user',content:[{type:'tool_result',tool_use_id:tool.id,is_error:true,content:'CALLER_EXPECTED_ERROR'}]}]});
  assert.equal(second.status,200,second.text);
  assert.equal(calls.length,before+2);
  const result=providerBlocks(calls.at(-1)).find(block=>block.type==='tool_result'&&block.tool_use_id===tool.id);
  assert.equal(result?.is_error,true);
  assert.ok(JSON.stringify(result).includes('CALLER_EXPECTED_ERROR'));
});

test('invalid caller tool result returns400 without consuming the pending valid CLI continuation',async()=>{
  const body={model,max_tokens:1024,tools:callerTools,messages:[{role:'user',content:'REQUEST_CALLER_TOOL_RECOVER_INVALID_RESULT'}]};
  const before=calls.length;
  const first=await request('/v1/messages',body);
  assert.equal(first.status,200,first.text);
  const tool=first.value.content.find(b=>b.type==='tool_use');
  const history=[...body.messages,{role:'assistant',content:first.value.content}];
  const invalid=await request('/v1/messages',{...body,messages:[...history,
    {role:'user',content:[{type:'tool_result',tool_use_id:tool.id+'_wrong',content:'INVALID_SHOULD_NOT_DELIVER'}]}]});
  assert.equal(invalid.status,400,invalid.text);validationRejections++;
  assert.equal(calls.length,before+1);
  const valid=await request('/v1/messages',{...body,messages:[...history,
    {role:'user',content:[{type:'tool_result',tool_use_id:tool.id,content:'CALLER_RECOVERED_VALID_RESULT'}]}]});
  assert.equal(valid.status,200,valid.text);
  assert.equal(calls.length,before+2);
  const providerHistory=providerBlocks(calls.at(-1));
  assert.ok(JSON.stringify(providerHistory).includes('CALLER_RECOVERED_VALID_RESULT'));
  assert.ok(!JSON.stringify(providerHistory).includes('INVALID_SHOULD_NOT_DELIVER'));
});

test('malformed text and image tool results preserve the pending session for a later valid result',async()=>{
  const body={model,max_tokens:1024,tools:callerTools,messages:[{role:'user',content:'REQUEST_CALLER_TOOL_RECOVER_MALFORMED_CONTENT'}]};
  const before=calls.length;
  const first=await request('/v1/messages',body);
  assert.equal(first.status,200,first.text);
  const tool=first.value.content.find(b=>b.type==='tool_use');
  const history=[...body.messages,{role:'assistant',content:first.value.content}];
  for(const content of[
    [{type:'text',text:42}],
    [{type:'image',source:{type:'base64',media_type:'image/png',data:42}}],
  ]){
    const invalid=await request('/v1/messages',{...body,messages:[...history,
      {role:'user',content:[{type:'tool_result',tool_use_id:tool.id,content}]}]});
    assert.equal(invalid.status,400,invalid.text);validationRejections++;
    assert.equal(calls.length,before+1,'Invalid result must not enter the CLI/model pipeline');
  }
  const valid=await request('/v1/messages',{...body,messages:[...history,
    {role:'user',content:[{type:'tool_result',tool_use_id:tool.id,content:'CALLER_VALID_AFTER_BAD_BLOCKS'}]}]});
  assert.equal(valid.status,200,valid.text);
  assert.equal(calls.length,before+2);
  const encoded=JSON.stringify(providerBlocks(calls.at(-1)));
  assert.ok(encoded.includes('CALLER_VALID_AFTER_BAD_BLOCKS'));
  assert.ok(!encoded.includes('"text":42')&&!encoded.includes('"data":42'));
});

test('text accompanying a caller tool result is present before the same model continuation',async()=>{
  const body={model,max_tokens:1024,tools:callerTools,messages:[{role:'user',content:'REQUEST_CALLER_TOOL_MIXED_TEXT'}]};
  const before=calls.length;
  const first=await request('/v1/messages',body);
  assert.equal(first.status,200,first.text);
  const tool=first.value.content.find(b=>b.type==='tool_use');
  const second=await request('/v1/messages',{...body,messages:[...body.messages,{role:'assistant',content:first.value.content},
    {role:'user',content:[{type:'tool_result',tool_use_id:tool.id,content:'CALLER_MIXED_RESULT'},
      {type:'text',text:'CALLER_ADDITIONAL_INSTRUCTION_BEFORE_CONTINUATION'}]}]});
  assert.equal(second.status,200,second.text);
  assert.equal(calls.length,before+2);
  const history=providerBlocks(calls.at(-1));
  assert.ok(history.some(block=>block.type==='text'&&block.text.includes('CALLER_ADDITIONAL_INSTRUCTION_BEFORE_CONTINUATION')),
    'Mixed user text must reach this same continuation, not an unrequested later call');
});

test('Responses JSON and SSE preserve opaque signed items across their own exact CLI continuations',async()=>{
  for(const stream of[false,true]){
    const body={model,store:false,stream,max_output_tokens:1024,instructions:'CALLER_RESPONSES_INSTRUCTIONS',
      input:[{role:'user',content:'RESPONSES_SIGNED'}]};
    const before=calls.length;
    const first=await request('/v1/responses',body);
    assert.equal(first.status,200,first.text);
    assert.equal(first.value.status,'completed');
    const reasoning=first.value.output.filter(item=>item.type==='reasoning');
    assert.equal(reasoning.length,2);
    assert.ok(reasoning.every(item=>typeof item.encrypted_content==='string'));
    assert.ok(!JSON.stringify(first.value).includes('synthetic-signed-'));
    if(stream){
      assert.equal(first.events.filter(event=>event.type==='response.completed').length,1);
      for(const item of first.value.output){
        const done=first.events.find(event=>event.type==='response.output_item.done'&&event.item.id===item.id);
        assert.deepEqual(done?.item,item);
      }
    }
    assert.equal(calls.length,before+1);
    const replayItems=structuredClone(first.value.output);
    for(const item of replayItems)if(item.type==='reasoning')delete item.id;
    const second=await request('/v1/responses',{...body,input:[...body.input,...replayItems,{role:'user',content:'Continue RESPONSES_SIGNED'}]});
    assert.equal(second.status,200,second.text);
    assert.equal(second.value.status,'completed');
    assert.equal(calls.length,before+2);
    const history=providerBlocks(calls.at(-1));
    assert.ok(history.some(block=>block.type==='thinking'&&block.signature==='synthetic-signed-empty'&&block.thinking===''));
    assert.ok(history.some(block=>block.type==='thinking'&&block.signature==='synthetic-signed-visible'&&block.thinking==='Synthetic visible reasoning'));
  }
});

test('Responses function calls roundtrip direct-caller defaults and nonalphabetical arguments through JSON and SSE',async()=>{
  const tools=[{type:'function',name:'caller_response_tool',description:'External caller executes this tool.',
    parameters:{type:'object',properties:{zeta:{type:'integer'},alpha:{type:'string'},nested:{type:'object',
      properties:{zulu:{type:'integer'},alpha:{type:'integer'}},required:['zulu','alpha'],additionalProperties:false}},
      required:['zeta','alpha','nested'],additionalProperties:false},strict:false}];
  for(const stream of[false,true]){
    const body={model,store:false,stream,max_output_tokens:1024,tools,parallel_tool_calls:true,
      instructions:'CALLER_RESPONSE_TOOL_INSTRUCTIONS',input:[{role:'user',content:'REQUEST_CALLER_TOOL_RESPONSES'}]};
    const before=calls.length;
    const first=await request('/v1/responses',body);
    assert.equal(first.status,200,first.text);
    assert.equal(first.value.status,'completed');
    const tool=first.value.output.find(item=>item.type==='function_call');
    assert.ok(tool);assert.equal(tool.name,'caller_response_tool');
    assert.deepEqual(JSON.parse(tool.arguments),{zeta:7,alpha:'original-order',nested:{zulu:3,alpha:4}});
    assert.equal(calls.length,before+1);
    const followup=await request('/v1/responses',{...body,input:[...body.input,...first.value.output,
      {type:'function_call_output',call_id:tool.call_id,output:'CALLER_RESPONSE_TOOL_RESULT'}]});
    assert.equal(followup.status,200,followup.text);
    assert.equal(followup.value.status,'completed');
    assert.equal(calls.length,before+2);
    const history=providerBlocks(calls.at(-1));
    assert.ok(history.some(block=>block.type==='thinking'&&block.signature==='synthetic-provider-signature'));
    const result=history.find(block=>block.type==='tool_result'&&block.tool_use_id===tool.call_id);
    assert.ok(JSON.stringify(result).includes('CALLER_RESPONSE_TOOL_RESULT'));
    const message=followup.value.output.find(item=>item.type==='message');
    assert.equal(message.content.find(block=>block.type==='output_text').text,'CALLER_RESULT_ACCEPTED');
    if(stream)assert.equal(followup.events.filter(event=>event.type==='response.completed').length,1);
  }
});

test('requested128000-token ceiling is observed on the actual CLI provider request',async()=>{
  const before=calls.length;
  const response=await request('/v1/messages',{model,max_tokens:128000,messages:[{role:'user',content:'Return CLI_HTTP_OK for the output-boundary fixture.'}]});
  assert.equal(response.status,200,response.text);
  assert.equal(calls.length,before+1);
  assert.equal(calls.at(-1).body.max_tokens,128000,'The CLI must not silently clamp the caller output ceiling');
});

test('live low-to-high effort change reaches the same CLI conversation as an effective provider override',async()=>{
  const effectiveEffort=body=>body.messages.map(message=>message.output_config?.effort).filter(value=>value!==undefined).at(-1)
    ?? body.output_config?.effort;
  const body={model,max_tokens:1024,output_config:{effort:'low'},messages:[{role:'user',content:'EFFORT_CHANGE_FIRST Return CLI_HTTP_OK.'}]};
  const before=calls.length;
  const first=await request('/v1/messages',body);
  assert.equal(first.status,200,first.text);
  assert.equal(effectiveEffort(calls.at(-1).body),'low');
  const second=await request('/v1/messages',{...body,output_config:{effort:'high'},messages:[...body.messages,
    {role:'assistant',content:first.value.content},{role:'user',content:'EFFORT_CHANGE_SECOND Return CLI_HTTP_OK.'}]});
  assert.equal(second.status,200,second.text);
  assert.equal(calls.length,before+2);
  const actual=calls.at(-1).body;
  assert.equal(effectiveEffort(actual),'high',JSON.stringify({global:actual.output_config,
    perMessage:actual.messages.map(message=>({role:message.role,output_config:message.output_config}))}));
});

test('provider failure is returned once without a second model call or a successful completion',async()=>{
  const before=calls.length;
  const response=await request('/v1/messages',{model,max_tokens:1024,messages:[{role:'user',content:'REQUEST_PROVIDER_FAILURE'}]});
  assert.equal(response.status,429,response.text);
  assert.deepEqual(response.value,{type:'error',error:{type:'rate_limit_error',message:failureMessage}});
  assert.equal(calls.length,before+1);
  await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(calls.length,before+1);
  const row=db.prepare('SELECT * FROM request_log ORDER BY id DESC LIMIT 1').get();
  assert.equal(row.status,'error');assert.equal(row.upstream_http_status,429);
  assert.equal(row.upstream_error_type,'rate_limit_error');assert.equal(row.upstream_diagnostic,'unknown_429');
});

test('disconnect aborts the held provider request and never starts an extra model call',async()=>{
  const before=calls.length;
  const controller=new AbortController();
  const response=await fetch(base+'/v1/messages',{method:'POST',signal:controller.signal,
    headers:{authorization:`Bearer ${key.key}`,'content-type':'application/json'},
    body:JSON.stringify({model,max_tokens:1024,stream:true,messages:[{role:'user',content:'REQUEST_PROVIDER_HOLD'}]})});
  assert.equal(response.status,200);
  const reader=response.body.getReader();
  const first=await reader.read();
  assert.ok(new TextDecoder().decode(first.value).includes('message_start'));
  controller.abort();await reader.cancel().catch(()=>{});
  await until(()=>closedScenarios.has('hold'),'Held provider request must close');
  await until(()=>db.prepare('SELECT status FROM request_log ORDER BY id DESC LIMIT 1').get().status==='cancelled',
    'Caller cancellation must finalize the outer history row');
  await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(calls.length,before+1);
});

test('outer history counts each actual model call once and excludes conversations, signatures and auth',()=>{
  const rows=db.prepare('SELECT * FROM request_log ORDER BY id').all();
  assert.equal(rows.length,calls.length+validationRejections);
  const observed=rows.filter(row=>row.upstream_http_status!==null);
  assert.equal(observed.length,calls.length);
  const rejected=rows.filter(row=>row.upstream_http_status===null);
  assert.equal(rejected.length,validationRejections);
  assert.ok(rejected.every(row=>row.status==='error'&&row.input_tokens===null&&row.output_tokens===null));
  for(const[index,row]of observed.entries()){
    if(calls[index].scenario==='failure'){
      assert.equal(row.status,'error');assert.equal(row.usage_complete,0);
      assert.equal(row.input_tokens,null);assert.equal(row.output_tokens,null);
    }else{
      assert.equal(row.status,calls[index].scenario==='hold'?'cancelled':'success');
      assert.equal(row.usage_complete,calls[index].scenario==='hold'?0:1);
      assert.equal(row.input_tokens,5);assert.equal(row.output_tokens,calls[index].scenario==='hold'?0:9);
      assert.equal(row.cache_read_input_tokens,11);assert.equal(row.cache_creation_input_tokens,3);
    }
    assert.equal(row.full_prompt,null);assert.equal(row.full_response,null);assert.equal(row.prompt_preview,null);
  }
  const stored=JSON.stringify(rows);
  for(const value of['REQUEST_CALLER_TOOL','CALLER_COMPUTED_42','CALLER_ADDITIONAL_INSTRUCTION_BEFORE_CONTINUATION',
    'synthetic-provider-signature','synthetic-signed-empty',failureMessage,process.env.ANTHROPIC_API_KEY,key.key])assert.ok(!stored.includes(value));
});
