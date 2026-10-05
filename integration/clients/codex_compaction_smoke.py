"""Actual pinned Codex app-server manual compaction through a local stock chain.

Synthetic only. No real credentials, file-tool calls, remote endpoints or OS setup.
Run using pristine stock LiteLLM 1.103.1 Python and an existing Codex 0.160.0.
"""
from __future__ import annotations
import argparse
import copy
import hashlib
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.metadata
import json
import os
from pathlib import Path
import queue
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import yaml
# Importing this guarded existing harness has no subprocess/network/main effects.
from codex_patch_smoke import ROOT, MODEL, SOURCE, clean_env, identities, start, stop, Fake as StreamFixture

TURN_MARKER = 'CODEX_COMPACTION_INITIAL_OK'
SUMMARY_MARKER = 'SYNTHETIC_COMPACTED_SUMMARY_ONLY'
FOLLOWUP_MARKER = 'CODEX_COMPACTION_FOLLOWUP_OK'
SECOND_FOLLOWUP_MARKER = 'CODEX_COMPACTION_SECOND_FOLLOWUP_OK'

class Fake(StreamFixture):
    def do_POST(self):
        size=int(self.headers.get('content-length','0'))
        if self.path!='/v1/messages' or size<1 or size>1024*1024 or len(self.server.requests)>=6:
            self.send_error(400); return
        raw=self.rfile.read(size); body=json.loads(raw)
        self.server.requests.append({'phase':self.server.phase,'body':body,
            'upstream_auth_exact':self.headers.get('x-api-key')=='sk-ant-local-fake-only' and not self.headers.get('authorization'),
            'credential_leak':any(k.encode() in raw or any(k in v for v in self.headers.values()) for k in self.server.local_keys)})
        if self.server.phase=='compact':
            self.stream([{'type':'text','text':SUMMARY_MARKER}], 'end_turn'); return
        if self.server.phase=='followup':
            self.server.followup_issued=[
                {'type':'thinking','thinking':'Synthetic post-compaction reasoning 🔧.','signature':'fixture-post-signed-nonempty+/='},
                {'type':'thinking','thinking':'','signature':'fixture-post-signed-empty+/='},
                {'type':'redacted_thinking','data':'fixture-post-redacted+/='},
                {'type':'text','text':FOLLOWUP_MARKER}]
            self.stream(self.server.followup_issued, 'end_turn'); return
        if self.server.phase=='followup_second':
            self.server.followup_replayed=copy.deepcopy(body)
            self.stream([{'type':'text','text':SECOND_FOLLOWUP_MARKER}], 'end_turn'); return
        results=[b for m in body.get('messages',[]) for b in m.get('content',[]) if isinstance(b,dict) and b.get('type')=='tool_result']
        if results:
            self.server.replayed=copy.deepcopy(body); self.stream([{'type':'text','text':TURN_MARKER}],'end_turn'); return
        if 'get_goal' not in [t.get('name') for t in body.get('tools',[])]:
            self.server.failure='safe_get_goal_not_offered'; self.send_error(400); return
        self.server.issued=[{'type':'thinking','thinking':'Synthetic compaction reasoning 🔧.','signature':'fixture-signed-nonempty+/='},
                            {'type':'thinking','thinking':'','signature':'fixture-signed-empty+/='},
                            {'type':'redacted_thinking','data':'fixture-redacted+/='},
                            {'type':'tool_use','id':'toolu_fixture_goal','name':'get_goal','input':{}}]
        self.stream(self.server.issued,'tool_use')

