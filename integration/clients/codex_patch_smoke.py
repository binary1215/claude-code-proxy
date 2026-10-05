"""Pinned actual Codex coding-tool smoke; synthetic credentials, loopback providers only.

Run with pristine stock LiteLLM 1.103.1 Python. Evidence is synthetic and written
only to a NEW external temp directory. Never use an existing client home.
"""
from __future__ import annotations
import argparse
import ast
import copy
import hashlib
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.metadata
import importlib.util
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

ROOT = Path(__file__).resolve().parents[2]
MODEL = 'claude-sonnet-4-20250514'
MARKER = 'CODEX_PATCH_FIXTURE_OK'
PATCH = '*** Begin Patch\n*** Add File: fixture.txt\n+SYNTHETIC_PATCH_CREATED\n*** End Patch'
SOURCE = 'a956835d020762cb2b570053af06f643a11c0ecc'

def clean_env(folder):
    env = {k: v for k, v in os.environ.items() if k.upper() in {'PATH', 'SYSTEMROOT', 'WINDIR', 'PATHEXT', 'COMSPEC'}}
    for name in ['TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']:
        env[name] = str(folder)
    env['PYTHONDONTWRITEBYTECODE'] = '1'
    return env

def identities():
    tree = ast.parse((ROOT / 'integration/litellm/test_stock_gateway.py').read_text(encoding='utf-8'))
    expected = next(ast.literal_eval(n.value) for n in tree.body if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'EXPECTED' for t in n.targets))
    package = Path(importlib.util.find_spec('litellm').origin).parent.parent
    actual = {}
    for name, wanted in expected.items():
        raw = (package / name).read_bytes().replace(b'\r\n', b'\n')
        actual[name] = hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest()
        if actual[name] != wanted: raise RuntimeError('Stock source mismatch: ' + name)
    return actual

def event(kind, value):
    return ('event: ' + kind + '\r\ndata: ' + json.dumps(value, ensure_ascii=False) + '\r\n\r\n').encode()

