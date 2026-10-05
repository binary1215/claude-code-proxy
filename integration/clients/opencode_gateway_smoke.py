"""Pinned actual OpenCode -> stock LiteLLM -> native relay -> loopback fake.

Synthetic keys and one exact-read temp fixture only. No real provider, existing
credentials/config, source patch, global install or OS setup. Strict by default.
"""
from __future__ import annotations
import argparse
import base64
import copy
import hashlib
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.metadata
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import yaml
sys.dont_write_bytecode=True
from codex_patch_smoke import ROOT, clean_env, identities, start, stop, event

MODEL='claude-sonnet-4-6'
FIXTURE='SYNTHETIC_LOCAL_FIXTURE_7f352a'
MARKER='OPENCODE_GATEWAY_FIXTURE_COMPLETE'
ZIP_SHA256='f89ab2720050780a450e3cf3e48ac3f0409235b46b6c548c69aa2b7051d716f4'
BINARY_SHA256='184f196ec97c843a64b2e1a2b49165f25e73a5d6993e2f842c9958c2b1f7a5b2'
SOURCE='aec0b9a6d8898f68f923aaf08b7306d931fd9d76'
ROUTE='/opencode-native/v1/messages'

def blocks(body,role=None):
    return [b for m in (body or {}).get('messages',[]) if role is None or m.get('role')==role
            for b in m.get('content',[]) if isinstance(b,dict)]

class Fake(BaseHTTPRequestHandler):
    def log_message(self,*_): pass
    def do_POST(self):
        size=int(self.headers.get('content-length','0'))
        if self.path!='/v1/messages' or size<1 or size>1024*1024 or len(self.server.requests)>=2:
            self.server.failure='unexpected_path_size_or_retry'; self.send_error(400); return
        raw=self.rfile.read(size)
        try: body=json.loads(raw)
        except ValueError: self.server.failure='invalid_json'; self.send_error(400); return
        record={'body':body,'upstream_auth_exact':self.headers.get('x-api-key')=='sk-ant-local-fake-only' and not self.headers.get('authorization'),
                'credential_leak':any(k.encode() in raw or any(k in v for v in self.headers.values()) for k in self.server.local_keys)}
        self.server.requests.append(record); self.server.raw_requests.append(raw); self.server.betas.append(self.headers.get('anthropic-beta'))
        if body.get('model')!=MODEL or body.get('stream') is not True or [t.get('name') for t in body.get('tools',[])]!=['read']:
            self.server.failure='exact_model_stream_only_read_required'; self.send_error(400); return
        if any(b.get('type')=='tool_result' for b in blocks(body)):
            self.server.replayed=copy.deepcopy(body); self.stream([{'type':'text','text':MARKER}],'end_turn'); return
        signature=base64.b64encode(b'synthetic-signature-opencode-fixture').decode()
        content=[{'type':'thinking','thinking':'Synthetic reasoning: 한글 🧪 only.','signature':signature}]
        if self.server.mode=='full_opaque':
            content += [{'type':'thinking','thinking':'','signature':base64.b64encode(b'synthetic-empty-signature-opencode-fixture').decode()},
                        {'type':'redacted_thinking','data':base64.b64encode(b'synthetic-redacted-opencode-fixture').decode()}]
        content += [{'type':'tool_use','id':'toolu_fake_opencode_01','name':'read','input':{'filePath':str(self.server.fixture),'offset':1,'limit':1}}]
        self.server.issued=copy.deepcopy(content); self.stream(content,'tool_use')
    def stream(self,content,reason):
        message={'id':'msg_fake_opencode_01','type':'message','role':'assistant','model':MODEL,'content':[],
                 'stop_reason':None,'stop_sequence':None,'usage':{'input_tokens':16,'output_tokens':0}}
        wire=event('message_start',{'type':'message_start','message':message})
        for index,block in enumerate(content):
            kind=block['type']
            initial={'type':'thinking','thinking':''} if kind=='thinking' else {**block,'input':{}} if kind=='tool_use' else {'type':'text','text':''} if kind=='text' else block
            wire+=event('content_block_start',{'type':'content_block_start','index':index,'content_block':initial}); deltas=[]
            if kind=='thinking':
                text=block['thinking']; deltas += [{'type':'thinking_delta','thinking':p} for p in [text[:22],text[22:]] if p]
                if not text: deltas.append({'type':'thinking_delta','thinking':''})
                signature=block['signature']; parts=[signature] if self.server.signatures=='single' else [signature[:8],signature[8:]]
                deltas += [{'type':'signature_delta','signature':p} for p in parts]
            elif kind=='tool_use':
                text=json.dumps(block['input'],ensure_ascii=False); deltas += [{'type':'input_json_delta','partial_json':p} for p in [text[:19],text[19:]]]
            elif kind=='text': deltas=[{'type':'text_delta','text':block['text']}]
            for delta in deltas: wire+=event('content_block_delta',{'type':'content_block_delta','index':index,'delta':delta})
            wire+=event('content_block_stop',{'type':'content_block_stop','index':index})
        wire+=event('message_delta',{'type':'message_delta','delta':{'stop_reason':reason,'stop_sequence':None},'usage':{'output_tokens':24 if reason=='tool_use' else 4}})
        wire+=event('message_stop',{'type':'message_stop'}); self.server.wires.append(wire)
        self.send_response(200); self.send_header('content-type','text/event-stream'); self.send_header('content-length',str(len(wire))); self.end_headers()
        for index in range(0,len(wire),7):
            self.wfile.write(wire[index:index+7]); self.wfile.flush(); time.sleep(.001)