class Observer(BaseHTTPRequestHandler):
    def log_message(self,*_): pass
    def do_POST(self):
        size=int(self.headers.get('content-length','0'))
        if self.path!='/compact-fixture/v1/responses' or size<1 or size>1024*1024 or len(self.server.records)>=6:
            self.send_error(400); return
        raw=self.rfile.read(size); record={'phase':self.server.fake.phase,'request':json.loads(raw),'response_sse':''}; self.server.records.append(record)
        conn=http.client.HTTPConnection('127.0.0.1',self.server.target_port,timeout=30)
        try:
            headers={k:v for k,v in self.headers.items() if k.lower() not in {'host','connection','transfer-encoding','accept-encoding'}}
            headers['accept-encoding']='identity'; conn.request('POST',self.path,raw,headers); response=conn.getresponse()
            record['status']=response.status; self.send_response(response.status)
            for name,value in response.getheaders():
                if name.lower() not in {'connection','transfer-encoding','content-length','server','date'}: self.send_header(name,value)
            self.send_header('connection','close'); self.end_headers(); wire=bytearray()
            while chunk:=response.read1(8192):
                wire.extend(chunk)
                if len(wire)>4*1024*1024: raise RuntimeError('Fixture response bound exceeded')
                self.wfile.write(chunk); self.wfile.flush()
            record['response_sse']=wire.decode('utf-8')
        finally: conn.close()

