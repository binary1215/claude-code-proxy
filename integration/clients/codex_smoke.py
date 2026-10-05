"""Actual isolated Codex -> stock LiteLLM Responses -> loopback fake Anthropic.

No real credentials or provider calls. This is a protocol observation, not live
Claude authorization, real-signature validation, or billing verification.
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
import subprocess
import sys
import threading
import time
import yaml

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--codex', type=Path, required=True, help='Existing official Codex executable')
parser.add_argument('--output', type=Path, required=True, help='New evidence directory outside the repository')
parser.add_argument('--observe-only', action='store_true', help='Exit zero for completed observations even when fidelity fails')
args = parser.parse_args()
root = Path(__file__).resolve().parents[2]
output = args.output.resolve()
if output.exists() or output == root or root in output.parents:
    raise SystemExit('Use a new evidence directory outside the repository')
output.mkdir(parents=True)
codex = args.codex.resolve(strict=True)
key = 'sk-local-fixture-' + secrets.token_hex(24)
model = 'claude-sonnet-4-20250514'

def identities():
    tree = ast.parse((root / 'integration/litellm/test_stock_gateway.py').read_text(encoding='utf-8'))
    expected = next(ast.literal_eval(node.value) for node in tree.body if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'EXPECTED' for t in node.targets))
    package = Path(importlib.util.find_spec('litellm').origin).parent.parent
    actual = {}
    for name, wanted in expected.items():
        raw = (package / name).read_bytes().replace(b'\r\n', b'\n')
        actual[name] = hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest()
        if actual[name] != wanted:
            raise RuntimeError('Selected stock source identity mismatch: ' + name)
    return actual

def event(name, value):
    return ('event: ' + name + '\ndata: ' + json.dumps(value, ensure_ascii=False) + '\n\n').encode()

class Fake(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_POST(self):
        size = int(self.headers.get('content-length', '0'))
        if size > 1024 * 1024:
            self.send_error(413); return
        raw = self.rfile.read(size)
        try: body = json.loads(raw)
        except ValueError: self.send_error(400); return
        self.server.requests.append({'path': self.path, 'body': body,
                                     'gateway_key_leaked': key in self.path or key.encode() in raw or any(key in v for v in self.headers.values())})
        if self.path.split('?')[0] != '/v1/messages' or len(self.server.requests) > 4:
            self.send_error(400); return
        results = [b for m in body.get('messages', []) for b in m.get('content', []) if isinstance(b, dict) and b.get('type') == 'tool_result']
        if not results:
            names = [t.get('name') for t in body.get('tools', [])]
            # Only this internal, no-I/O tool is ever requested. Never run shell,
            # file, network or third-party tools from a fixture model response.
            if 'get_goal' not in names:
                self.server.failure = 'safe_get_goal_tool_not_offered'
                self.respond_error(); return
            content = [{'type': 'thinking', 'thinking': 'Synthetic reasoning only.', 'signature': 'fixture-signed-nonempty+/='}]
            if self.server.mode == 'full_opaque':
                content += [{'type': 'thinking', 'thinking': '', 'signature': 'fixture-signed-empty+/='},
                            {'type': 'redacted_thinking', 'data': 'fixture-redacted+/='}]
            content += [{'type': 'tool_use', 'id': 'toolu_fixture_goal', 'name': 'get_goal', 'input': {}}]
            self.server.issued = copy.deepcopy(content)
            self.respond_stream(content, 'tool_use')
        else:
            self.server.replayed = copy.deepcopy(body)
            self.respond_stream([{'type': 'text', 'text': 'CODEX_FIXTURE_OK'}], 'end_turn')
    def respond_error(self):
        raw = b'{"type":"error","error":{"type":"invalid_request_error","message":"Safe fixture tool unavailable"}}'
        self.send_response(400); self.send_header('content-type', 'application/json'); self.send_header('content-length', str(len(raw))); self.end_headers(); self.wfile.write(raw)
    def respond_stream(self, content, stop):
        message = {'id': 'msg_fixture', 'type': 'message', 'role': 'assistant', 'model': model,
                   'content': [], 'stop_reason': None, 'stop_sequence': None,
                   'usage': {'input_tokens': 10, 'output_tokens': 0, 'cache_read_input_tokens': 80, 'cache_creation_input_tokens': 0}}
        wire = event('message_start', {'type': 'message_start', 'message': message})
        for index, block in enumerate(content):
            kind = block['type']
            start = {'type': 'thinking', 'thinking': ''} if kind == 'thinking' else {**block, 'input': {}} if kind == 'tool_use' else {'type': 'text', 'text': ''} if kind == 'text' else block
            wire += event('content_block_start', {'type': 'content_block_start', 'index': index, 'content_block': start})
            deltas = []
            if kind == 'thinking':
                if block['thinking']: deltas.append({'type': 'thinking_delta', 'thinking': block['thinking']})
                deltas += [{'type': 'signature_delta', 'signature': part} for part in (block['signature'][:8], block['signature'][8:])]
            elif kind == 'tool_use':
                encoded = json.dumps(block['input']); deltas += [{'type': 'input_json_delta', 'partial_json': part} for part in (encoded[:8], encoded[8:])]
            elif kind == 'text': deltas.append({'type': 'text_delta', 'text': block['text']})
            for delta in deltas: wire += event('content_block_delta', {'type': 'content_block_delta', 'index': index, 'delta': delta})
            wire += event('content_block_stop', {'type': 'content_block_stop', 'index': index})
        wire += event('message_delta', {'type': 'message_delta', 'delta': {'stop_reason': stop, 'stop_sequence': None}, 'usage': {'output_tokens': 9}})
        wire += event('message_stop', {'type': 'message_stop'})
        self.send_response(200); self.send_header('content-type', 'text/event-stream'); self.send_header('content-length', str(len(wire))); self.end_headers()
        for start in range(0, len(wire), 13): self.wfile.write(wire[start:start + 13]); self.wfile.flush()

class WireObserver(BaseHTTPRequestHandler):
    """Loopback-only test observer; no credential/header retention or transformation."""
    def log_message(self, *_): pass
    def do_POST(self):
        size = int(self.headers.get('content-length', '0'))
        if self.path != '/v1/responses' or size < 1 or size > 1024 * 1024 or len(self.server.records) >= 4:
            self.send_error(400); return
        raw = self.rfile.read(size)
        record = {'request': json.loads(raw), 'response_sse': ''}
        self.server.records.append(record)
        connection = http.client.HTTPConnection('127.0.0.1', self.server.target_port, timeout=30)
        try:
            headers = {k: v for k, v in self.headers.items() if k.lower() not in {'host', 'connection', 'transfer-encoding', 'accept-encoding'}}
            headers['accept-encoding'] = 'identity'
            connection.request('POST', self.path, raw, headers)
            response = connection.getresponse()
            record['status'] = response.status
            self.send_response(response.status)
            for name, value in response.getheaders():
                if name.lower() not in {'connection', 'transfer-encoding', 'content-length', 'server', 'date'}:
                    self.send_header(name, value)
            self.send_header('Connection', 'close'); self.end_headers()
            wire = bytearray()
            while chunk := response.read1(8192):
                wire.extend(chunk)
                if len(wire) > 4 * 1024 * 1024: raise RuntimeError('Fixture response exceeds bound')
                self.wfile.write(chunk); self.wfile.flush()
            record['response_sse'] = wire.decode('utf-8')
        finally:
            connection.close()

def env_for(folder):
    allow = {'PATH', 'SYSTEMROOT', 'WINDIR', 'PATHEXT', 'COMSPEC'}
    env = {k: v for k, v in os.environ.items() if k.upper() in allow}
    for name in ['TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']:
        env[name] = str(folder)
    env['PYTHONDONTWRITEBYTECODE'] = '1'
    return env

report = {'scope': 'actual Codex CLI / stock LiteLLM / fake Anthropic; no live provider',
          'litellm_version': importlib.metadata.version('litellm'), 'before': identities(), 'scenarios': [],
          'not_tested': ['real Claude acceptance', 'subscription authorization', 'real cache hits', 'billing', '.7 deployed gateway', 'Claude Code client', 'OS-enforced network isolation']}
if report['litellm_version'] != '1.103.1': raise SystemExit('Expected stock LiteLLM 1.103.1')
report['codex_version'] = subprocess.check_output([str(codex), '--version'], text=True, env=env_for(output)).strip()
with codex.open('rb') as executable:
    report['codex_sha256'] = hashlib.file_digest(executable, 'sha256').hexdigest()
fake = ThreadingHTTPServer(('127.0.0.1', 0), Fake)
fake.requests = []; fake.issued = []; fake.replayed = None; fake.failure = None
thread = threading.Thread(target=fake.serve_forever, daemon=True); thread.start()
fake_url = 'http://127.0.0.1:' + str(fake.server_port)
config = {'model_list': [{'model_name': 'claude-fixture', 'litellm_params': {'model': 'anthropic/' + model, 'api_key': 'sk-ant-local-fake-only', 'api_base': fake_url}}],
          'litellm_settings': {'telemetry': False, 'num_retries': 0, 'callbacks': []}, 'router_settings': {'num_retries': 0},
          'general_settings': {'master_key': 'os.environ/LOCAL_GATEWAY_KEY'}}
config_path = output / 'gateway.yaml'; config_path.write_text(yaml.safe_dump(config), encoding='utf-8')
env = env_for(output); env.update({'CONFIG_FILE_PATH': str(config_path), 'LOCAL_GATEWAY_KEY': key, 'ANTHROPIC_API_KEY': 'sk-ant-local-fake-only', 'ANTHROPIC_BASE_URL': fake_url, 'LITELLM_LOCAL_MODEL_COST_MAP': 'True'})
process = subprocess.Popen([sys.executable, str(root / 'integration/litellm/boot_gateway.py')], cwd=output, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding='utf-8', errors='replace', creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
lines = queue.Queue(); logs = []
def read_logs():
    for line in process.stdout: logs.append(line); lines.put(line)
reader = threading.Thread(target=read_logs, daemon=True); reader.start()
observer = None; observer_thread = None
try:
    deadline = time.monotonic() + 45; gateway = None
    while time.monotonic() < deadline:
        try: line = lines.get(timeout=.2)
        except queue.Empty:
            if process.poll() is not None: break
            line = ''
        if line.startswith('LOCAL_GATEWAY_PORT='): gateway = 'http://127.0.0.1:' + line.strip().split('=')[1]
        if gateway and 'Application startup complete' in line: break
        if gateway:
            import urllib.request
            try:
                urllib.request.build_opener(urllib.request.ProxyHandler({})).open(gateway + '/health/liveliness', timeout=.5).close(); break
            except Exception: pass
    if not gateway: raise RuntimeError('Gateway startup failed')
    observer = ThreadingHTTPServer(('127.0.0.1', 0), WireObserver)
    observer.target_port = int(gateway.rsplit(':', 1)[1]); observer.records = []
    observer_thread = threading.Thread(target=observer.serve_forever, daemon=True); observer_thread.start()
    for mode in ['signed_nonempty', 'full_opaque']:
        fake.mode = mode; fake.requests = []; fake.issued = []; fake.replayed = None; fake.failure = None
        observer.records = []
        folder = output / mode; folder.mkdir(); workspace = folder / 'workspace'; workspace.mkdir()
        (folder / 'codex-state').mkdir()
        client_env = env_for(folder); client_env.update({'CODEX_HOME': str(folder / 'codex-state'), 'CODEX_FIXTURE_KEY': key, 'RUST_LOG': 'error'})
        overrides = {'model_provider': 'fixture', 'model': 'claude-fixture',
                     'web_search': 'disabled', 'model_providers.fixture.name': 'Local synthetic fixture',
                     'model_providers.fixture.base_url': 'http://127.0.0.1:' + str(observer.server_port) + '/v1', 'model_providers.fixture.wire_api': 'responses',
                     'model_providers.fixture.env_key': 'CODEX_FIXTURE_KEY', 'model_providers.fixture.requires_openai_auth': False,
                     'model_providers.fixture.supports_websockets': False, 'model_providers.fixture.request_max_retries': 0,
                     'model_providers.fixture.stream_max_retries': 0, 'model_providers.fixture.stream_idle_timeout_ms': 15000}
        cmd = [str(codex), 'exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--json', '-C', str(workspace)]
        for name, value in overrides.items(): cmd += ['-c', name + '=' + json.dumps(value)]
        cmd += ['Synthetic protocol test. Do not read files, run commands, access the network or use external tools. Only the read-only get_goal tool may be used. Finish with CODEX_FIXTURE_OK.']
        try:
            completed = subprocess.run(cmd, cwd=workspace, env=client_env, stdin=subprocess.DEVNULL, capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=60)
            events = [json.loads(line) for line in completed.stdout.splitlines() if line.strip()]
            finals = [e.get('item', {}).get('text') for e in events if e.get('type') == 'item.completed' and e.get('item', {}).get('type') == 'agent_message']
            item = {'mode': mode, 'exit_code': completed.returncode, 'terminal_marker_seen': finals == ['CODEX_FIXTURE_OK'],
                    'turn_completed': any(e.get('type') == 'turn.completed' for e in events),
                    'model_metadata_fallback_warning': 'Model metadata for' in completed.stdout}
            (folder / 'client-events.jsonl').write_text(completed.stdout.replace(key, '[LOCAL_FIXTURE_KEY]'), encoding='utf-8')
            (folder / 'client-stderr.log').write_text(completed.stderr.replace(key, '[LOCAL_FIXTURE_KEY]'), encoding='utf-8')
        except subprocess.TimeoutExpired:
            item = {'mode': mode, 'timed_out': True}
        assistant = [b for m in (fake.replayed or {}).get('messages', []) if m.get('role') == 'assistant' for b in m.get('content', []) if isinstance(b, dict)]
        signed = [b for b in fake.issued if b['type'] == 'thinking']
        results = [b for m in (fake.replayed or {}).get('messages', []) for b in m.get('content', []) if isinstance(b, dict) and b.get('type') == 'tool_result']
        correct_result = len(results) == 1 and results[0].get('tool_use_id') == 'toolu_fixture_goal' and not results[0].get('is_error', False)
        response_events = [json.loads(line[6:]) for r in observer.records[:1] for line in r['response_sse'].splitlines() if line.startswith('data: ') and line[6:] != '[DONE]']
        complete_responses = [e['response'] for e in response_events if e.get('type') == 'response.completed']
        delivered_reasoning = [i for r in complete_responses for i in r.get('output', []) if i.get('type') == 'reasoning']
        done_reasoning = [e['item'] for e in response_events if e.get('type') == 'response.output_item.done' and e.get('item', {}).get('type') == 'reasoning']
        opaque = []
        for reasoning in delivered_reasoning:
            try:
                decoded = json.loads(reasoning.get('encrypted_content') or 'null')
            except ValueError:
                decoded = None
            if isinstance(decoded, list): opaque.extend(decoded)
        client_reasoning = [i for r in observer.records[1:2] for i in r['request'].get('input', []) if isinstance(i, dict) and i.get('type') == 'reasoning']
        item.update({'upstream_requests': len(fake.requests), 'fixture_failure': fake.failure,
                     'tool_result_replayed': correct_result,
                     'ordered_assistant_exact': bool(fake.issued) and assistant == fake.issued,
                     'responses_requests': len(observer.records),
                     'delivered_reasoning_items': len(delivered_reasoning),
                     'delivered_encrypted_content': sum(bool(i.get('encrypted_content')) for i in delivered_reasoning),
                     'done_event_encrypted_content': sum(bool(i.get('encrypted_content')) for i in done_reasoning),
                     'completed_opaque_exact': bool(fake.issued) and opaque == [b for b in fake.issued if b['type'] in {'thinking', 'redacted_thinking'}],
                     'client_replayed_reasoning_items': len(client_reasoning),
                     'client_replayed_encrypted_content': sum(bool(i.get('encrypted_content')) for i in client_reasoning),
                     'signed_nonempty_preserved': bool(signed) and signed[0] in assistant,
                     'signed_empty_preserved': None if mode != 'full_opaque' else len(signed) > 1 and signed[1] in assistant,
                     'redacted_preserved': None if mode != 'full_opaque' else len(fake.issued) > 2 and fake.issued[2] in assistant,
                     'gateway_key_leaked': any(r['gateway_key_leaked'] for r in fake.requests)})
        report['scenarios'].append(item)
        (folder / 'fake-requests.json').write_text(json.dumps(fake.requests, indent=2).replace(key, '[LOCAL_FIXTURE_KEY]'), encoding='utf-8')
        (folder / 'responses-wire.json').write_text(json.dumps(observer.records, indent=2).replace(key, '[LOCAL_FIXTURE_KEY]'), encoding='utf-8')
        print(json.dumps(item), flush=True)
finally:
    if observer:
        observer.shutdown(); observer.server_close(); observer_thread.join(3)
    if process.poll() is None: process.terminate()
    try: process.wait(timeout=5)
    except subprocess.TimeoutExpired: process.kill(); process.wait(timeout=5)
    reader.join(3); process.stdout.close(); fake.shutdown(); fake.server_close(); thread.join(3)
    (output / 'gateway.log').write_text(''.join(logs).replace(key, '[LOCAL_FIXTURE_KEY]'), encoding='utf-8')
    report['after'] = identities(); report['source_unchanged'] = report['before'] == report['after']
    report['observation_completed'] = report['source_unchanged'] and len(report['scenarios']) == 2 and all(s.get('exit_code') == 0 and s.get('terminal_marker_seen') and s.get('turn_completed') and s.get('fixture_failure') is None and s.get('upstream_requests') == 2 and s.get('responses_requests') == 2 and s.get('tool_result_replayed') and not s.get('gateway_key_leaked') for s in report['scenarios'])
    report['full_fidelity'] = report['observation_completed'] and all(s.get('ordered_assistant_exact') for s in report['scenarios'])
    (output / 'codex-smoke.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
print('Report:', output / 'codex-smoke.json')
print('Full tested fidelity:', report['full_fidelity'])
raise SystemExit(0 if report['full_fidelity'] or args.observe_only and report['observation_completed'] else 1)