class Observer(BaseHTTPRequestHandler):
    """Raw local observer plus rejecting incidental network proxy/npm registry."""
    def log_message(self,*_): pass
    def block(self):
        path=self.path
        kind='offlineRegistry' if path.startswith('/offline-npm/') else 'officialModels' if 'models.opencode.ai' in path or 'models.dev' in path else 'officialRelease' if 'github.com' in path else 'other'
        self.server.blocked[kind]=self.server.blocked.get(kind,0)+1
        self.send_response(502); self.send_header('connection','close'); self.send_header('content-length','0'); self.end_headers(); self.close_connection=True
    do_CONNECT=do_GET=do_PUT=do_DELETE=do_PATCH=do_OPTIONS=do_HEAD=block
    def do_POST(self):
        size=int(self.headers.get('content-length','0'))
        if self.path!=ROUTE: self.block(); return
        if size<1 or size>1024*1024 or len(self.server.records)>=2:
            self.server.failure='unexpected_size_or_retry'; self.send_error(400); return
        raw=self.rfile.read(size); body=json.loads(raw)
        record={'body':body,'client_gateway_auth_exact':self.headers.get('x-api-key')==self.server.gateway_key and not self.headers.get('authorization'),'status':None}
        self.server.records.append(record); self.server.raw_requests.append(raw); self.server.betas.append(self.headers.get('anthropic-beta'))
        conn=http.client.HTTPConnection('127.0.0.1',self.server.target_port,timeout=30)
        try:
            headers={k:v for k,v in self.headers.items() if k.lower() not in {'host','connection','transfer-encoding','accept-encoding'}}
            headers['accept-encoding']='identity'; conn.request('POST',self.path,raw,headers); response=conn.getresponse(); record['status']=response.status; self.send_response(response.status)
            for name,value in response.getheaders():
                if name.lower() not in {'connection','transfer-encoding','content-length','server','date'}: self.send_header(name,value)
            self.send_header('connection','close'); self.end_headers(); wire=bytearray()
            while chunk:=response.read1(8192):
                wire.extend(chunk)
                if len(wire)>4*1024*1024: raise RuntimeError('Response observer bound exceeded')
                self.wfile.write(chunk); self.wfile.flush()
            self.server.wires.append(bytes(wire))
        finally: conn.close()