class Fake(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_POST(self):
        size = int(self.headers.get('content-length', '0'))
        if self.path != '/v1/messages' or size < 1 or size > 1024 * 1024 or len(self.server.requests) >= 3:
            self.send_error(400); return
        raw = self.rfile.read(size); body = json.loads(raw)
        self.server.requests.append({'body': body,
            'upstream_auth_exact': self.headers.get('x-api-key') == 'sk-ant-local-fake-only' and not self.headers.get('authorization'),
            'credential_leak': any(k in self.path or k.encode() in raw or any(k in v for v in self.headers.values()) for k in self.server.local_keys)})
        results = [b for m in body.get('messages', []) for b in m.get('content', []) if isinstance(b, dict) and b.get('type') == 'tool_result']
        if results:
            self.server.replayed = copy.deepcopy(body)
            self.stream([{'type': 'text', 'text': MARKER}], 'end_turn'); return
        # Parent translates the registered custom tool; discovery cannot fall back
        # to shell or another tool. Only our one relative synthetic path is issued.
        names = [t.get('name', '') for t in body.get('tools', [])]
        patches = [n for n in names if n == 'apply_patch' or n.endswith('__apply_patch')]
        if len(patches) != 1:
            self.server.failure = 'exact_apply_patch_tool_unavailable'; self.send_error(400); return
        patch = PATCH if self.server.mode == 'valid_patch' else PATCH.removesuffix('*** End Patch')
        content = [{'type': 'thinking', 'thinking': 'Synthetic reasoning 🔧.', 'signature': 'fixture-signed-nonempty+/='},
                   {'type': 'thinking', 'thinking': '', 'signature': 'fixture-signed-empty+/='},
                   {'type': 'redacted_thinking', 'data': 'fixture-redacted+/='},
                   {'type': 'tool_use', 'id': 'toolu_fixture_patch', 'name': patches[0], 'input': {'input': patch}}]
        self.server.issued = copy.deepcopy(content); self.stream(content, 'tool_use')
    def stream(self, content, stop):
        msg = {'id': 'msg_fixture_patch', 'type': 'message', 'role': 'assistant', 'model': MODEL,
               'content': [], 'stop_reason': None, 'stop_sequence': None,
               'usage': {'input_tokens': 10, 'output_tokens': 0, 'cache_read_input_tokens': 80, 'cache_creation_input_tokens': 0}}
        wire = event('message_start', {'type': 'message_start', 'message': msg})
        for index, block in enumerate(content):
            kind = block['type']
            start = {'type': 'thinking', 'thinking': ''} if kind == 'thinking' else {**block, 'input': {}} if kind == 'tool_use' else {'type': 'text', 'text': ''} if kind == 'text' else block
            wire += event('content_block_start', {'type': 'content_block_start', 'index': index, 'content_block': start})
            deltas = []
            if kind == 'thinking':
                if block['thinking']: deltas.append({'type': 'thinking_delta', 'thinking': block['thinking']})
                deltas += [{'type': 'signature_delta', 'signature': s} for s in (block['signature'][:8], block['signature'][8:])]
            elif kind == 'tool_use':
                text = json.dumps(block['input']); deltas += [{'type': 'input_json_delta', 'partial_json': text[i:i+7]} for i in range(0, len(text), 7)]
            elif kind == 'text': deltas.append({'type': 'text_delta', 'text': block['text']})
            for delta in deltas: wire += event('content_block_delta', {'type': 'content_block_delta', 'index': index, 'delta': delta})
            wire += event('content_block_stop', {'type': 'content_block_stop', 'index': index})
        wire += event('message_delta', {'type': 'message_delta', 'delta': {'stop_reason': stop, 'stop_sequence': None}, 'usage': {'output_tokens': 9}})
        wire += event('message_stop', {'type': 'message_stop'})
        self.send_response(200); self.send_header('content-type', 'text/event-stream'); self.send_header('content-length', str(len(wire))); self.end_headers()
        for index in range(0, len(wire), 7): self.wfile.write(wire[index:index+7]); self.wfile.flush()

class Observer(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_POST(self):
        size = int(self.headers.get('content-length', '0'))
        if self.path != '/coding-fixture/v1/responses' or size < 1 or size > 1024*1024 or len(self.server.records) >= 3:
            self.send_error(400); return
        raw = self.rfile.read(size); record = {'request': json.loads(raw), 'response_sse': ''}; self.server.records.append(record)
        connection = http.client.HTTPConnection('127.0.0.1', self.server.target_port, timeout=30)
        try:
            headers = {k:v for k,v in self.headers.items() if k.lower() not in {'host', 'connection', 'transfer-encoding', 'accept-encoding'}}
            headers['accept-encoding'] = 'identity'; connection.request('POST', self.path, raw, headers)
            response = connection.getresponse(); record['status'] = response.status; self.send_response(response.status)
            for name, value in response.getheaders():
                if name.lower() not in {'connection', 'transfer-encoding', 'content-length', 'server', 'date'}: self.send_header(name,value)
            self.send_header('connection','close'); self.end_headers(); wire = bytearray()
            while chunk := response.read1(8192):
                wire.extend(chunk)
                if len(wire) > 4*1024*1024: raise RuntimeError('Bound exceeded')
                self.wfile.write(chunk); self.wfile.flush()
            record['response_sse'] = wire.decode()
        finally: connection.close()

def stop(child):
    if child.poll() is None: child.terminate()
    try: child.wait(timeout=5)
    except subprocess.TimeoutExpired: child.kill(); child.wait(timeout=5)

def start(cmd, env, cwd, ready, timeout):
    child = subprocess.Popen(cmd, env=env, cwd=cwd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                             text=True, encoding='utf-8', errors='replace', creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    lines = queue.Queue(); logs = []
    def read():
        for line in child.stdout: logs.append(line); lines.put(line)
    thread = threading.Thread(target=read, daemon=True); thread.start(); deadline = time.monotonic()+timeout
    while time.monotonic() < deadline:
        try: line = lines.get(timeout=.2)
        except queue.Empty:
            if child.poll() is not None: break
            continue
        value = ready(line)
        if value: return child,thread,logs,value
    stop(child); thread.join(3); child.stdout.close()
    # Startup logs can contain freshly generated local credentials. Never include
    # them in an unredacted exception; a failed start is not acceptance evidence.
    raise RuntimeError('Local fixture process failed to start')

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--codex', type=Path, required=True); parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--node', type=Path); args = parser.parse_args()
    output = args.output.resolve()
    temp_root = Path(tempfile.gettempdir()).resolve()
    if output.exists() or temp_root not in output.parents or output == ROOT or ROOT in output.parents:
        raise SystemExit('Use a NEW evidence directory under the system temp directory, outside the repository')
    output.mkdir(parents=True); codex = args.codex.resolve(strict=True); node = args.node.resolve(strict=True) if args.node else shutil.which('node')
    if not node: raise SystemExit('Existing node required')
    report = {'scope':'actual Codex -> stock authenticated free passthrough -> validated relay -> loopback fake Anthropic',
              'source_commit':SOURCE, 'litellm_version':importlib.metadata.version('litellm'), 'before':identities(), 'scenarios':[],
              'not_tested':['real provider acceptance or credentials','real signatures','subscription entitlement','billing/cache hits',
                            'OS-enforced network isolation','path traversal policy','environment-prefixed patch','multi-file/update/delete patches']}
    report['codex_version'] = subprocess.check_output([str(codex),'--version'],env=clean_env(output),text=True).strip()
    with codex.open('rb') as file: report['codex_sha256'] = hashlib.file_digest(file,'sha256').hexdigest()
    if report['litellm_version'] != '1.103.1' or report['codex_version'] != 'codex-cli 0.160.0': raise SystemExit('Pinned client/runtime required')
    gateway_key = 'sk-local-fixture-'+secrets.token_hex(24); relay_key = None
    def redact(text):
        for key in [gateway_key, relay_key]:
            if key: text = text.replace(key,'[LOCAL_FIXTURE_KEY]')
        return text
    fake = ThreadingHTTPServer(('127.0.0.1',0),Fake); fake.requests=[]; fake.local_keys=[gateway_key]
    fake_thread = threading.Thread(target=fake.serve_forever,daemon=True); fake_thread.start()
    children=[]; observer=None
    try:
        def relay_ready(line):
            try:
                value=json.loads(line)
                port=value.get('local_relay_port'); credential=value.get('local_relay_key')
                if isinstance(port,int) and not isinstance(port,bool) and 0 < port <= 65535 and isinstance(credential,str) and credential.startswith('sk-'): return value
            except ValueError: pass
        child,thread,logs,ready = start([str(node),str(ROOT/'integration/clients/boot_codex_patch_relay.mjs'),'http://127.0.0.1:'+str(fake.server_port)],clean_env(output),output,relay_ready,20)
        children.append((child,thread,logs,'relay.log')); relay_key=ready['local_relay_key']; fake.local_keys.append(relay_key)
        config = {'litellm_settings':{'telemetry':False,'num_retries':0,'callbacks':[]},'router_settings':{'num_retries':0},
                  'general_settings':{'master_key':'os.environ/LOCAL_GATEWAY_KEY','pass_through_endpoints':[{
                      'path':'/coding-fixture/v1/responses','target':'http://127.0.0.1:'+str(ready['local_relay_port'])+'/v1/responses',
                      'auth':True,'methods':['POST'],'forward_headers':True,
                      'headers':{'Authorization':'os.environ/LOCAL_RELAY_AUTHORIZATION','x-api-key':''}}]}}
        config_path=output/'gateway.yaml'; config_path.write_text(yaml.safe_dump(config),encoding='utf-8')
        env=clean_env(output); env.update(CONFIG_FILE_PATH=str(config_path),LOCAL_GATEWAY_KEY=gateway_key,LOCAL_RELAY_AUTHORIZATION='Bearer '+relay_key,LITELLM_LOCAL_MODEL_COST_MAP='True')
        child,thread,logs,port=start([sys.executable,str(ROOT/'integration/litellm/boot_gateway.py')],env,output,
                                   lambda s:int(s.strip().split('=')[1]) if s.startswith('LOCAL_GATEWAY_PORT=') else None,45)
        children.append((child,thread,logs,'gateway.log'))
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({})); deadline=time.monotonic()+30
        while True:
            try: opener.open('http://127.0.0.1:'+str(port)+'/health/liveliness',timeout=.5).close(); break
            except Exception:
                if time.monotonic()>deadline: raise RuntimeError('Gateway not ready')
                time.sleep(.2)
        observer=ThreadingHTTPServer(('127.0.0.1',0),Observer); observer.target_port=port; observer.records=[]
        observer_thread=threading.Thread(target=observer.serve_forever,daemon=True); observer_thread.start()
        for mode in ['valid_patch','malformed_patch']:
            fake.mode=mode; fake.requests=[]; fake.issued=[]; fake.replayed=None; fake.failure=None; observer.records=[]
            folder=output/mode; folder.mkdir(); workspace=folder/'workspace'; workspace.mkdir(); (folder/'codex-state').mkdir()
            catalog={'models':[{'slug':MODEL,'display_name':'Synthetic coding-tool fixture (NOT real Claude metadata)',
                'description':'Loopback fake only','supported_reasoning_levels':[], 'shell_type':'disabled', 'visibility':'list',
                'supported_in_api':True,'priority':0,'support_verbosity':False,'apply_patch_tool_type':'freeform',
                'truncation_policy':{'mode':'bytes','limit':100000},'experimental_supported_tools':[],
                'base_instructions':'Synthetic protocol fixture. Only apply_patch may create fixture.txt; never execute shell or access network.',
                'input_modalities':['text'],'supports_reasoning_summary_parameter':False}]}
            catalog_path=folder/'model-catalog.json'; catalog_path.write_text(json.dumps(catalog,indent=2),encoding='utf-8')
            env=clean_env(folder); env.update(CODEX_HOME=str(folder/'codex-state'),CODEX_FIXTURE_KEY=gateway_key,RUST_LOG='error')
            overrides={'model_provider':'fixture','model':MODEL,'model_catalog_json':str(catalog_path),'web_search':'disabled',
                'analytics.enabled':False,'feedback.enabled':False,'check_for_update_on_startup':False,
                'otel.exporter':'none','otel.trace_exporter':'none','agents.enabled':False,
                'approval_policy':'never','model_providers.fixture.name':'Local synthetic fixture',
                'model_providers.fixture.base_url':'http://127.0.0.1:'+str(observer.server_port)+'/coding-fixture/v1',
                'model_providers.fixture.wire_api':'responses','model_providers.fixture.env_key':'CODEX_FIXTURE_KEY',
                'model_providers.fixture.requires_openai_auth':False,'model_providers.fixture.supports_websockets':False,
                'model_providers.fixture.request_max_retries':0,'model_providers.fixture.stream_max_retries':0,'model_providers.fixture.stream_idle_timeout_ms':15000}
            cmd=[str(codex),'exec','--ignore-user-config','--ignore-rules','--ephemeral','--skip-git-repo-check','--sandbox','workspace-write','--json','-C',str(workspace)]
            for name,value in overrides.items(): cmd += ['-c',name+'='+json.dumps(value)]
            cmd += ['Synthetic test: use only apply_patch to create fixture.txt containing SYNTHETIC_PATCH_CREATED. Never run shell, read other files, or access network. Finish with '+MARKER+'.']
            item={'mode':mode}
            try:
                result=subprocess.run(cmd,cwd=workspace,env=env,stdin=subprocess.DEVNULL,capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=60)
                events=[json.loads(line) for line in result.stdout.splitlines() if line.strip()]
                item.update(exit_code=result.returncode,turn_completed=any(e.get('type')=='turn.completed' for e in events),
                            turn_failed=any(e.get('type') in {'turn.failed','error'} for e in events),
                            final_exact=[e.get('item',{}).get('text') for e in events if e.get('type')=='item.completed' and e.get('item',{}).get('type')=='agent_message']==[MARKER],
                            metadata_fallback='Model metadata for' in result.stdout+result.stderr)
                (folder/'client-events.jsonl').write_text(redact(result.stdout),encoding='utf-8'); (folder/'client-stderr.log').write_text(redact(result.stderr),encoding='utf-8')
            except subprocess.TimeoutExpired: item['timed_out']=True
            files=sorted(str(p.relative_to(workspace)) for p in workspace.rglob('*') if p.is_file())
            file=workspace/'fixture.txt'; item.update(workspace_files=files,file_exact=file.exists() and file.read_bytes()==b'SYNTHETIC_PATCH_CREATED\n',file_absent=not file.exists(),
                upstream_requests=len(fake.requests),responses_requests=len(observer.records),fixture_failure=fake.failure,
                upstream_auth_exact=bool(fake.requests) and all(r['upstream_auth_exact'] for r in fake.requests),credential_leak=any(r['credential_leak'] for r in fake.requests))
            assistant=[b for m in (fake.replayed or {}).get('messages',[]) if m.get('role')=='assistant' for b in m.get('content',[]) if isinstance(b,dict)]
            results=[b for m in (fake.replayed or {}).get('messages',[]) for b in m.get('content',[]) if isinstance(b,dict) and b.get('type')=='tool_result']
            wire_events=[json.loads(line[6:]) for r in observer.records[:1] for line in r['response_sse'].splitlines() if line.startswith('data: ') and line[6:]!='[DONE]']
            done=[e['item'] for e in wire_events if e.get('type')=='response.output_item.done' and e.get('item',{}).get('type')=='reasoning']
            complete=[i for e in wire_events if e.get('type')=='response.completed' for i in e['response'].get('output',[]) if i.get('type')=='reasoning']
            replay=[i for r in observer.records[1:2] for i in r['request'].get('input',[]) if isinstance(i,dict) and i.get('type')=='reasoning']
            def capsule(items): return [(i.get('id'),i.get('encrypted_content')) for i in items]
            item.update(ordered_assistant_exact=bool(fake.issued) and assistant==fake.issued,
                opaque_done_completed_replayed_exact=len(done)==3 and all(i.get('encrypted_content') for i in done) and capsule(done)==capsule(complete)==capsule(replay),
                tool_result_replayed=len(results)==1 and results[0].get('tool_use_id')=='toolu_fixture_patch',
                failed_response_seen=any(e.get('type')=='response.failed' for e in wire_events),
                custom_call_delivered=any(e.get('type')=='response.output_item.done' and e.get('item',{}).get('type')=='custom_tool_call' for e in wire_events))
            offered = observer.records[0]['request'].get('tools',[]) if observer.records else []
            patch_tools = [t for t in offered if t.get('type')=='custom' and t.get('name')=='apply_patch']
            metadata = observer.records[0]['request'].get('client_metadata',{}) if observer.records else {}
            try: turn_metadata = json.loads(metadata.get('x-codex-turn-metadata','{}'))
            except ValueError: turn_metadata = {}
            item.update(actual_sandbox_mode=turn_metadata.get('sandbox_mode'),
                apply_patch_freeform_offered=len(patch_tools)==1 and patch_tools[0].get('format',{}).get('type')=='grammar',
                shell_tool_offered=any(t.get('name') in {'shell','shell_command','exec_command'} for t in offered),
                tool_result_content=results[0].get('content') if len(results)==1 else None)
            item['tool_execution_success'] = item['file_exact'] and item['workspace_files']==['fixture.txt'] and item['tool_result_replayed'] and not results[0].get('is_error',False)
            # Raw synthetic tool/grammar and next-turn history are evidence, never auth headers.
            (folder/'fake-requests.json').write_text(redact(json.dumps(fake.requests,indent=2)),encoding='utf-8')
            (folder/'responses-wire.json').write_text(redact(json.dumps(observer.records,indent=2)),encoding='utf-8')
            report['scenarios'].append(item); print(json.dumps(item),flush=True)
    finally:
        if observer: observer.shutdown(); observer.server_close(); observer_thread.join(3)
        for child,thread,logs,name in reversed(children): stop(child); thread.join(3); child.stdout.close(); (output/name).write_text(redact(''.join(logs)),encoding='utf-8')
        fake.shutdown(); fake.server_close(); fake_thread.join(3)
        report['after']=identities(); report['stock_unchanged']=report['before']==report['after']
        positive=next((s for s in report['scenarios'] if s['mode']=='valid_patch'),{})
        negative=next((s for s in report['scenarios'] if s['mode']=='malformed_patch'),{})
        report['transport_state_subset_pass']=report['stock_unchanged'] and positive.get('exit_code')==0 and all(positive.get(k) for k in ['turn_completed','final_exact','ordered_assistant_exact','opaque_done_completed_replayed_exact','tool_result_replayed','upstream_auth_exact','custom_call_delivered','apply_patch_freeform_offered']) and positive.get('fixture_failure') is None and positive.get('upstream_requests')==2 and positive.get('responses_requests')==2 and not positive.get('credential_leak') and not positive.get('metadata_fallback') and not positive.get('turn_failed') and not positive.get('shell_tool_offered')
        report['coding_tool_subset_pass']=report['transport_state_subset_pass'] and positive.get('tool_execution_success') and positive.get('actual_sandbox_mode')=='workspace-write'
        report['malformed_patch_rejected_before_client_execution']=report['stock_unchanged'] and negative.get('fixture_failure') is None and negative.get('file_absent') and negative.get('workspace_files')==[] and negative.get('upstream_requests')==1 and negative.get('responses_requests')==1 and negative.get('failed_response_seen') and not negative.get('custom_call_delivered') and negative.get('turn_failed') and not negative.get('turn_completed') and negative.get('upstream_auth_exact') and not negative.get('credential_leak')
        (output/'codex-patch-smoke.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    print('Report:',output/'codex-patch-smoke.json')
    return 0 if report['coding_tool_subset_pass'] and report['malformed_patch_rejected_before_client_execution'] else 1

if __name__ == '__main__': raise SystemExit(main())