class Rpc:
    """Bounded stdio client. Unexpected server requests are never approved/executed."""
    def __init__(self,cmd,env,cwd):
        self.child=subprocess.Popen(cmd,env=env,cwd=cwd,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
            text=True,encoding='utf-8',errors='replace',creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
        self.queue=queue.Queue(); self.events=[]; self.sent=[]; self.stderr=[]; self.total=0; self.problem=None; self.pending=[]
        def stdout():
            for line in self.child.stdout:
                self.total+=len(line.encode())
                if self.total>5*1024*1024 or len(self.events)>=1500:
                    self.problem='RPC observation bound exceeded'; self.child.terminate(); break
                try: value=json.loads(line)
                except ValueError: self.problem='Non-JSON app-server stdout'; self.child.terminate(); break
                self.events.append(value); self.queue.put(value)
        def stderr():
            for line in self.child.stderr:
                if sum(map(len,self.stderr))+len(line)<1024*1024: self.stderr.append(line)
        self.readers=[threading.Thread(target=stdout,daemon=True),threading.Thread(target=stderr,daemon=True)]
        for reader in self.readers: reader.start()
    def send(self,value):
        self.sent.append(copy.deepcopy(value)); self.child.stdin.write(json.dumps(value)+'\n'); self.child.stdin.flush()
    def wait(self,predicate,timeout=30):
        for index,value in enumerate(self.pending):
            if predicate(value): return self.pending.pop(index)
        deadline=time.monotonic()+timeout
        while time.monotonic()<deadline:
            if self.problem: raise RuntimeError(self.problem)
            try: value=self.queue.get(timeout=.2)
            except queue.Empty:
                if self.child.poll() is not None: raise RuntimeError('App-server exited before expected event')
                continue
            if value.get('method') and 'id' in value:
                # Fail closed for permission, interactive, attestation, external
                # tool or other server-initiated work; fake requests get_goal only.
                self.send({'id':value['id'],'error':{'code':-32601,'message':'Synthetic fixture refuses server-initiated actions'}})
                raise RuntimeError('Unexpected app-server action request')
            if predicate(value): return value
            # RPC acknowledgements and notifications can race. Preserve unmatched
            # messages so a completion received before its RPC result isn't lost.
            self.pending.append(value)
        raise RuntimeError('Bounded app-server event timeout')
    def request(self,request_id,method,params):
        self.send({'id':request_id,'method':method,'params':params})
        value=self.wait(lambda value:value.get('id')==request_id)
        if 'error' in value: raise RuntimeError('App-server RPC rejected '+method+': '+json.dumps(value['error']))
        return value['result']
    def completed(self,thread_id):
        return self.wait(lambda v:v.get('method')=='turn/completed' and v.get('params',{}).get('threadId')==thread_id,45)
    def close(self):
        stop(self.child)
        for reader in self.readers: reader.join(3)
        for stream in [self.child.stdin,self.child.stdout,self.child.stderr]: stream.close()

def assistant(body):
    return [b for m in (body or {}).get('messages',[]) if m.get('role')=='assistant' for b in m.get('content',[]) if isinstance(b,dict)]

def fixture_text_blocks(value):
    """Independent, deliberately text-only oracle for this synthetic fixture.

    Unknown content must fail the evidence check, not be silently skipped. This
    is not a production protocol converter; only the fixture's observed shapes
    are accepted. Preserve duplicated text and cache fields exactly.
    """
    if isinstance(value,str): return [{'type':'text','text':value}]
    if not isinstance(value,list): raise ValueError('Fixture expected text content')
    result=[]
    for block in value:
        if not isinstance(block,dict) or block.get('type') not in {'input_text','output_text','text'} or not isinstance(block.get('text'),str):
            raise ValueError('Fixture encountered unsupported content')
        result.append({'type':'text','text':block['text'],**({'cache_control':copy.deepcopy(block['cache_control'])} if 'cache_control' in block else {})})
    return result

def fixture_system(request):
    blocks=[]
    if request.get('instructions') is not None:
        if not isinstance(request['instructions'],str): raise ValueError('Fixture expected text instructions')
        blocks.append({'type':'text','text':request['instructions']})
    for item in request.get('input',[]):
        if item.get('type','message')=='message' and item.get('role') in {'system','developer'}:
            blocks.extend(fixture_text_blocks(item['content']))
    return blocks

def fixture_conversation(request):
    """Ordered plain text/tool blocks, excluding separately checked sealed state."""
    result=[]
    for item in request.get('input',[]):
        kind=item.get('type','message')
        if kind=='message':
            if item.get('role') in {'system','developer'}: continue
            if item.get('role') not in {'user','assistant'}: raise ValueError('Fixture encountered unsupported role')
            result.extend({'role':item['role'],'block':block} for block in fixture_text_blocks(item['content']))
        elif kind=='reasoning': continue
        elif kind=='function_call':
            if item.get('name')!='get_goal' or item.get('namespace') is not None: raise ValueError('Fixture encountered unsafe tool')
            result.append({'role':'assistant','block':{'type':'tool_use','id':item['call_id'],'name':'get_goal','input':json.loads(item['arguments'])}})
        elif kind=='function_call_output':
            value=item['output']; block={'type':'tool_result','tool_use_id':item['call_id'],'content':value if isinstance(value,str) else fixture_text_blocks(value)}
            if 'is_error' in item: block['is_error']=item['is_error']
            result.append({'role':'user','block':block})
        else: raise ValueError('Fixture encountered unsupported input item')
    return result

def native_conversation(body):
    return [{'role':message['role'],'block':block} for message in body.get('messages',[]) for block in message.get('content',[])
            if block.get('type') not in {'thinking','redacted_thinking'}]

def projection_checks(records,upstream):
    """Pair every successful request by phase and occurrence, not one sample."""
    successful=[record for record in records if record.get('status')==200]
    if len(successful)!=len(upstream): return []
    checks=[]
    for record,native in zip(successful,upstream):
        request=record['request']; body=native['body']
        try:
            checks.append({'phase':record['phase'],'phase_exact':record['phase']==native['phase'],
                'system_exact':body.get('system',[])==fixture_system(request),
                'conversation_order_exact':native_conversation(body)==fixture_conversation(request)})
        except (KeyError,TypeError,ValueError):
            checks.append({'phase':record['phase'],'oracle_rejected_shape':True})
    return checks

def wire_reasoning(record):
    events=[json.loads(line[6:]) for line in record['response_sse'].splitlines() if line.startswith('data: ') and line[6:]!='[DONE]']
    done=[e['item'] for e in events if e.get('type')=='response.output_item.done' and e.get('item',{}).get('type')=='reasoning']
    complete=[i for e in events if e.get('type')=='response.completed' for i in e['response'].get('output',[]) if i.get('type')=='reasoning']
    return done,complete

def capsules(items):
    return [(i.get('id'),i.get('encrypted_content')) for i in items if i.get('type')=='reasoning']

def system_digest(body):
    return hashlib.sha256(json.dumps(body.get('system',[]),ensure_ascii=False,separators=(',',':')).encode()).hexdigest()

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--codex',type=Path,required=True); parser.add_argument('--node',type=Path)
    parser.add_argument('--output',type=Path,required=True); parser.add_argument('--expect',choices=['capture','success'],default='success',help='Explicit capture mode allows a correctly observed adapter failure, never labels it success')
    parser.add_argument('--developer-message-mode',choices=['reject','hoist'],default='reject',help='Proxy-only test configuration; never modifies Codex or LiteLLM')
    args=parser.parse_args(); output=args.output.resolve(); temp=Path(tempfile.gettempdir()).resolve()
    if output.exists() or temp not in output.parents or ROOT in output.parents: raise SystemExit('Use a NEW system-temp child outside the repository')
    output.mkdir(parents=True); workspace=output/'workspace'; workspace.mkdir(); home=output/'codex-state'; home.mkdir()
    codex=args.codex.resolve(strict=True); node=args.node.resolve(strict=True) if args.node else shutil.which('node')
    if not node: raise SystemExit('Existing node required')
    report={'scope':'actual Codex app-server manual local compaction -> pristine stock authenticated passthrough -> actual Responses relay -> loopback fake',
            'developer_message_mode':args.developer_message_mode,
            'source_commit':SOURCE,'litellm_version':importlib.metadata.version('litellm'),'before':identities(),'not_tested':[
                'automatic token-threshold compaction','remote /responses/compact','long sessions','resume after process restart',
                'semantic equivalence of late developer versus top-level system','real-provider signatures/authorization/cost/cache hits',
                'actual .7 gateway or .64 deployment','OS-enforced total network isolation']}
    report['repository_head']=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()
    report['built_request_adapter_sha256']=hashlib.sha256((ROOT/'dist/services/responsesRequest.js').read_bytes()).hexdigest()
    report['codex_version']=subprocess.check_output([str(codex),'--version'],env=clean_env(output),text=True).strip()
    with codex.open('rb') as file: report['codex_sha256']=hashlib.file_digest(file,'sha256').hexdigest()
    if report['codex_version']!='codex-cli 0.160.0' or report['litellm_version']!='1.103.1': raise SystemExit('Pinned runtime/client required')
    gateway_key='sk-local-fixture-'+secrets.token_hex(24); relay_key=None
    def redact(text):
        for key in [gateway_key,relay_key]:
            if key: text=text.replace(key,'[LOCAL_FIXTURE_KEY]')
        return text
    fake=ThreadingHTTPServer(('127.0.0.1',0),Fake); fake.requests=[]; fake.phase='initial'; fake.failure=None; fake.issued=[]; fake.replayed=None; fake.local_keys=[gateway_key]
    fake.followup_issued=[]; fake.followup_replayed=None
    fake_thread=threading.Thread(target=fake.serve_forever,daemon=True); fake_thread.start(); children=[]; observer=None; rpc=None
    try:
        def relay_ready(line):
            try:
                value=json.loads(line); port=value.get('local_relay_port'); key=value.get('local_relay_key')
                if isinstance(port,int) and not isinstance(port,bool) and 0<port<=65535 and isinstance(key,str) and key.startswith('sk-'): return value
            except ValueError: pass
        child,thread,logs,ready=start([str(node),str(ROOT/'integration/clients/boot_responses_relay.mjs'),'http://127.0.0.1:'+str(fake.server_port),args.developer_message_mode],clean_env(output),output,relay_ready,20)
        children.append((child,thread,logs,'relay.log')); relay_key=ready['local_relay_key']; fake.local_keys.append(relay_key)
        config={'litellm_settings':{'telemetry':False,'num_retries':0,'callbacks':[]},'router_settings':{'num_retries':0},
            'general_settings':{'master_key':'os.environ/LOCAL_GATEWAY_KEY','pass_through_endpoints':[{
                'path':'/compact-fixture/v1/responses','target':'http://127.0.0.1:'+str(ready['local_relay_port'])+'/v1/responses','auth':True,'methods':['POST'],
                'forward_headers':True,'headers':{'Authorization':'os.environ/LOCAL_RELAY_AUTHORIZATION','x-api-key':''}}]}}
        gateway_config=output/'gateway.yaml'; gateway_config.write_text(yaml.safe_dump(config),encoding='utf-8')
        env=clean_env(output); env.update(CONFIG_FILE_PATH=str(gateway_config),LOCAL_GATEWAY_KEY=gateway_key,LOCAL_RELAY_AUTHORIZATION='Bearer '+relay_key,LITELLM_LOCAL_MODEL_COST_MAP='True')
        child,thread,logs,port=start([sys.executable,str(ROOT/'integration/litellm/boot_gateway.py')],env,output,
            lambda line:int(line.strip().split('=')[1]) if line.startswith('LOCAL_GATEWAY_PORT=') else None,45)
        children.append((child,thread,logs,'gateway.log')); deadline=time.monotonic()+30; opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
        while True:
            try: opener.open('http://127.0.0.1:'+str(port)+'/health/liveliness',timeout=.5).close(); break
            except Exception:
                if time.monotonic()>deadline: raise RuntimeError('Gateway startup deadline')
                time.sleep(.2)
        observer=ThreadingHTTPServer(('127.0.0.1',0),Observer); observer.target_port=port; observer.records=[]; observer.fake=fake
        observer_thread=threading.Thread(target=observer.serve_forever,daemon=True); observer_thread.start()
        # This model-only catalog is a synthetic fixture capability declaration,
        # never actual Claude/GPT model metadata or a callable history schema.
        catalog={'models':[{'slug':MODEL,'display_name':'Synthetic compaction fixture (NOT real Claude metadata)',
            'supported_reasoning_levels':[],'shell_type':'disabled','visibility':'list','supported_in_api':True,'priority':0,
            'support_verbosity':False,'apply_patch_tool_type':None,'truncation_policy':{'mode':'bytes','limit':100000},
            'experimental_supported_tools':[],'base_instructions':'Synthetic protocol test: only the no-I/O get_goal tool may be invoked. No commands, files, network or external tools.',
            'supports_reasoning_summary_parameter':False,'input_modalities':['text']}]}
        catalog_path=output/'model-catalog.json'; catalog_path.write_text(json.dumps(catalog,indent=2),encoding='utf-8')
        client_env=clean_env(output); client_env.update(CODEX_HOME=str(home),CODEX_FIXTURE_KEY=gateway_key,RUST_LOG='error')
        overrides={'model_provider':'fixture','model':MODEL,'model_catalog_json':str(catalog_path),'sandbox_mode':'read-only',
            'approval_policy':'never','web_search':'disabled','analytics.enabled':False,'feedback.enabled':False,'check_for_update_on_startup':False,
            'otel.exporter':'none','otel.trace_exporter':'none','agents.enabled':False,'cli_auth_credentials_store':'file',
            'model_providers.fixture.name':'Local synthetic fixture','model_providers.fixture.base_url':'http://127.0.0.1:'+str(observer.server_port)+'/compact-fixture/v1',
            'model_providers.fixture.wire_api':'responses','model_providers.fixture.env_key':'CODEX_FIXTURE_KEY','model_providers.fixture.requires_openai_auth':False,
            'model_providers.fixture.supports_websockets':False,'model_providers.fixture.request_max_retries':0,'model_providers.fixture.stream_max_retries':0,
            'model_providers.fixture.stream_idle_timeout_ms':15000}
        cmd=[str(codex),'app-server','--stdio']
        for name,value in overrides.items(): cmd+=['-c',name+'='+json.dumps(value)]
        rpc=Rpc(cmd,client_env,workspace)
        rpc.request(0,'initialize',{'clientInfo':{'name':'local_compaction_fixture','title':'Synthetic local-only fixture','version':'1.0'},'capabilities':{'experimentalApi':True}})
        rpc.send({'method':'initialized','params':{}})
        thread=rpc.request(1,'thread/start',{'model':MODEL,'modelProvider':'fixture','cwd':str(workspace),'approvalPolicy':'never','sandbox':'read-only','ephemeral':False})
        thread_id=thread['thread']['id']; report['thread_start']=thread
        rpc.request(2,'turn/start',{'threadId':thread_id,'input':[{'type':'text','text':'Synthetic protocol test: use only get_goal. Never access files, run commands, network or external tools. Finish with '+TURN_MARKER+'.'}]})
        report['initial_turn_terminal']=rpc.completed(thread_id)
        if report['initial_turn_terminal'].get('params',{}).get('turn',{}).get('status')!='completed': raise RuntimeError('Initial synthetic tool turn failed')
        fake.phase='compact'; report['compact_rpc_result']=rpc.request(3,'thread/compact/start',{'threadId':thread_id})
        report['compact_turn_terminal']=rpc.completed(thread_id)
        compact_status=report['compact_turn_terminal'].get('params',{}).get('turn',{}).get('status')
        if compact_status=='completed':
            fake.phase='followup'
            rpc.request(4,'turn/start',{'threadId':thread_id,'input':[{'type':'text','text':'Synthetic continuation. Do not use any tools, files, commands or network. Finish with '+FOLLOWUP_MARKER+'.'}]})
            report['followup_turn_terminal']=rpc.completed(thread_id)
            if args.developer_message_mode=='hoist' and report['followup_turn_terminal'].get('params',{}).get('turn',{}).get('status')=='completed':
                fake.phase='followup_second'
                rpc.request(5,'turn/start',{'threadId':thread_id,'input':[{'type':'text','text':'Second synthetic continuation. Do not use any tools, files, commands or network. Finish with '+SECOND_FOLLOWUP_MARKER+'.'}]})
                report['second_followup_turn_terminal']=rpc.completed(thread_id)
    except Exception as error:
        report['harness_error']=redact(str(error))[:2048]
    finally:
        if rpc:
            rpc.close(); (output/'app-server-events.jsonl').write_text(redact('\n'.join(json.dumps(e,ensure_ascii=False) for e in rpc.events)+'\n'),encoding='utf-8')
            (output/'app-server-sent.json').write_text(redact(json.dumps(rpc.sent,indent=2)),encoding='utf-8')
            (output/'client-stderr.log').write_text(redact(''.join(rpc.stderr)),encoding='utf-8')
        if observer: observer.shutdown(); observer.server_close(); observer_thread.join(3)
        for child,thread,logs,name in reversed(children): stop(child); thread.join(3); child.stdout.close(); (output/name).write_text(redact(''.join(logs)),encoding='utf-8')
        fake.shutdown(); fake.server_close(); fake_thread.join(3)
        report['after']=identities(); report['stock_unchanged']=report['before']==report['after']
        records=observer.records if observer else []; compact=[r for r in records if r['phase']=='compact']; upstream_compact=[r for r in fake.requests if r['phase']=='compact']
        report['responses_requests']=len(records); report['upstream_requests']=len(fake.requests); report['fixture_failure']=fake.failure
        report['ordered_initial_assistant_exact']=bool(fake.issued) and assistant(fake.replayed)==fake.issued
        def results(body): return [b for m in (body or {}).get('messages',[]) for b in m.get('content',[]) if isinstance(b,dict) and b.get('type')=='tool_result']
        initial_results=results(fake.replayed)
        report['initial_tool_result_replayed']=len(initial_results)==1 and initial_results[0].get('tool_use_id')=='toolu_fixture_goal'
        report['initial_tool_result']=initial_results[0] if len(initial_results)==1 else None
        try: goal_result=json.loads(initial_results[0]['content']) if len(initial_results)==1 else None
        except (ValueError,KeyError,TypeError): goal_result=None
        report['initial_tool_success']=report['initial_tool_result_replayed'] and not initial_results[0].get('is_error',False) and goal_result=={'goal':None,'remainingTokens':None,'completionBudgetReport':None}
        report['compact_request_shapes']=[{'model':r['request'].get('model'),'tools_count':len(r['request'].get('tools',[])),
            'input_item_types':[i.get('type') for i in r['request'].get('input',[]) if isinstance(i,dict)],
            'message_roles':[i.get('role') for i in r['request'].get('input',[]) if isinstance(i,dict) and i.get('type')=='message'],
            'include':r['request'].get('include'),'stream':r['request'].get('stream'),'status':r.get('status'),'response':r['response_sse'] if r.get('status')!=200 else None} for r in compact]
        report['compact_native_tools_absent']=bool(upstream_compact) and all('tools' not in r['body'] for r in upstream_compact)
        report['compact_native_assistant_prefix_exact']=bool(upstream_compact) and assistant(upstream_compact[0]['body'])[:len(fake.issued)]==fake.issued
        report['compact_native_tool_result_exact']=bool(upstream_compact) and results(upstream_compact[0]['body'])==initial_results
        done,complete=wire_reasoning(records[0]) if records else ([],[])
        initial_replay=capsules(records[1]['request'].get('input',[])) if len(records)>1 else []
        compact_replay=capsules(compact[0]['request'].get('input',[])) if compact else []
        report['reasoning_done_completed_initial_and_compact_replay_exact']=len(done)==3 and all(i.get('encrypted_content') for i in done) and capsules(done)==capsules(complete)==initial_replay==compact_replay
        followup=[r for r in records if r['phase']=='followup']
        second_followup=[r for r in records if r['phase']=='followup_second']
        initial_wire_requests=[r for r in records if r['phase']=='initial']; initial_upstream=[r for r in fake.requests if r['phase']=='initial']
        followup_upstream=[r for r in fake.requests if r['phase']=='followup']
        second_followup_upstream=[r for r in fake.requests if r['phase']=='followup_second']
        hoist=args.developer_message_mode=='hoist'
        report['no_hidden_retries']=len(initial_wire_requests)==2 and len(initial_upstream)==2 and len(compact)==1 and len(upstream_compact)==1 and len(followup)==1 and (
            len(followup_upstream)==1 and len(second_followup)==1 and len(second_followup_upstream)==1 and len(records)==5 and len(fake.requests)==5 if hoist else
            len(followup_upstream)==0 and len(second_followup)==0 and len(second_followup_upstream)==0 and len(records)==4 and len(fake.requests)==3)
        report['further_user_turn']=bool(followup)
        report['followup_request_shapes']=[{'input_item_types':[i.get('type') for i in r['request'].get('input',[]) if isinstance(i,dict)],
            'message_roles':[i.get('role') for i in r['request'].get('input',[]) if isinstance(i,dict) and i.get('type')=='message'],
            'phase':r['phase'],'status':r.get('status'),'response':r['response_sse'] if r.get('status')!=200 else None} for r in followup+second_followup]
        post_roles=[shape['message_roles'] for shape in report['followup_request_shapes']]
        report['post_compaction_late_developer_shape_exact']=post_roles==[
            ['user','user','developer','user','user'],
            ['user','user','developer','user','user','assistant','user']]
        report['request_projection_checks']=projection_checks(records,fake.requests)
        report['all_forwarded_system_blocks_exact']=len(report['request_projection_checks'])==len(fake.requests)>0 and all(c.get('phase_exact') and c.get('system_exact') for c in report['request_projection_checks'])
        report['all_forwarded_text_and_tool_order_exact']=len(report['request_projection_checks'])==len(fake.requests)>0 and all(c.get('phase_exact') and c.get('conversation_order_exact') for c in report['request_projection_checks'])
        report['pre_compaction_system_sha256']=system_digest(upstream_compact[0]['body']) if upstream_compact else None
        report['post_compaction_system_sha256']=[system_digest(r['body']) for r in followup_upstream+second_followup_upstream]
        report['pre_post_compaction_system_equal']=upstream_compact[0]['body'].get('system',[])==followup_upstream[0]['body'].get('system',[]) if upstream_compact and followup_upstream else None
        report['post_compaction_system_stable']=len(followup_upstream)==1 and len(second_followup_upstream)==1 and followup_upstream[0]['body'].get('system',[])==second_followup_upstream[0]['body'].get('system',[])
        followup_done,followup_complete=wire_reasoning(followup[0]) if len(followup)==1 and followup[0].get('status')==200 else ([],[])
        second_replay=capsules(second_followup[0]['request'].get('input',[])) if len(second_followup)==1 else []
        report['post_compaction_reasoning_done_completed_replay_exact']=len(followup_done)==3 and all(i.get('encrypted_content') for i in followup_done) and capsules(followup_done)==capsules(followup_complete)==second_replay
        report['post_compaction_ordered_native_assistant_exact']=bool(fake.followup_issued) and assistant(fake.followup_replayed)==fake.followup_issued
        report['post_compaction_first_input_has_no_old_reasoning']=len(followup)==1 and not capsules(followup[0]['request'].get('input',[]))
        report['upstream_auth_exact']=bool(fake.requests) and all(r['upstream_auth_exact'] for r in fake.requests); report['credential_leak']=any(r['credential_leak'] for r in fake.requests)
        notifications=rpc.events if rpc else []
        report['context_compaction_started']=any(e.get('method')=='item/started' and e.get('params',{}).get('item',{}).get('type')=='contextCompaction' for e in notifications)
        report['context_compaction_completed']=any(e.get('method')=='item/completed' and e.get('params',{}).get('item',{}).get('type')=='contextCompaction' for e in notifications)
        report['compact_status']=report.get('compact_turn_terminal',{}).get('params',{}).get('turn',{}).get('status')
        report['followup_status']=report.get('followup_turn_terminal',{}).get('params',{}).get('turn',{}).get('status')
        report['second_followup_status']=report.get('second_followup_turn_terminal',{}).get('params',{}).get('turn',{}).get('status')
        report['followup_final_exact']=any(e.get('method')=='item/completed' and e.get('params',{}).get('item',{}).get('type')=='agentMessage' and e['params']['item'].get('text')==FOLLOWUP_MARKER for e in notifications)
        report['second_followup_final_exact']=any(e.get('method')=='item/completed' and e.get('params',{}).get('item',{}).get('type')=='agentMessage' and e['params']['item'].get('text')==SECOND_FOLLOWUP_MARKER for e in notifications)
        report['workspace_files']=sorted(str(p.relative_to(workspace)) for p in workspace.rglob('*') if p.is_file())
        report['capture_completed']=not report.get('harness_error') and report['stock_unchanged'] and report['fixture_failure'] is None and report['ordered_initial_assistant_exact'] and report['initial_tool_result_replayed'] and len(compact)==1 and report['compact_status'] in {'completed','failed'} and report['upstream_auth_exact'] and not report['credential_leak'] and report['workspace_files']==[]
        report['local_compaction_subset_pass']=report['capture_completed'] and len(initial_wire_requests)==2 and len(initial_upstream)==2 and len(upstream_compact)==1 and report['initial_tool_success'] and report['compact_status']=='completed' and report['context_compaction_started'] and report['context_compaction_completed'] and report['compact_native_tools_absent'] and report['compact_native_assistant_prefix_exact'] and report['compact_native_tool_result_exact'] and report['reasoning_done_completed_initial_and_compact_replay_exact']
        report['post_compaction_continuation_pass']=hoist and report['further_user_turn'] and report['followup_status']=='completed' and report['followup_final_exact'] and report['second_followup_status']=='completed' and report['second_followup_final_exact'] and report['post_compaction_late_developer_shape_exact'] and report['post_compaction_system_stable'] and report['post_compaction_reasoning_done_completed_replay_exact'] and report['post_compaction_ordered_native_assistant_exact'] and report['post_compaction_first_input_has_no_old_reasoning'] and report['all_forwarded_system_blocks_exact'] and report['all_forwarded_text_and_tool_order_exact']
        report['full_session_pass']=report['local_compaction_subset_pass'] and report['post_compaction_continuation_pass'] and report['no_hidden_retries']
        report['expected_late_developer_rejection']=not hoist and report['local_compaction_subset_pass'] and report['no_hidden_retries'] and len(fake.requests)==3 and report['followup_status']=='failed' and len(followup)==1 and followup[0].get('status')==400 and report['followup_request_shapes'][0]['message_roles']==['user','user','developer','user','user'] and '"code":"unsupported_parameter"' in followup[0]['response_sse']
        (output/'fake-requests.json').write_text(redact(json.dumps(fake.requests,indent=2)),encoding='utf-8'); (output/'responses-wire.json').write_text(redact(json.dumps(records,indent=2)),encoding='utf-8')
        (output/'codex-compaction-smoke.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(json.dumps({k:report[k] for k in ['developer_message_mode','capture_completed','local_compaction_subset_pass','post_compaction_continuation_pass','full_session_pass','expected_late_developer_rejection','responses_requests','upstream_requests','compact_status','compact_request_shapes','followup_request_shapes','all_forwarded_system_blocks_exact','all_forwarded_text_and_tool_order_exact','pre_post_compaction_system_equal','post_compaction_system_stable','post_compaction_reasoning_done_completed_replay_exact','post_compaction_ordered_native_assistant_exact']},indent=2)); print('Report:',output/'codex-compaction-smoke.json')
    return 0 if report['full_session_pass'] or args.expect=='capture' and report['expected_late_developer_rejection'] else 1

if __name__=='__main__': raise SystemExit(main())