def client_env(folder,binary,node,fixture,origin,key):
    env={k:v for k,v in os.environ.items() if k.upper() in {'SYSTEMROOT','WINDIR','COMSPEC','PATHEXT'}}
    for name in ['home','config','data','cache','state','tmp','appdata','localappdata','programdata']: (folder/name).mkdir()
    system=os.environ.get('SystemRoot',os.environ.get('SYSTEMROOT','C:/Windows'))
    env.update(PATH=os.pathsep.join([str(binary.parent),str(Path(node).parent),str(Path(system)/'System32')]),
        USERPROFILE=str(folder/'home'),HOME=str(folder/'home'),OPENCODE_TEST_HOME=str(folder/'home'),
        APPDATA=str(folder/'appdata'),LOCALAPPDATA=str(folder/'localappdata'),ProgramData=str(folder/'programdata'),
        XDG_CONFIG_HOME=str(folder/'config'),XDG_DATA_HOME=str(folder/'data'),XDG_CACHE_HOME=str(folder/'cache'),XDG_STATE_HOME=str(folder/'state'),
        TEMP=str(folder/'tmp'),TMP=str(folder/'tmp'),TMPDIR=str(folder/'tmp'),OPENCODE_DB=str(folder/'state/smoke.sqlite'))
    for name in ['OPENCODE_PURE','OPENCODE_DISABLE_PROJECT_CONFIG','OPENCODE_DISABLE_DEFAULT_PLUGINS','OPENCODE_DISABLE_AUTOUPDATE',
                 'OPENCODE_DISABLE_MODELS_FETCH','OPENCODE_DISABLE_PRUNE','OPENCODE_DISABLE_AUTOCOMPACT','OPENCODE_DISABLE_TERMINAL_TITLE',
                 'OPENCODE_DISABLE_EXTERNAL_SKILLS','OPENCODE_DISABLE_LSP_DOWNLOAD','OPENCODE_DISABLE_CLAUDE_CODE','OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER']: env[name]='true'
    for name in ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy']: env[name]=origin
    env['NO_PROXY']=env['no_proxy']='127.0.0.1,localhost'; env['npm_config_registry']=origin+'/offline-npm/'; env['npm_config_userconfig']=str(folder/'home/.npmrc')
    config={'model':'anthropic/'+MODEL,'small_model':'anthropic/'+MODEL,'enabled_providers':['anthropic'],'autoupdate':False,
        'snapshot':False,'share':'disabled','lsp':False,'plugin':[],'mcp':{},'permission':{'*':'deny','read':{'*':'deny',
            'fixture.txt':'allow','**/'+folder.name+'/fixture/fixture.txt':'allow',str(fixture).replace('\\','/'):'allow'}},
        'provider':{'anthropic':{'options':{'apiKey':key,'baseURL':origin+'/opencode-native/v1'}}}}
    env['OPENCODE_CONFIG_CONTENT']=json.dumps(config)
    return env,config

