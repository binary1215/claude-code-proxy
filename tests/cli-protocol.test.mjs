import assert from 'node:assert/strict';
import test from 'node:test';
import { canonical, cliMessages, cliSystem, cliTools, cliInferenceRequest, CliMessageAccumulator } from '../dist/services/cliProtocol.js';

test('CLI history matching ignores JSON key order while retaining text, block order and signatures',()=>{
  assert.equal(canonical({b:2,a:1}),canonical({a:1,b:2}));
  const source=[{role:'user',content:'Literal 한글🙂 @file /not-a-command'},
    {role:'assistant',content:[{type:'thinking',thinking:'',signature:'opaque-signed-empty'},{type:'text',text:'answer'}]}];
  const snapshot=structuredClone(source),normalized=cliMessages(source);
  assert.deepEqual(source,snapshot);
  assert.deepEqual(normalized[0].content,[{type:'text',text:source[0].content}]);
  assert.deepEqual(normalized[1],source[1]);
  assert.notEqual(canonical(normalized),canonical([...normalized].reverse()));
  assert.throws(()=>canonical({tokens:Infinity}),{code:'invalid_cli_input'});
});

test('CLI system and tool transport preserves original text/schema without granting host tools',()=>{
  const system=[{type:'text',text:'First instruction.'},{type:'text',text:'Second instruction. 한글🙂',cache_control:{type:'ephemeral'}}];
  assert.deepEqual(cliSystem(system).blocks,system);
  assert.equal(cliSystem(system).text,'First instruction.\n\nSecond instruction. 한글🙂');
  const tools=[{name:'external',description:'Caller only',input_schema:{type:'object',$defs:{v:{type:'string'}},properties:{value:{$ref:'#/$defs/v'}}}}];
  assert.deepEqual(cliTools(tools),tools);
  assert.throws(()=>cliTools([{type:'web_search_20260209',name:'web_search'}]),{code:'unsupported_cli_tools'});
  assert.throws(()=>cliTools([...tools,...tools]),{code:'unsupported_cli_tools'});
});

test('native CLI empty system effort controls change policy without reclassifying instructions or user history',()=>{
  const body={model:'fixture',system:'Original system.',output_config:{effort:'medium'},messages:[
    {role:'user',content:'First user input.'},{role:'system',content:[],output_config:{effort:'low'}},
    {role:'assistant',content:'First reply.'},{role:'user',content:'Follow up.'},
    {role:'system',content:[],output_config:{effort:'high'}}]};
  const snapshot=structuredClone(body),prepared=cliInferenceRequest(body);
  assert.deepEqual(body,snapshot);assert.equal(prepared.system,body.system);
  assert.deepEqual(prepared.output_config,{effort:'high'});
  assert.deepEqual(prepared.messages,[body.messages[0],body.messages[2],body.messages[3]]);
  const reset=cliInferenceRequest({...body,messages:[...body.messages,{role:'system',output_config:{effort:null}}]});
  assert.deepEqual(reset.output_config,{});
  const system={role:'system',content:[{type:'text',text:'Late genuine instruction.',cache_control:{type:'ephemeral'}}],clear_at:'next_user_message',output_config:{effort:'low'}};
  const native=cliInferenceRequest({...body,messages:[body.messages[0],system]});
  assert.deepEqual(native.messages,[body.messages[0],system]);
  assert.deepEqual(cliMessages(native.messages)[1],system);
  assert.deepEqual(cliMessages([{role:'system',content:'Exact string.'}]),[{role:'system',content:'Exact string.'}]);
  assert.throws(()=>cliInferenceRequest({...body,messages:[{role:'system',content:[{type:'tool_addition'}]},body.messages[0]]}),{code:'unsupported_cli_system_message'});
});

test('CLI history equates only literal direct-tool and empty-citation native defaults',()=>{
  const content=[{type:'tool_use',id:'toolu_defaults',name:'caller',input:{b:3,a:2},caller:{type:'direct'},toolset_name:null},
    {type:'text',text:'answer',citations:null},{type:'text',text:'more',citations:[]},
    {type:'thinking',thinking:'',signature:'signed-empty'}];
  const original=structuredClone(content);
  const normalized=cliMessages([{role:'assistant',content}])[0].content;
  assert.deepEqual(normalized,[{type:'tool_use',id:'toolu_defaults',name:'caller',input:{a:2,b:3}},
    {type:'text',text:'answer'},{type:'text',text:'more'},{type:'thinking',thinking:'',signature:'signed-empty'}]);
  assert.deepEqual(content,original);
  const substantive=[{...content[0],caller:{type:'code_execution',tool_id:'server'},toolset_name:'tools'},
    {type:'text',text:'citation',citations:[{type:'char_location',start_char_index:0,end_char_index:1}]},
    {...content[0],caller:{type:'direct',future:'retain'},toolset_name:'retained'}];
  assert.deepEqual(cliMessages([{role:'assistant',content:substantive}])[0].content,substantive);
});

test('CLI native accumulator retains every block, signed-empty reasoning and replacement signatures',()=>{
  const model='claude-haiku-5-5',stream=new CliMessageAccumulator(model);
  stream.push({type:'message_start',message:{id:'msg_fixture',type:'message',role:'assistant',model,content:[],usage:{input_tokens:3}}});
  stream.push({type:'content_block_start',index:0,content_block:{type:'thinking',thinking:''}});
  stream.push({type:'content_block_delta',index:0,delta:{type:'signature_delta',signature:'prefix'}});
  stream.push({type:'content_block_delta',index:0,delta:{type:'signature_delta',signature:'replacement'}});
  stream.push({type:'content_block_stop',index:0});
  stream.push({type:'content_block_start',index:1,content_block:{type:'tool_use',id:'toolu_fixture',name:'external',input:{}}});
  stream.push({type:'content_block_delta',index:1,delta:{type:'input_json_delta',partial_json:'{"value":'}});
  stream.push({type:'content_block_delta',index:1,delta:{type:'input_json_delta',partial_json:'7}'}});
  stream.push({type:'content_block_stop',index:1});
  stream.push({type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:8}});
  stream.push({type:'message_stop'});
  const value=stream.result();
  assert.deepEqual(value.content,[{type:'thinking',thinking:'',signature:'replacement'},
    {type:'tool_use',id:'toolu_fixture',name:'external',input:{value:7}}]);
  assert.deepEqual(value.usage,{input_tokens:3,output_tokens:8});
  assert.equal(value.stop_reason,'tool_use');
});

test('CLI truncated, changed-model and malformed tool streams never yield a complete reply',()=>{
  const model='claude-haiku-5-5';
  assert.throws(()=>new CliMessageAccumulator(model).result(),{code:'incomplete_cli_stream'});
  assert.throws(()=>new CliMessageAccumulator(model).push({type:'message_start',message:{model:'other'}}),{code:'cli_model_changed'});
  const stream=new CliMessageAccumulator(model);
  stream.push({type:'message_start',message:{model,content:[]}});
  stream.push({type:'content_block_start',index:0,content_block:{type:'tool_use',id:'toolu_fixture',name:'external',input:{}}});
  stream.push({type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:'{'}});
  assert.throws(()=>stream.push({type:'content_block_stop',index:0}),{code:'invalid_cli_tool_input'});
  const open=new CliMessageAccumulator(model);
  open.push({type:'message_start',message:{model,content:[]}});
  open.push({type:'content_block_start',index:0,content_block:{type:'text',text:''}});
  open.push({type:'message_delta',delta:{stop_reason:'end_turn'}});
  assert.throws(()=>open.push({type:'message_stop'}),{code:'incomplete_cli_stream'});
});
