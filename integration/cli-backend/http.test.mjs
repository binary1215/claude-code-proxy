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
  const userTexts=[...(body.messages??[])].reverse().filter(message=>message.role==='user')
    .map(message=>(Array.isArray(message.content)?message.content:[{type:'text',text:message.content}])
      .filter(block=>block.type==='text').map(block=>block.text).join('\n'));
  // A resumed CLI can append its own environment reminder after caller input.
  // Script only explicit fixture markers; assertions below check the real input.
  const scenarioText=userTexts.find(text=>text.includes('IMPORT_SUMMARY_WITHOUT_TOOLS')||text.includes('COMPACTED_IMPORT_'))??'';
  const hasResult=contents.some(b=>b.type==='tool_result');
  const wantsTool=contents.some(b=>b.type==='text'&&b.text?.includes('REQUEST_CALLER_TOOL'));
  const wantsChain=contents.some(b=>b.type==='text'&&b.text?.includes('REQUEST_CALLER_TOOL_CHAIN'))
    &&!contents.some(b=>b.type==='text'&&b.text?.includes('STOP_CALLER_TOOL_CHAIN'));
  const wantsParallel=contents.some(b=>b.type==='text'&&b.text?.includes('REQUEST_CALLER_TOOL_PARALLEL'));
  const wantsSigned=contents.some(b=>b.type==='text'&&b.text?.includes('RESPONSES_SIGNED'));
  const wantsResponsesTool=contents.some(b=>b.type==='text'&&b.text?.includes('REQUEST_CALLER_TOOL_RESPONSES'));
  const failure=contents.some(b=>b.type==='text'&&b.text?.includes('REQUEST_PROVIDER_FAILURE'));
  const unsupportedMetadata=contents.some(b=>b.type==='text'&&b.text?.includes('REQUEST_UNSUPPORTED_METADATA'));
  const lateUnsupportedMetadata=contents.some(b=>b.type==='text'&&b.text?.includes('REQUEST_UNSUPPORTED_METADATA_LATE'));
  const hold=contents.some(b=>b.type==='text'&&b.text?.includes('REQUEST_PROVIDER_HOLD'));
  if(failure){
    calls.at(-1).scenario='failure';
    res.writeHead(429,{'content-type':'application/json','request-id':'req_011abcdefghijklmnopqrstuv','retry-after':'7'});
    return res.end(JSON.stringify({type:'error',error:{type:'rate_limit_error',message:failureMessage}}));
  }
  if(hold)calls.at(-1).scenario='hold';
  if(unsupportedMetadata)calls.at(-1).scenario='unsupported-metadata';
  let blocks;
  if(scenarioText.includes('IMPORT_SUMMARY_WITHOUT_TOOLS')){
    blocks=[{type:'thinking',thinking:'Synthetic imported-summary reasoning',signature:'synthetic-import-summary-signature'},
      {type:'text',text:'SUMMARY_SOURCE_TOOL_VALUE_42 retained in a compacted summary.',citations:null}];
  }else if(scenarioText.includes('COMPACTED_IMPORT_')){
    const phase=scenarioText.includes('FOLLOWUP_2')?2:scenarioText.includes('FOLLOWUP_1')?1:0;
    blocks=[{type:'thinking',thinking:`Synthetic compacted reasoning ${phase}`,signature:`synthetic-compacted-signature-${phase}`},
      {type:'text',text:`COMPACTED_REPLY_${phase}`,citations:null}];
  }else if(wantsChain||(wantsTool&&!hasResult)){
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
    content:[],stop_reason:null,stop_sequence:null,context_management:null,
    ...(unsupportedMetadata&&!lateUnsupportedMetadata?{future_provider_metadata:{fixture:'unsupported-metadata'}}:{}),usage:{...usage,output_tokens:0}}}));
  if(hold){res.on('close',()=>closedScenarios.add('hold'));return;}
  blocks.forEach((b,index)=>{
    const start=b.type==='thinking'?{...b,thinking:'',signature:''}:b.type==='tool_use'?{...b,input:{}}:{...b,text:''};
    res.write(emit('content_block_start',{index,content_block:start}));
    if(b.type==='thinking'){
      res.write(emit('content_block_delta',{index,delta:{type:'thinking_delta',thinking:'',estimated_tokens:50}}));
      res.write(emit('content_block_delta',{index,delta:{type:'thinking_delta',thinking:'',estimated_tokens:100}}));
      res.write(emit('content_block_delta',{index,delta:{type:'thinking_delta',thinking:'',estimated_tokens:null}}));
      res.write(emit('content_block_delta',{index,delta:{type:'thinking_delta',thinking:b.thinking}}));
      res.write(emit('content_block_delta',{index,delta:{type:'signature_delta',signature:b.signature}}));
    }else if(b.type==='tool_use')res.write(emit('content_block_delta',{index,delta:{type:'input_json_delta',partial_json:JSON.stringify(b.input)}}));
    else res.write(emit('content_block_delta',{index,delta:{type:'text_delta',text:b.text}}));
    res.write(emit('content_block_stop',{index}));
  });
  res.end(emit('message_delta',{delta:{stop_reason:blocks.at(-1).type==='tool_use'?'tool_use':'end_turn',stop_sequence:null,
    ...(lateUnsupportedMetadata?{future_provider_metadata:{fixture:'unsupported-metadata'}}:{})},usage,context_management:null})+emit('message_stop'));
});
upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
Object.assign(process.env,{DATABASE_PATH:':memory:',AUTH_DISABLED:'false',ADMIN_API_SECRET:randomBytes(24).toString('hex'),
  UPSTREAM_AUTH_SOURCE:'configured',ANTHROPIC_API_KEY:'sk-ant-api-scripted-provider-not-a-real-credential',
  ANTHROPIC_BASE_URL:`http://127.0.0.1:${upstream.address().port}`,CLAUDE_INFERENCE_BACKEND:'cli',
  CLAUDE_CLI_RUNTIME_DIR:runtime,CLAUDE_CLI_MAX_SESSIONS:'8',CLAUDE_CLI_WORKER_PATH:new URL('./worker.mjs',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1'),
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
  const contentType=response.headers.get('content-type')??'';
  const cliSession=response.headers.get('x-claude-proxy-cli-session');
  const cliHistory=response.headers.get('x-claude-proxy-cli-history');
  if(contentType.includes('text/event-stream')){
    const events=text.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>JSON.parse(line.slice(5)));
    return {status:response.status,text,contentType,cliSession,cliHistory,events,value:events.at(-1)?.response};
  }
  return {status:response.status,text,contentType,cliSession,cliHistory,value:JSON.parse(text)};
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

test('Responses SSE preserves thinking progress separately from usage and exact signed replay capsules',async()=>{
  const before=calls.length;
  const body={model,store:false,stream:true,max_output_tokens:1024,
    input:[{role:'user',content:'RESPONSES_SIGNED_PROGRESS'}]};
  const response=await request('/v1/responses',body);
  assert.equal(response.status,200,response.text);
  assert.equal(response.value.status,'completed');
  assert.equal(response.events.filter(event=>event.type==='response.completed').length,1);
  assert.equal(response.events.at(-1)?.type,'response.completed');
  assert.deepEqual(response.value.anthropic_metadata.thinking_progress,[
    {output_index:0,estimated_tokens:null,cumulative_estimated_tokens:150},
    {output_index:1,estimated_tokens:null,cumulative_estimated_tokens:150},
  ]);
  assert.deepEqual(response.value.anthropic_usage,{input_tokens:5,output_tokens:9,
    cache_read_input_tokens:11,cache_creation_input_tokens:3});
  assert.equal(response.value.usage.output_tokens,9,'Thinking estimates must not become billed output tokens');
  const reasoning=response.value.output.filter(item=>item.type==='reasoning');
  assert.equal(reasoning.length,2);
  assert.ok(reasoning.every(item=>typeof item.encrypted_content==='string'));
  assert.ok(!JSON.stringify(reasoning).includes('estimated_tokens'));
  const replay=await request('/v1/responses',{...body,max_output_tokens:1025,
    input:[...body.input,...response.value.output,{role:'user',content:'Continue RESPONSES_SIGNED_PROGRESS'}]});
  assert.equal(replay.status,200,replay.text);
  assert.equal(replay.value.status,'completed');
  assert.equal(calls.length,before+2);
  assert.deepEqual(providerBlocks(calls.at(-1)).filter(block=>block.type==='thinking'),[
    {type:'thinking',thinking:'',signature:'synthetic-signed-empty'},
    {type:'thinking',thinking:'Synthetic visible reasoning',signature:'synthetic-signed-visible'},
  ],'Opening and importing replay capsules must preserve exact signed blocks without progress metadata');
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

test('Responses SSE exposes the original conversion failure exactly once after later native events arrive',async()=>{
  for(const marker of['REQUEST_UNSUPPORTED_METADATA_LATE','REQUEST_UNSUPPORTED_METADATA']){
    const before=calls.length;
    const late=marker.endsWith('_LATE');
    const response=await request('/v1/responses',{model,store:false,stream:true,max_output_tokens:1024,
      input:[{role:'user',content:marker}]});
    assert.equal(response.status,late?200:502,response.text);
    assert.equal(calls.length,before+1,'Conversion failure must not make another actual provider request');
    if(late){
      assert.equal(response.events.filter(event=>event.type==='response.failed').length,1,response.text);
      assert.equal(response.events.at(-1)?.type,'response.failed','The client must receive a terminal failure before EOF');
      assert.ok(!response.events.some(event=>['response.completed','response.incomplete'].includes(event.type)));
      assert.ok(response.events.some(event=>event.type==='response.created'),
        'The late metadata case must fail after ordinary SSE output has already started');
      assert.equal(response.value.status,'failed');
    }else{
      assert.ok(response.contentType.startsWith('application/json'),'A preheader JSON error must have a JSON content type');
      assert.equal(response.value.error.type,'api_error','A preheader failure must retain ordinary HTTP error semantics');
    }
    assert.equal(response.value.error.code,'unsupported_upstream_event');
    const row=db.prepare('SELECT * FROM request_log ORDER BY id DESC LIMIT 1').get();
    assert.equal(row.status,'error');
    assert.equal(row.upstream_http_status,200);
    assert.equal(row.usage_complete,0);
    assert.equal(row.input_tokens,5);
    assert.equal(row.output_tokens,9);
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

test('Claude Code empty system effort controls update one live SDK conversation without entering caller history',async()=>{
  const before=calls.length;
  const effectiveEffort=body=>body.messages.map(message=>message.output_config?.effort).filter(value=>value!==undefined).at(-1)
    ?? body.output_config?.effort;
  const body={model,max_tokens:1024,system:'NATIVE_EFFORT_CONTROL_SYSTEM',messages:[
    {role:'user',content:'NATIVE_CONTROL_FIRST Return CLI_HTTP_OK.'},
    {role:'system',content:[],output_config:{effort:'low'}},
  ]};
  const first=await request('/v1/messages',body);
  assert.equal(first.status,200,first.text);
  assert.equal(first.cliHistory,'live');
  assert.ok(first.cliSession);
  assert.equal(effectiveEffort(calls.at(-1).body),'low');
  const second=await request('/v1/messages',{...body,messages:[...body.messages,
    {role:'assistant',content:first.value.content},{role:'user',content:'NATIVE_CONTROL_SECOND Return CLI_HTTP_OK.'},
    {role:'system',content:[],output_config:{effort:'high'}},
  ]});
  assert.equal(second.status,200,second.text);
  assert.equal(second.cliSession,first.cliSession,'Empty native controls must not force a separate SDK conversation');
  assert.equal(second.cliHistory,'live','Controls must be consistently omitted from continuation history matching');
  assert.equal(effectiveEffort(calls.at(-1).body),'high');
  const actual=calls.at(-1).body;
  for(const marker of['NATIVE_CONTROL_FIRST','NATIVE_CONTROL_SECOND'])assert.equal(actual.messages
    .filter(message=>message.role==='user').flatMap(message=>message.content)
    .filter(block=>block.type==='text'&&block.text.includes(marker)).length,1);
  assert.ok(actual.messages.some(message=>message.role==='assistant'
    &&message.content.some(block=>block.type==='text'&&block.text==='CLI_HTTP_OK')));
  const system=typeof actual.system==='string'?actual.system:actual.system.map(block=>block.text??'').join('\n');
  assert.ok(system.includes('NATIVE_EFFORT_CONTROL_SYSTEM'),'The top-level caller system text must be preserved');
  assert.equal(calls.length,before+2);
});

test('native environment system records preserve order, cache blocks and caller-relative lifetimes across live continuation and new-system import',async()=>{
  const before=calls.length;
  const userText='NATIVE_ENV_ORIGINAL_USER\n'+Array.from({length:80},(_,index)=>`Caller context line ${index}: preserve native message positions.`).join('\n');
  const persistent={role:'system',clear_at:'never',output_config:{effort:'low'},content:[
    {type:'text',text:'NATIVE_ENV_PERSISTENT\n<system-reminder>Caller-owned environment.</system-reminder>',
      cache_control:{type:'ephemeral',ttl:'5m'}},
    {type:'text',text:'NATIVE_ENV_PERSISTENT_SECOND_BLOCK'},
  ]};
  const ephemeral={role:'system',clear_at:'next_user_message',output_config:{effort:'high'},content:[
    {type:'text',text:'NATIVE_ENV_THIS_TURN_ONLY',cache_control:{type:'ephemeral',ttl:'1h'}},
  ]};
  const body={model,max_tokens:1024,system:'NATIVE_ENV_TOP_LEVEL_SYSTEM',messages:[
    {role:'user',content:userText},persistent,ephemeral,
  ]};
  const textMatches=(message,text,exact=false)=>(Array.isArray(message.content)?message.content:[{type:'text',text:message.content}])
    .some(block=>block.type==='text'&&(exact?block.text===text:block.text?.includes(text)));
  const locate=(actual,marker)=>actual.messages.findIndex(message=>message.role==='system'&&Array.isArray(message.content)
    &&message.content.some(block=>block.type==='text'&&block.text.includes(marker)));
  const verify=(actual,activeEphemeral=false,currentUserText=userText)=>{
    assert.ok(!JSON.stringify(actual).includes('[claude-proxy-system:'),'Private import carrier markers must never reach the provider');
    assert.ok(!JSON.stringify(actual).includes('[claude-proxy-resume:'),'Private resume trigger markers must never reach the provider');
    const currentUser=actual.messages.findIndex(message=>message.role==='user'&&textMatches(message,currentUserText,true));
    assert.ok(currentUser>=0,'The current real caller user turn must reach the provider');
    assert.ok(!actual.messages.slice(currentUser+1).some(message=>message.role==='assistant'),
      'No synthetic assistant may mark the current caller request answered before the provider infers');
    const userIndex=actual.messages.findIndex(message=>message.role==='user'&&textMatches(message,userText,true));
    const persistentIndex=locate(actual,'NATIVE_ENV_PERSISTENT\n');
    const ephemeralIndex=locate(actual,'NATIVE_ENV_THIS_TURN_ONLY');
    assert.ok(userIndex>=0&&persistentIndex>userIndex,'Original caller user/system order must survive SDK import');
    assert.deepEqual(actual.messages[persistentIndex],persistent,'Persistent native record must retain exact content blocks and cache marker');
    if(activeEphemeral){
      assert.ok(ephemeralIndex>persistentIndex,'Active per-turn system content must retain its caller position');
      assert.deepEqual(actual.messages[ephemeralIndex],{...ephemeral,clear_at:'never'},
        'An active caller-relative record must retain exact text/cache blocks while SDK helper turns cannot expire it');
    }else assert.equal(ephemeralIndex,-1,'A later real caller user turn must expire prior next_user_message text');
    const effort=actual.messages.map(message=>message.output_config?.effort).filter(value=>value!==undefined).at(-1)
      ??actual.output_config?.effort;
    assert.equal(effort,'high','Expiring system text must not discard its separately applied effort setting');
    const top=typeof actual.system==='string'?actual.system:actual.system.map(block=>block.text??'').join('\n');
    assert.ok(top.includes('NATIVE_ENV_TOP_LEVEL_SYSTEM'));
    assert.ok(!top.includes('NATIVE_ENV_PERSISTENT')&&!top.includes('NATIVE_ENV_THIS_TURN_ONLY'),
      'Per-message system content must retain its original position rather than enter top-level system');
    return {persistentIndex};
  };
  const first=await request('/v1/messages',body);
  assert.equal(first.status,200,first.text);
  assert.ok(first.cliSession);
  verify(calls.at(-1).body,true);
  const secondMessages=[...body.messages,{role:'assistant',content:first.value.content},
    {role:'user',content:'NATIVE_ENV_SECOND_USER Return CLI_HTTP_OK.'}];
  const second=await request('/v1/messages',{...body,messages:secondMessages});
  assert.equal(second.status,200,second.text);
  assert.equal(second.cliSession,first.cliSession,'Unchanged native system history must reuse the indexed SDK session');
  const secondWire=calls.at(-1).body;
  const retained=verify(secondWire,false,'NATIVE_ENV_SECOND_USER Return CLI_HTTP_OK.');
  const laterUser=secondWire.messages.findIndex(message=>message.role==='user'
    &&textMatches(message,'NATIVE_ENV_SECOND_USER'));
  assert.ok(laterUser>retained.persistentIndex,'Persistent system text must remain before the later real caller user');
  const replacement={role:'system',clear_at:'never',output_config:{effort:'high'},content:[
    {type:'text',text:'NATIVE_ENV_CHANGED_AFTER_ASSISTANT',cache_control:{type:'ephemeral',ttl:'5m'}},
  ]};
  const third=await request('/v1/messages',{...body,messages:[...secondMessages,{role:'assistant',content:second.value.content},
    {role:'user',content:'NATIVE_ENV_THIRD_USER Return CLI_HTTP_OK.'},replacement]});
  assert.equal(third.status,200,third.text);
  assert.notEqual(third.cliSession,second.cliSession,'New native system content must import the complete updated history');
  const thirdWire=calls.at(-1).body;
  verify(thirdWire,false,'NATIVE_ENV_THIRD_USER Return CLI_HTTP_OK.');
  const replacementIndex=locate(thirdWire,'NATIVE_ENV_CHANGED_AFTER_ASSISTANT');
  assert.deepEqual(thirdWire.messages[replacementIndex],replacement);
  assert.ok(thirdWire.messages.findIndex(message=>message.role==='user'
    &&textMatches(message,'NATIVE_ENV_THIRD_USER'))<replacementIndex);
  assert.equal(calls.length,before+3,'System preservation must not create extra provider calls');
});

test('Claude Code thinking display updates reaches the provider with its public beta and preserves signed output',async()=>{
  const before=calls.length;
  const response=await request('/v1/messages',{model,max_tokens:1024,thinking:{type:'adaptive',display:'updates'},
    messages:[{role:'user',content:'RESPONSES_SIGNED_NATIVE_UPDATES'}]});
  assert.equal(response.status,200,response.text);
  assert.equal(calls.length,before+1);
  assert.equal(calls.at(-1).body.thinking.type,'adaptive');
  assert.equal(calls.at(-1).body.thinking.display,'updates');
  assert.ok(String(calls.at(-1).headers['anthropic-beta']).split(',').map(value=>value.trim())
    .includes('thinking-display-updates-2026-08-18'));
  assert.ok(response.value.content.some(block=>block.type==='thinking'&&block.thinking===''
    &&block.signature==='synthetic-signed-empty'));
  assert.ok(response.value.content.some(block=>block.type==='thinking'&&block.thinking==='Synthetic visible reasoning'
    &&block.signature==='synthetic-signed-visible'));
});

test('toolset-changing summary import and fresh compacted context retain native history then replay new signed thinking twice',async()=>{
  const before=calls.length;
  const initial={model,max_tokens:1024,system:'IMPORT_WORKFLOW_SYSTEM',tools:callerTools,
    messages:[{role:'user',content:'REQUEST_CALLER_TOOL_BEFORE_IMPORT'}]};
  const first=await request('/v1/messages',initial);
  assert.equal(first.status,200,first.text);
  const tool=first.value.content.find(block=>block.type==='tool_use');
  const originalNativeName=calls[before].body.tools.find(definition=>definition.name.startsWith('mcp__caller__')).name;
  const completedMessages=[...initial.messages,{role:'assistant',content:first.value.content},
    {role:'user',content:[{type:'tool_result',tool_use_id:tool.id,content:'SUMMARY_SOURCE_TOOL_VALUE_42'}]}];
  const completed=await request('/v1/messages',{...initial,messages:completedMessages});
  assert.equal(completed.status,200,completed.text);
  const summaryBody={...initial,tools:[],messages:[...completedMessages,{role:'assistant',content:completed.value.content},
    {role:'user',content:'IMPORT_SUMMARY_WITHOUT_TOOLS'}]};
  const summary=await request('/v1/messages',summaryBody);
  assert.equal(summary.status,200,summary.text);
  assert.equal(calls.length,before+3);
  const imported=calls.at(-1).body;
  assert.ok(!(imported.tools??[]).some(definition=>definition.name.startsWith('mcp__caller__')),
    'Historical tools must not become newly callable tools');
  const assistant=imported.messages.find(message=>message.role==='assistant'&&message.content.some(block=>block.type==='tool_use'&&block.id===tool.id));
  assert.ok(assistant,'Imported tool call must stay in an assistant role');
  assert.ok(assistant.content.some(block=>block.type==='thinking'&&block.signature==='synthetic-provider-signature'));
  const historicalCall=assistant.content.find(block=>block.type==='tool_use'&&block.id===tool.id);
  assert.equal(historicalCall.name,originalNativeName);
  assert.deepEqual(historicalCall.input.input,{value:7});
  const resultMessage=imported.messages.find(message=>message.role==='user'&&message.content.some(block=>block.type==='tool_result'&&block.tool_use_id===tool.id));
  assert.ok(resultMessage,'Imported result must stay in a user/tool_result role');
  const historicalResult=resultMessage.content.find(block=>block.type==='tool_result'&&block.tool_use_id===tool.id);
  assert.ok(JSON.stringify(historicalResult).includes('SUMMARY_SOURCE_TOOL_VALUE_42'));
  assert.ok(!JSON.stringify(historicalResult).toLowerCase().includes('interrupted'));
  assert.ok(imported.messages.some(message=>message.role==='user'&&message.content.some(block=>block.type==='text'
    &&block.text==='IMPORT_SUMMARY_WITHOUT_TOOLS')),'The summary instruction itself must reach the provider');
  assert.ok(summary.value.content.some(block=>block.type==='thinking'&&block.signature==='synthetic-import-summary-signature'));
  const summaryText=summary.value.content.find(block=>block.type==='text').text;
  const compacted={model,max_tokens:1024,system:'IMPORT_WORKFLOW_SYSTEM',tools:[],messages:[
    {role:'user',content:'COMPACTED_IMPORT_CONTEXT\n'+summaryText}]};
  let reply=await request('/v1/messages',compacted);
  assert.equal(reply.status,200,reply.text);
  assert.equal(reply.value.usage.cache_read_input_tokens,11);
  const compactedWire=providerBlocks(calls.at(-1));
  assert.ok(!compactedWire.some(block=>block.type==='tool_use'||block.type==='tool_result'),
    'User-only compacted context must not retain stale private tool history');
  assert.ok(!compactedWire.some(block=>block.type==='thinking'));
  let history=[...compacted.messages];
  for(let phase=1;phase<=2;phase++){
    const prior=reply.value;
    history.push({role:'assistant',content:prior.content},{role:'user',content:`COMPACTED_IMPORT_FOLLOWUP_${phase}`});
    reply=await request('/v1/messages',{...compacted,messages:history});
    assert.equal(reply.status,200,reply.text);
    assert.equal(reply.value.usage.cache_read_input_tokens,11);
    const actual=providerBlocks(calls.at(-1));
    for(let retained=0;retained<phase;retained++)assert.ok(actual.some(block=>block.type==='thinking'
      &&block.signature===`synthetic-compacted-signature-${retained}`&&block.thinking===`Synthetic compacted reasoning ${retained}`));
    assert.ok(reply.value.content.some(block=>block.type==='thinking'&&block.signature===`synthetic-compacted-signature-${phase}`));
  }
  assert.equal(calls.length,before+6);
});

test('external slash-command-shaped text reaches the provider literally without invoking internal compaction',async()=>{
  const before=calls.length;
  const literal='/compact this-is-user-text @file';
  const response=await request('/v1/messages',{model,max_tokens:1024,messages:[{role:'user',content:literal}]});
  assert.equal(response.status,200,response.text);
  assert.equal(calls.length,before+1,'External text must produce one ordinary turn, without an internal compaction request');
  assert.ok(calls.at(-1).body.messages.some(message=>message.role==='user'
    &&message.content.some(block=>block.type==='text'&&block.text===literal)));
  assert.equal(response.value.content.find(block=>block.type==='text').text,'CLI_HTTP_OK');
});

test('changed token ceiling, system and branch history import the original native roles without later-branch leakage',async()=>{
  const before=calls.length;
  const initial={model,max_tokens:1024,system:'BASE_IMPORT_SYSTEM',messages:[{role:'user',content:'BRANCH_IMPORT_ORIGINAL Return CLI_HTTP_OK.'}]};
  const first=await request('/v1/messages',initial);
  assert.equal(first.status,200,first.text);
  const prefix=[...initial.messages,{role:'assistant',content:first.value.content}];
  const advanced=await request('/v1/messages',{...initial,messages:[...prefix,{role:'user',content:'BRANCH_PATH_A_ONLY Return CLI_HTTP_OK.'}]});
  assert.equal(advanced.status,200,advanced.text);
  for(const variant of[
    {name:'max',max_tokens:2048,system:'BASE_IMPORT_SYSTEM',prompt:'IMPORT_CHANGED_MAX'},
    {name:'system',max_tokens:1024,system:'UPDATED_IMPORT_SYSTEM',prompt:'IMPORT_CHANGED_SYSTEM'},
    {name:'branch',max_tokens:1024,system:'BASE_IMPORT_SYSTEM',prompt:'BRANCH_PATH_B_ONLY'},
  ]){
    const response=await request('/v1/messages',{...initial,max_tokens:variant.max_tokens,system:variant.system,
      messages:[...prefix,{role:'user',content:variant.prompt+' Return CLI_HTTP_OK.'}]});
    assert.equal(response.status,200,response.text);
    const actual=calls.at(-1).body;
    assert.equal(actual.max_tokens,variant.max_tokens);
    assert.ok(actual.messages.some(message=>message.role==='assistant'&&message.content.some(block=>block.type==='text'&&block.text==='CLI_HTTP_OK')));
    assert.ok(!JSON.stringify(actual.messages).includes('BRANCH_PATH_A_ONLY'));
    assert.ok(providerBlocks(calls.at(-1)).some(block=>block.type==='text'&&block.text.includes(variant.prompt)));
    const system=typeof actual.system==='string'?actual.system:actual.system.map(block=>block.text??'').join('\n');
    assert.ok(system.includes(variant.system));
    if(variant.name==='system')assert.ok(!system.includes('BASE_IMPORT_SYSTEM'));
  }
  assert.equal(calls.length,before+5);
});

test('cold history ending in a completed caller tool result imports the real result without an interruption placeholder',async()=>{
  const before=calls.length;
  const toolId='toolu_imported_completed_42';
  const body={model,max_tokens:1024,tools:[],system:'COLD_TOOL_RESULT_IMPORT',messages:[
    {role:'user',content:'An earlier caller requested the external computation.'},
    {role:'assistant',content:[{type:'thinking',thinking:'Synthetic historical thought',signature:'synthetic-cold-history-signature'},
      {type:'tool_use',id:toolId,name:'historical_caller_tool',input:{zeta:7,alpha:3}}]},
    {role:'user',content:[{type:'tool_result',tool_use_id:toolId,content:'REAL_COMPLETED_CALLER_RESULT_42'}]},
  ]};
  const response=await request('/v1/messages',body);
  assert.equal(response.status,200,response.text);
  assert.equal(calls.length,before+1);
  const actual=calls.at(-1).body;
  const assistant=actual.messages.find(message=>message.role==='assistant'&&message.content.some(block=>block.type==='tool_use'&&block.id===toolId));
  assert.ok(assistant);assert.ok(assistant.content.some(block=>block.type==='thinking'&&block.signature==='synthetic-cold-history-signature'));
  const result=actual.messages.filter(message=>message.role==='user').flatMap(message=>message.content)
    .find(block=>block.type==='tool_result'&&block.tool_use_id===toolId);
  assert.ok(result);assert.ok(JSON.stringify(result).includes('REAL_COMPLETED_CALLER_RESULT_42'));
  assert.ok(!JSON.stringify(result).toLowerCase().includes('interrupted'));
  const resultIndex=actual.messages.findIndex(message=>message.role==='user'&&Array.isArray(message.content)
    &&message.content.some(block=>block.type==='tool_result'&&block.tool_use_id===toolId));
  assert.ok(resultIndex>=0);
  assert.ok(!actual.messages.slice(resultIndex+1).some(message=>message.role==='assistant'),
    'No synthetic assistant may mark an imported completed caller result answered before inference');
  assert.ok(!JSON.stringify(actual).includes('[claude-proxy-resume:'));
  assert.ok(!(actual.tools??[]).some(tool=>tool.name.startsWith('mcp__caller__')));
});

test('ten scope-changing caller tool results retire superseded pending workers instead of exhausting capacity',async()=>{
  const before=calls.length;
  const initial={model,max_tokens:1024,system:'CHAIN_IMPORT_LIFECYCLE',tools:callerTools,
    messages:[{role:'user',content:'REQUEST_CALLER_TOOL_CHAIN'}]};
  const history=[...initial.messages];
  let response=await request('/v1/messages',initial);
  assert.equal(response.status,200,response.text);
  const seen=new Set();
  for(let turn=1;turn<=10;turn++){
    const tool=response.value.content.find(block=>block.type==='tool_use');
    assert.ok(tool,`Chain turn ${turn} must return a caller tool`);
    assert.ok(!seen.has(tool.id),'Every actual provider call must use a unique native tool ID');
    seen.add(tool.id);
    const result=`CHAIN_COMPLETED_VALUE_${turn}`;
    history.push({role:'assistant',content:response.value.content},
      {role:'user',content:[{type:'tool_result',tool_use_id:tool.id,content:result}]});
    response=await request('/v1/messages',{...initial,max_tokens:1024+turn,messages:history});
    assert.equal(response.status,200,`Scope-changing chain turn ${turn}: ${response.text}`);
    const actual=calls.at(-1).body;
    assert.equal(actual.max_tokens,1024+turn);
    const imported=providerBlocks(calls.at(-1));
    const nativeResult=imported.find(block=>block.type==='tool_result'&&block.tool_use_id===tool.id);
    assert.ok(nativeResult&&JSON.stringify(nativeResult).includes(result));
    assert.ok(!JSON.stringify(nativeResult).toLowerCase().includes('interrupted'));
    assert.ok(imported.some(block=>block.type==='tool_use'&&block.id===tool.id));
  }
  const finalTool=response.value.content.find(block=>block.type==='tool_use');
  assert.ok(finalTool&&!seen.has(finalTool.id));
  history.push({role:'assistant',content:response.value.content},{role:'user',content:[
    {type:'tool_result',tool_use_id:finalTool.id,content:'CHAIN_FINAL_COMPLETED_VALUE'},
    {type:'text',text:'STOP_CALLER_TOOL_CHAIN'},
  ]});
  const final=await request('/v1/messages',{...initial,max_tokens:1035,messages:history});
  assert.equal(final.status,200,final.text);
  assert.ok(!final.value.content.some(block=>block.type==='tool_use'));
  assert.equal(final.value.content.find(block=>block.type==='text').text,'CALLER_RESULT_ACCEPTED');
  assert.equal(calls.length,before+12,'Each result and final stop must produce exactly one model request');
});

test('full signed caller history hydrates after all previous CLI workers are closed',async()=>{
  const before=calls.length;
  const initial={model,max_tokens:1024,system:'RESTART_HISTORY_SYSTEM',messages:[{role:'user',content:'RESPONSES_SIGNED_RESTART_NATIVE'}]};
  const first=await request('/v1/messages',initial);
  assert.equal(first.status,200,first.text);
  await closeCliSessions();
  const resumed=await request('/v1/messages',{...initial,messages:[...initial.messages,{role:'assistant',content:first.value.content},
    {role:'user',content:'RESTART_IMPORT_FOLLOWUP'}]});
  assert.equal(resumed.status,200,resumed.text);
  assert.equal(calls.length,before+2);
  const actual=calls.at(-1).body;
  const assistant=actual.messages.find(message=>message.role==='assistant'&&message.content.some(block=>block.type==='thinking'));
  assert.ok(assistant);
  assert.ok(assistant.content.some(block=>block.type==='thinking'&&block.signature==='synthetic-signed-empty'&&block.thinking===''));
  assert.ok(assistant.content.some(block=>block.type==='thinking'&&block.signature==='synthetic-signed-visible'&&block.thinking==='Synthetic visible reasoning'));
  assert.ok(actual.messages.some(message=>message.role==='user'&&message.content.some(block=>block.type==='text'&&block.text.includes('RESTART_IMPORT_FOLLOWUP'))));
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
  assert.ok(calls.every(call=>!JSON.stringify(call.body).includes('[claude-proxy-resume:')),
    'Private resume trigger markers must remain absent across all imported and live provider replays');
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
      assert.equal(row.status,calls[index].scenario==='hold'?'cancelled':calls[index].scenario==='unsupported-metadata'?'error':'success');
      assert.equal(row.usage_complete,['hold','unsupported-metadata'].includes(calls[index].scenario)?0:1);
      assert.equal(row.input_tokens,5);assert.equal(row.output_tokens,calls[index].scenario==='hold'?0:9);
      assert.equal(row.cache_read_input_tokens,11);assert.equal(row.cache_creation_input_tokens,3);
    }
    assert.equal(row.full_prompt,null);assert.equal(row.full_response,null);assert.equal(row.prompt_preview,null);
  }
  const stored=JSON.stringify(rows);
  for(const value of['REQUEST_CALLER_TOOL','CALLER_COMPUTED_42','CALLER_ADDITIONAL_INSTRUCTION_BEFORE_CONTINUATION',
    'synthetic-provider-signature','synthetic-signed-empty',failureMessage,process.env.ANTHROPIC_API_KEY,key.key])assert.ok(!stored.includes(value));
});
