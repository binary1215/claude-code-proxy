// Fed to `node --input-type=module - PHASE` inside a pinned, network-none image.
// Never emits credentials, capsules, request/response bodies, or exception text.
import http from 'node:http';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, copyFileSync, constants } from 'node:fs';

const phases = ['baseline_seed','baseline_restart','candidate_mint','candidate_restart_replay',
  'candidate_wrong_key','baseline_rollback','candidate_reupgrade_replay','backup_restore_replay'];
const phase = process.argv[2];
const file = '/app/data/lifecycle-fixture.json';
const model = 'fixture-lifecycle-model';
const nativeBlocks = [
  {type:'thinking',thinking:'synthetic 한글🙂',signature:'synthetic-fragmented-signature+/='},
  {type:'thinking',thinking:'',signature:'synthetic-signed-empty+/='},
  {type:'redacted_thinking',data:'synthetic-redacted+/='},
  {type:'text',text:'SYNTHETIC_LIFECYCLE_MINT'},
];
const usage = {input_tokens:3,output_tokens:9,cache_read_input_tokens:7,cache_creation_input_tokens:2,
  cache_creation:{ephemeral_5m_input_tokens:1,ephemeral_1h_input_tokens:1}};
let appServer, upstream, db, stage = 'startup', fixtureFailure = false;
let state, providerCalls = 0, providerMode = 'native', lastBody;
let sourceBackupDigest, sourceFixtureDigest, sourceLiveDigest, postBackupRowsAbsent = 0;
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const log = console.log.bind(console);
// Imported app logging is not diagnostic evidence and might contain arbitrary text.
console.log = console.info = console.warn = console.error = () => {};
const deadline = setTimeout(() => {
  log(JSON.stringify({phase,pass:false,failure:'phase_deadline'}));process.exit(1);
}, 20000);
function save() { writeFileSync(file,JSON.stringify(state),{mode:0o600}); }
function event(type, extra={}) { return `event: ${type}\r\ndata: ${JSON.stringify({type,...extra})}\r\n\r\n`; }
function wire() {
  let bytes=event('message_start',{message:{id:'msg_synthetic_lifecycle',type:'message',role:'assistant',model,
    content:[],stop_reason:null,stop_sequence:null,usage:{...usage,output_tokens:0}}});
  nativeBlocks.forEach((b,index) => {
    const start=b.type==='thinking'?{...b,thinking:'',signature:''}:b.type==='text'?{...b,text:''}:b;
    bytes+=event('content_block_start',{index,content_block:start});
    if(b.type==='thinking') {
      bytes+=event('content_block_delta',{index,delta:{type:'thinking_delta',thinking:b.thinking}});
      bytes+=event('content_block_delta',{index,delta:{type:'signature_delta',signature:b.signature}});
    }
    if(b.type==='text') bytes+=event('content_block_delta',{index,delta:{type:'text_delta',text:b.text}});
    bytes+=event('content_block_stop',{index});
  });
  return Buffer.from(bytes+event('message_delta',{delta:{stop_reason:'end_turn',stop_sequence:null},usage})+event('message_stop'));
}
function request(method,path,body,credential=state.admin) {
  return new Promise((resolve,reject) => {
    const bytes=body===undefined?undefined:Buffer.from(JSON.stringify(body));
    const req=http.request({host:'127.0.0.1',port:18081,path,method,headers:{
      authorization:`Bearer ${credential}`,...(bytes?{'content-type':'application/json','content-length':bytes.length}:{})}},res => {
      const chunks=[];let size=0;
      res.on('data',p=>{size+=p.length;if(size>4*1024*1024)req.destroy(new Error('bounded'));else chunks.push(p);});
      res.on('error',reject);res.on('aborted',()=>reject(new Error('aborted')));
      res.on('end',()=>resolve({status:res.statusCode,text:Buffer.concat(chunks).toString('utf8')}));
    });
    req.on('error',reject);req.setTimeout(4000,()=>req.destroy(new Error('deadline')));req.end(bytes);
  });
}
function json(r,status=200) { assert.equal(r.status,status);return JSON.parse(r.text); }
function nativeRequest(which=model) { return {model:which,max_tokens:64,messages:[{role:'user',content:'synthetic lifecycle'}]}; }
function responseRequest(input='synthetic seed',stream=false) { return {model,input,stream,store:false,max_output_tokens:2048}; }
function responseEvents(r) {
  assert.equal(r.status,200);
  const events=r.text.split('\n').filter(l=>l.startsWith('data: ')).map(l=>JSON.parse(l.slice(6)));
  assert.deepEqual(events.map(e=>e.sequence_number),events.map((_,i)=>i));
  assert.equal(events.filter(e=>e.type==='response.failed').length,0);
  const terminals=events.filter(e=>['response.completed','response.incomplete'].includes(e.type));
  assert.equal(terminals.length,1);assert.equal(terminals[0].type,'response.completed');
  const response=terminals[0].response;
  assert.deepEqual(events.filter(e=>e.type==='response.output_item.done').map(e=>e.item),response.output);
  return response;
}
async function settled() {
  const {listTasks}=await import('/app/dist/services/taskTracker.js');
  for(let n=0;n<100;n++){if(!listTasks().length){await new Promise(r=>setImmediate(r));return;}await new Promise(r=>setTimeout(r,10));}
  throw new Error('unsettled');
}
async function history() {
  await settled();const result=json(await request('GET','/api/admin/history?limit=50'));
  assert.equal(result.total,state.historyCount);
  for(const row of result.rows) {
    assert.equal(row.status,'success');assert.equal(row.usage_complete,1);
    assert.equal(row.input_tokens,3);assert.equal(row.output_tokens,9);
    assert.equal(row.cache_read_input_tokens,7);assert.equal(row.cache_creation_input_tokens,2);
    assert.equal(row.cache_creation_5m_tokens,1);assert.equal(row.cache_creation_1h_tokens,1);
    assert.equal(row.total_cost_usd,null);
  }
  if(state.oldRow) assert.deepEqual(json(await request('GET',`/api/admin/history/${state.oldRow.id}`)),state.oldRow);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM request_log WHERE full_prompt IS NOT NULL OR full_response IS NOT NULL OR prompt_preview IS NOT NULL').get().n,0);
  return result;
}
async function policyChecks() {
  const before=providerCalls;
  assert.equal((await request('POST','/v1/messages',nativeRequest(),state.revokedKey)).status,401);
  assert.equal((await request('POST','/v1/messages',nativeRequest('fixture-denied-model'),state.key)).status,403);
  assert.equal(providerCalls,before);
  const keys=json(await request('GET','/api/admin/keys')).keys;
  const active=keys.find(k=>k.id===state.keyId),revoked=keys.find(k=>k.id===state.revokedId);
  assert(active);assert.deepEqual(active.allowed_models,[model]);assert.equal(active.is_revoked,false);
  assert(revoked);assert.equal(revoked.is_revoked,true);
}
async function nativeSuccess() {
  providerMode='native';const before=providerCalls;
  const result=json(await request('POST','/v1/messages',nativeRequest(),state.key));
  assert.equal(result.content[0].text,'SYNTHETIC_NATIVE_OK');assert.equal(providerCalls,before+1);
  state.historyCount++;await history();
}
async function replay() {
  providerMode='replay';const before=providerCalls;
  const output=structuredClone(state.output);
  const input=[{role:'user',content:'synthetic seed'},...output,{role:'user',content:'synthetic continuation'}];
  const result=json(await request('POST','/v1/responses',responseRequest(input),state.key));
  assert.equal(result.status,'completed');assert.equal(providerCalls,before+1);
  assert.deepEqual(lastBody.messages.find(m=>m.role==='assistant').content,nativeBlocks);
  assert.equal(Object.hasOwn(lastBody,'tools'),false);
  assert.deepEqual(state.output,output);state.historyCount++;await history();
}
try {
  assert(phases.includes(phase));
  if(phase==='baseline_seed') {
    assert.equal(existsSync(file),false);
    state={admin:randomBytes(24).toString('hex'),upstream:'sk-ant-api-synthetic-'+randomBytes(16).toString('hex'),
      stateKey:randomBytes(32).toString('base64'),historyCount:0,completed:[]};save();
  } else if(phase==='backup_restore_replay') {
    assert.equal(existsSync(file),false);assert.equal(existsSync('/app/data/proxy.db'),false);
    sourceBackupDigest=digest('/fixture-source/seed-backup.db');
    sourceFixtureDigest=digest('/fixture-source/lifecycle-fixture.json');
    sourceLiveDigest=digest('/fixture-source/proxy.db');
    state=JSON.parse(readFileSync('/fixture-source/lifecycle-fixture.json','utf8'));
    assert.deepEqual(state.completed,phases.slice(0,-1));
    assert.equal(sourceBackupDigest,state.backupDigest);
    assert.equal(state.historyCount,6);
    postBackupRowsAbsent=state.historyCount-1;
    // Copy only the completed SQLite backup, never the current live database.
    copyFileSync('/fixture-source/seed-backup.db','/app/data/proxy.db',constants.COPYFILE_EXCL);
    assert.equal(digest('/app/data/proxy.db'),sourceBackupDigest);
    // Config secrets and client-held history are external to the DB backup.
    state.historyCount=1;
  } else {
    state=JSON.parse(readFileSync(file,'utf8'));
    assert.deepEqual(state.completed,phases.slice(0,phases.indexOf(phase)));
  }
  Object.assign(process.env,{DATABASE_PATH:'/app/data/proxy.db',AUTH_DISABLED:'false',ADMIN_API_SECRET:state.admin,
    ANTHROPIC_BASE_URL:'http://127.0.0.1:18080',OLLAMA_URL:'http://127.0.0.1:18080',UPSTREAM_TIMEOUT_MS:'3000',
    RESPONSES_ENABLED:'true',RESPONSES_STATE_KEY:phase==='candidate_wrong_key'?randomBytes(32).toString('base64'):state.stateKey,
    RESPONSES_STATE_TTL_SECONDS:'3600'});
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;delete process.env.ANTHROPIC_API_KEY;
  upstream=http.createServer(async(req,res) => {
    try {
      let size=0;const chunks=[];
      for await(const part of req){size+=part.length;assert(size<=1024*1024);chunks.push(part);}
      providerCalls++;assert.equal(req.url,'/v1/messages');
      assert.equal(req.headers['x-api-key'],state.upstream);assert.equal(req.headers.authorization,undefined);
      lastBody=JSON.parse(Buffer.concat(chunks));assert.equal(lastBody.model,model);
      assert(!JSON.stringify(lastBody).includes(state.key));
      if(providerMode==='mint') {
        assert.equal(lastBody.stream,true);res.writeHead(200,{'content-type':'text/event-stream'});
        const bytes=wire();for(let n=0;n<bytes.length;n+=7){res.write(bytes.subarray(n,n+7));await new Promise(r=>setImmediate(r));}res.end();
      } else {
        res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id:'msg_synthetic_lifecycle',type:'message',role:'assistant',model,
          content:[{type:'text',text:'SYNTHETIC_NATIVE_OK'}],stop_reason:'end_turn',stop_sequence:null,usage}));
      }
    } catch { fixtureFailure=true;res.writeHead(500);res.end('{}'); }
  });
  upstream.listen(18080,'127.0.0.1');await once(upstream,'listening');
  const {app}=await import('/app/dist/app.js');({db}=await import('/app/dist/db/connection.js'));
  appServer=app.listen(18081,'127.0.0.1');await once(appServer,'listening');stage='application_contract';
  if(phase==='baseline_seed') {
    const key=json(await request('POST','/api/admin/keys',{name:'synthetic-lifecycle-active'}),201);
    const revoked=json(await request('POST','/api/admin/keys',{name:'synthetic-lifecycle-revoked'}),201);
    Object.assign(state,{key:key.key,keyId:key.id,revokedKey:revoked.key,revokedId:revoked.id});
    json(await request('PATCH',`/api/admin/keys/${key.id}`,{allowed_models:[model],rate_limit_rpm:200}));
    json(await request('DELETE',`/api/admin/keys/${revoked.id}`));
    json(await request('POST','/api/admin/settings/token',{token:state.upstream}));
    await nativeSuccess();const rows=(await history()).rows;
    state.oldRow=json(await request('GET',`/api/admin/history/${rows[0].id}`));
    await db.backup('/app/data/seed-backup.db');
    const Database=(await import('better-sqlite3')).default;
    const backup=new Database('/app/data/seed-backup.db',{readonly:true,fileMustExist:true});
    try {assert.equal(backup.pragma('integrity_check',{simple:true}),'ok');assert.equal(backup.prepare('SELECT COUNT(*) AS n FROM request_log').get().n,1);} finally {backup.close();}
    state.backupDigest=digest('/app/data/seed-backup.db');
  } else {
    if(phase==='backup_restore_replay') {
      assert.equal(db.pragma('integrity_check',{simple:true}),'ok');
      assert.deepEqual(db.pragma('foreign_key_check'),[]);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM request_log').get().n,1);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM api_keys').get().n,2);
    }
    await history();
    if(phase==='baseline_restart'||phase==='baseline_rollback') {
      await nativeSuccess();
      if(phase==='baseline_rollback') {
        const before=providerCalls;assert.equal((await request('POST','/v1/responses',responseRequest(),state.key)).status,404);assert.equal(providerCalls,before);
      }
    } else if(phase==='candidate_mint') {
      providerMode='mint';const response=responseEvents(await request('POST','/v1/responses',responseRequest('synthetic seed',true),state.key));
      assert.equal(providerCalls,1);assert.deepEqual(response.output.map(i=>i.type),['reasoning','reasoning','reasoning','message']);
      for(const item of response.output.slice(0,3)) assert(item.encrypted_content.startsWith('ccpr1.'));
      state.output=response.output;state.historyCount++;await history();
    } else if(phase==='candidate_wrong_key') {
      const before=providerCalls;
      const input=[{role:'user',content:'synthetic seed'},...state.output,{role:'user',content:'synthetic continuation'}];
      const r=await request('POST','/v1/responses',responseRequest(input),state.key);
      assert.equal(r.status,409);assert.equal(JSON.parse(r.text).error.code,'invalid_reasoning_state');
      assert.equal(providerCalls,before);await history();
    } else await replay();
  }
  await policyChecks();assert.equal(fixtureFailure,false);
  assert.equal(providerCalls,phase==='candidate_wrong_key'?0:1);
  if(phase==='backup_restore_replay') {
    assert.equal(digest('/fixture-source/seed-backup.db'),sourceBackupDigest);
    assert.equal(digest('/fixture-source/lifecycle-fixture.json'),sourceFixtureDigest);
    assert.equal(digest('/fixture-source/proxy.db'),sourceLiveDigest);
  }
  state.completed.push(phase);save();
  log(JSON.stringify({phase,pass:true,provider_calls:providerCalls,history_rows:state.historyCount,
    old_history_exact:true,active_key_acl:true,revoked_key_rejected:true,no_stored_content:true,
    backup_integrity_checked:phase==='baseline_seed',state_replay_exact:phase.endsWith('_replay'),
    changed_key_rejected_before_provider:phase==='candidate_wrong_key',rollback_native_only:phase==='baseline_rollback',
    backup_restored:phase==='backup_restore_replay',restored_rows_before_request:phase==='backup_restore_replay'?1:0,
    post_backup_rows_absent:postBackupRowsAbsent,source_snapshot_unchanged:phase==='backup_restore_replay'}));
} catch {
  log(JSON.stringify({phase:phases.includes(phase)?phase:'invalid',pass:false,failure:stage}));process.exitCode=1;
} finally {
  clearTimeout(deadline);
  for(const server of [appServer,upstream]) if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  if(db?.open) db.close();
}