def run_client(command,env,workspace,timeout=60):
    child=subprocess.Popen(command,cwd=workspace,env=env,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
    captured=[bytearray(),bytearray()]; overflow=[]
    def reader(stream,index):
        while data:=stream.read(8192):
            if len(captured[index])+len(data)>1024*1024: overflow.append(True); child.terminate(); break
            captured[index].extend(data)
    threads=[threading.Thread(target=reader,args=(child.stdout,0),daemon=True),threading.Thread(target=reader,args=(child.stderr,1),daemon=True)]
    for thread in threads: thread.start()
    timed_out=False
    try: child.wait(timeout=timeout)
    except subprocess.TimeoutExpired: timed_out=True; stop(child)
    finally:
        stop(child)
        for thread in threads: thread.join(3)
        child.stdout.close(); child.stderr.close()
    return child.returncode,bytes(captured[0]).decode('utf-8',errors='replace'),bytes(captured[1]).decode('utf-8',errors='replace'),timed_out,bool(overflow)

def main():
    parser=argparse.ArgumentParser(description=__doc__); parser.add_argument('--binary',type=Path,required=True)
    parser.add_argument('--archive',type=Path,required=True,help='Existing pinned official release ZIP; verify without download/extract')
    parser.add_argument('--node',type=Path); parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--observe-only',action='store_true',help='Explicit completed-observation exit zero, never changes fidelity predicates')
    args=parser.parse_args(); output=args.output.resolve(); temp=Path(tempfile.gettempdir()).resolve()
    if output.exists() or temp not in output.parents or ROOT in output.parents: raise SystemExit('Use a NEW system-temp child outside the repository')
    binary=args.binary.resolve(strict=True); archive=args.archive.resolve(strict=True); node=args.node.resolve(strict=True) if args.node else shutil.which('node')
    if not node: raise SystemExit('Existing node required')
    with archive.open('rb') as file: archive_hash=hashlib.file_digest(file,'sha256').hexdigest()
    if archive_hash!=ZIP_SHA256: raise SystemExit('Pinned official release archive identity mismatch')
    output.mkdir(parents=True)
    report={'scope':'actual OpenCode / unmodified stock free authenticated passthrough / actual native relay / loopback fake Anthropic',
        'opencode_source_commit':SOURCE,'archive_sha256':archive_hash,'litellm_version':importlib.metadata.version('litellm'),
        'before':identities(),'scenarios':[],'not_tested':['real-provider authorization/signature validity','billing/cache hits','OS network/filesystem sandbox enforcement','deployment','long sessions/compaction/cancellation','model switch','unknown opaque types']}
    with binary.open('rb') as file: report['binary_sha256']=hashlib.file_digest(file,'sha256').hexdigest()
    if report['binary_sha256']!=BINARY_SHA256: raise SystemExit('Pinned extracted executable identity mismatch')
    report['repository_head']=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()
    if report['litellm_version']!='1.103.1': raise SystemExit('Pristine stock LiteLLM1.103.1 required')
    gateway_key='sk-local-opencode-fixture-'+secrets.token_hex(24); relay_key=None
    def redact(text):
        for key in [gateway_key,relay_key,'sk-ant-local-fake-only']:
            if key: text=text.replace(key,'[LOCAL_FIXTURE_KEY]')
        return text
    fake=ThreadingHTTPServer(('127.0.0.1',0),Fake); fake.requests=[]; fake.local_keys=[gateway_key]
    fake_thread=threading.Thread(target=fake.serve_forever,daemon=True); fake_thread.start()
    observer=ThreadingHTTPServer(('127.0.0.1',0),Observer); observer.blocked={}; observer.records=[]; observer.target_port=0; observer.gateway_key=gateway_key
    observer_thread=threading.Thread(target=observer.serve_forever,daemon=True); observer_thread.start(); origin='http://127.0.0.1:'+str(observer.server_port); children=[]
    try:
        service_env=clean_env(output)
        for name in ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY']: service_env[name]=origin
        service_env['NO_PROXY']='127.0.0.1,localhost'
        def relay_ready(line):
            try:
                value=json.loads(line); port=value.get('local_relay_port'); key=value.get('local_relay_key')
                if isinstance(port,int) and not isinstance(port,bool) and 0<port<=65535 and isinstance(key,str) and key.startswith('sk-'): return value
            except ValueError: pass
        child,thread,logs,ready=start([str(node),str(ROOT/'integration/clients/boot_responses_relay.mjs'),'http://127.0.0.1:'+str(fake.server_port)],service_env,output,relay_ready,20)
        children.append((child,thread,logs,'relay.log')); relay_key=ready['local_relay_key']; fake.local_keys.append(relay_key)
        config={'litellm_settings':{'telemetry':False,'num_retries':0,'callbacks':[]},'router_settings':{'num_retries':0},'general_settings':{
            'master_key':'os.environ/LOCAL_GATEWAY_KEY','pass_through_endpoints':[{'path':ROUTE,'target':'http://127.0.0.1:'+str(ready['local_relay_port'])+'/v1/messages',
            'auth':True,'methods':['POST'],'forward_headers':True,'headers':{'Authorization':'os.environ/LOCAL_RELAY_AUTHORIZATION','x-api-key':''}}]}}
        config_path=output/'gateway.yaml'; config_path.write_text(yaml.safe_dump(config),encoding='utf-8')
        service_env.update(CONFIG_FILE_PATH=str(config_path),LOCAL_GATEWAY_KEY=gateway_key,LOCAL_RELAY_AUTHORIZATION='Bearer '+relay_key,LITELLM_LOCAL_MODEL_COST_MAP='True')
        child,thread,logs,port=start([sys.executable,str(ROOT/'integration/litellm/boot_gateway.py')],service_env,output,
            lambda line:int(line.strip().split('=')[1]) if line.startswith('LOCAL_GATEWAY_PORT=') else None,45)
        children.append((child,thread,logs,'gateway.log')); observer.target_port=port; deadline=time.monotonic()+30
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
        while True:
            try: opener.open('http://127.0.0.1:'+str(port)+'/health/liveliness',timeout=.5).close(); break
            except Exception:
                if time.monotonic()>deadline: raise RuntimeError('Gateway health timeout')
                time.sleep(.1)
        for signatures in ['single','split']:
            for mode in ['signed_nonempty','full_opaque']:
                folder=output/(signatures+'_'+mode); folder.mkdir(); workspace=folder/'fixture'; workspace.mkdir()
                fixture=workspace/'fixture.txt'; fixture.write_bytes((FIXTURE+'\n').encode()); env,client_config=client_env(folder,binary,node,fixture,origin,gateway_key)
                (folder/'client-config.json').write_text(redact(json.dumps(client_config,indent=2)),encoding='utf-8')
                fake.signatures=signatures; fake.mode=mode; fake.fixture=fixture; fake.requests=[]; fake.raw_requests=[]; fake.betas=[]; fake.issued=[]; fake.replayed=None; fake.failure=None; fake.wires=[]
                observer.records=[]; observer.raw_requests=[]; observer.betas=[]; observer.wires=[]; observer.blocked={}; observer.failure=None
                if 'opencode_version' not in report:
                    code,stdout,stderr,timed_out,overflow=run_client([str(binary),'--version'],env,workspace,15)
                    report['opencode_version']=stdout.strip()
                    if code!=0 or timed_out or overflow or stdout.strip()!='1.18.34': raise RuntimeError('Pinned OpenCode1.18.34 required')
                command=[str(binary),'run','--format','json','--model','anthropic/'+MODEL,'--title','Synthetic gateway fidelity smoke',
                    'Read fixture.txt using only the read tool, then finish. Never use any other tool or network.']
                code,stdout,stderr,timed_out,overflow=run_client(command,env,workspace)
                (folder/'client-events.jsonl').write_text(redact(stdout),encoding='utf-8'); (folder/'client-stderr.log').write_text(redact(stderr),encoding='utf-8')
                try: events=[json.loads(line) for line in stdout.splitlines() if line.strip()]; event_parse_error=False
                except ValueError: events=[]; event_parse_error=True
                text_events=[e for e in events if e.get('type')=='text']; finish_events=[e for e in events if e.get('type')=='step_finish']
                client_replay=observer.records[1]['body'] if len(observer.records)>1 else None
                client_assistant=blocks(client_replay,'assistant'); native_assistant=blocks(fake.replayed,'assistant'); issued=fake.issued
                signed=[b for b in issued if b['type']=='thinking']; expected_cache=copy.deepcopy(issued)
                if expected_cache: expected_cache[-1]['cache_control']={'type':'ephemeral'}
                expected_suffix=copy.deepcopy(expected_cache)
                for block in expected_suffix:
                    if block['type']=='thinking': block['signature']=block['signature'][8:]
                results=[b for b in blocks(fake.replayed,'user') if b.get('type')=='tool_result']
                item={'signature_events':signatures,'mode':mode,'exit_code':code,'timed_out':timed_out,'capture_overflow':overflow,'event_parse_error':event_parse_error,
                    'responses_requests':len(observer.records),'upstream_requests':len(fake.requests),'fixture_failure':fake.failure,'observer_failure':observer.failure,
                    'final_exact':len(text_events)==1 and text_events[0].get('part',{}).get('text')==MARKER,
                    'steps_exact':[e.get('part',{}).get('reason') for e in finish_events]==['tool-calls','stop'],
                    'last_event_finished':bool(events) and events[-1].get('type')=='step_finish','client_error_event':any(e.get('type')=='error' for e in events),
                    'only_read_offered':bool(fake.requests) and all([t.get('name') for t in r['body'].get('tools',[])]==['read'] for r in fake.requests),
                    'read_executed':len(results)==1 and results[0].get('tool_use_id')=='toolu_fake_opencode_01' and not results[0].get('is_error',False) and FIXTURE in json.dumps(results[0].get('content')),
                    'signed_nonempty_preserved_client':bool(signed) and signed[0] in client_assistant,
                    'signed_nonempty_preserved_upstream':bool(signed) and signed[0] in native_assistant,
                    'signed_empty_preserved_client':None if mode!='full_opaque' else len(signed)>1 and signed[1] in client_assistant,
                    'signed_empty_preserved_upstream':None if mode!='full_opaque' else len(signed)>1 and signed[1] in native_assistant,
                    'redacted_preserved_client':None if mode!='full_opaque' else issued[2] in client_assistant,
                    'redacted_preserved_upstream':None if mode!='full_opaque' else issued[2] in native_assistant,
                    'ordered_assistant_issued_exact_client':bool(issued) and client_assistant==issued,
                    'ordered_assistant_issued_exact_upstream':bool(issued) and native_assistant==issued,
                    'ordered_assistant_expected_client_cache_marker_exact':bool(issued) and client_assistant==expected_cache,
                    'ordered_assistant_expected_upstream_cache_marker_exact':bool(issued) and native_assistant==expected_cache,
                    'gateway_native_assistant_exact':bool(client_replay) and client_assistant==native_assistant,
                    'client_tool_cache_marker_added_exact':bool(expected_cache) and [b for b in client_assistant if b.get('type')=='tool_use']==[expected_cache[-1]],
                    'split_signature_last_fragment_only':None if signatures!='split' else client_assistant==expected_suffix,
                    'client_metadata_field_present':['metadata' in r['body'] for r in observer.records],
                    'whole_body_semantic_exact':len(observer.records)==len(fake.requests)==2 and all(r['body']==n['body'] for r,n in zip(observer.records,fake.requests)),
                    'wire_request_bytes_exact':len(observer.raw_requests)==len(fake.raw_requests)==2 and observer.raw_requests==fake.raw_requests,
                    'response_sse_bytes_exact':len(fake.wires)==len(observer.wires)==2 and fake.wires==observer.wires,
                    'beta_headers_exact':len(fake.betas)==len(observer.betas)==2 and fake.betas==observer.betas,
                    'client_gateway_auth_exact':bool(observer.records) and all(r['client_gateway_auth_exact'] for r in observer.records),
                    'upstream_auth_exact':bool(fake.requests) and all(r['upstream_auth_exact'] for r in fake.requests),
                    'credential_leak':any(r['credential_leak'] for r in fake.requests),'blocked_incidental_requests':copy.deepcopy(observer.blocked),
                    'workspace_exact':sorted(p.name for p in workspace.iterdir())==['fixture.txt'] and fixture.read_bytes()==(FIXTURE+'\n').encode()}
                # Record exact safe field-loss locations independently of signed state.
                item['top_level_removed_fields']=[sorted(set(r['body'])-set(n['body'])) for r,n in zip(observer.records,fake.requests)]
                item['top_level_added_fields']=[sorted(set(n['body'])-set(r['body'])) for r,n in zip(observer.records,fake.requests)]
                item['http_success']=len(observer.records)==2 and all(r['status']==200 for r in observer.records)
                item['observation_completed']=code==0 and not timed_out and not overflow and not event_parse_error and fake.failure is None and observer.failure is None and item['responses_requests']==item['upstream_requests']==2 and all(item[k] for k in ['http_success','final_exact','steps_exact','last_event_finished','read_executed','only_read_offered','response_sse_bytes_exact','beta_headers_exact','client_gateway_auth_exact','upstream_auth_exact','workspace_exact']) and not item['credential_leak'] and not item['client_error_event']
                item['state_subset_pass']=item['observation_completed'] and item['ordered_assistant_expected_client_cache_marker_exact'] and item['ordered_assistant_expected_upstream_cache_marker_exact'] and item['gateway_native_assistant_exact']
                item['strict_case_pass']=item['state_subset_pass'] and item['whole_body_semantic_exact']
                report['scenarios'].append(item)
                (folder/'client-requests.json').write_text(redact(json.dumps(observer.records,indent=2)),encoding='utf-8')
                (folder/'fake-requests.json').write_text(redact(json.dumps(fake.requests,indent=2)),encoding='utf-8')
                (folder/'beta-headers.json').write_text(json.dumps({'client':observer.betas,'upstream':fake.betas},indent=2),encoding='utf-8')
                for index,wire in enumerate(fake.wires): (folder/f'provider-response-{index+1}.sse').write_bytes(wire)
                for index,wire in enumerate(observer.wires): (folder/f'client-response-{index+1}.sse').write_bytes(wire)
                print(json.dumps(item),flush=True)
    except Exception as error: report['harness_error']=redact(str(error))[:1024]
    finally:
        observer.shutdown(); observer.server_close(); observer_thread.join(3)
        for child,thread,logs,name in reversed(children): stop(child); thread.join(3); child.stdout.close(); (output/name).write_text(redact(''.join(logs)),encoding='utf-8')
        fake.shutdown(); fake.server_close(); fake_thread.join(3)
        report['after']=identities(); report['stock_unchanged']=report['before']==report['after']
        report['observation_completed']=not report.get('harness_error') and report['stock_unchanged'] and len(report['scenarios'])==4 and all(s['observation_completed'] for s in report['scenarios'])
        report['state_subset_pass']=report['observation_completed'] and all(s['state_subset_pass'] for s in report['scenarios'])
        controls=[s for s in report['scenarios'] if s['signature_events']=='single']; stress=[s for s in report['scenarios'] if s['signature_events']=='split']
        report['state_control_pass']=report['stock_unchanged'] and len(controls)==2 and all(s['state_subset_pass'] for s in controls)
        report['state_stress_pass']=report['stock_unchanged'] and len(stress)==2 and all(s['state_subset_pass'] for s in stress)
        report['split_signature_preserved']=report['stock_unchanged'] and len(stress)==2 and all(s['signed_nonempty_preserved_client'] and s['signed_nonempty_preserved_upstream'] and (s['mode']!='full_opaque' or s['signed_empty_preserved_client'] and s['signed_empty_preserved_upstream']) for s in stress)
        report['whole_body_semantic_exact']=report['observation_completed'] and all(s['whole_body_semantic_exact'] for s in report['scenarios'])
        report['strict_qualification_pass']=report['state_subset_pass'] and report['whole_body_semantic_exact']
        (output/'opencode-gateway-smoke.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    print('Report:',output/'opencode-gateway-smoke.json'); print('Strict qualification:',report['strict_qualification_pass'])
    return 0 if report['strict_qualification_pass'] or args.observe_only and report['observation_completed'] else 1

if __name__=='__main__': raise SystemExit(main())
