"""Actual isolated Claude Code -> stock LiteLLM passthrough -> native relay -> fake Anthropic.

Synthetic credentials and a one-line temp fixture only. No provider, existing
account, user configuration, global install, remote deployment or source patch.
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
import threading
import time
import urllib.request
import yaml

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--claude', type=Path, required=True, help='Official pinned native Claude Code executable')
parser.add_argument('--output', type=Path, required=True, help='New evidence directory outside repository')
parser.add_argument('--node', type=Path, help='Existing Node executable (otherwise PATH node)')
parser.add_argument('--signature-events', choices=['single', 'replacement', 'split'], default='single',
                    help='Single full signature (default), repeated full-value replacement, or non-normative split-part observation; all use seven-byte transport chunks')
parser.add_argument('--observe-only', action='store_true', help='Exit zero for a completed observation even when state or whole-body fidelity fails')
args = parser.parse_args()
root = Path(__file__).resolve().parents[2]
output = args.output.resolve()
if output.exists() or output == root or root in output.parents:
    raise SystemExit('Use a new evidence directory outside the repository')
output.mkdir(parents=True)
claude = args.claude.resolve(strict=True)
node = args.node.resolve(strict=True) if args.node else shutil.which('node')
if not node: raise SystemExit('Pass an existing --node executable')
model = 'claude-sonnet-4-6'
key = 'sk-local-claude-fixture-' + secrets.token_hex(24)
relay_key = None
marker = 'CLAUDE_CODE_FIXTURE_OK'
fixture_text = 'SYNTHETIC_READ_FIXTURE_87f349'
response_path = '/claude-native/v1/messages'
creationflags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0

def redact(value):
    for credential in [key, relay_key, 'sk-ant-local-fake-only']:
        if credential: value = value.replace(credential, '[LOCAL_FIXTURE_KEY]')
    return value

def env_for(folder):
    allow = {'PATH', 'SYSTEMROOT', 'WINDIR', 'PATHEXT', 'COMSPEC'}
    env = {name: value for name, value in os.environ.items() if name.upper() in allow}
    for name in ['TEMP', 'TMP', 'TMPDIR', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOME', 'ProgramData',
                 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME']:
        env[name] = str(folder)
    env['PYTHONDONTWRITEBYTECODE'] = '1'
    return env

def identities():
    tree = ast.parse((root / 'integration/litellm/test_stock_gateway.py').read_text(encoding='utf-8'))
    expected = next(ast.literal_eval(node.value) for node in tree.body if isinstance(node, ast.Assign)
                    and any(isinstance(target, ast.Name) and target.id == 'EXPECTED' for target in node.targets))
    package = Path(importlib.util.find_spec('litellm').origin).parent.parent
    actual = {}
    for name, wanted in expected.items():
        raw = (package / name).read_bytes().replace(b'\r\n', b'\n')
        actual[name] = hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest()
        if actual[name] != wanted: raise RuntimeError('Stock source identity mismatch: ' + name)
    return actual

def stop_process(child):
    if child is None: return
    if child.poll() is None: child.terminate()
    try: child.wait(timeout=5)
    except subprocess.TimeoutExpired: child.kill(); child.wait(timeout=5)

def event(kind, value):
    return ('event: ' + kind + '\r\ndata: ' + json.dumps(value, ensure_ascii=False) + '\r\n\r\n').encode()


def signature_event_values(signature, mode):
    if mode == 'single':
        return [signature]
    if mode == 'replacement':
        return ['synthetic-previous-complete-signature+/=', signature]
    if mode == 'split':
        # Historical unsupported oracle input, not a concatenation contract.
        return [signature[:8], signature[8:]]
    raise ValueError('Unknown signature event fixture')


def signature_qualification(mode, observation_completed, sdk_state_exact, whole_body_exact):
    eligible = mode != 'split'
    return {'qualification_scope': 'single_full_signature' if mode == 'single' else
            'sdk_full_value_replacement' if eligible else 'non_normative_split_observation',
            'state_subset_pass': bool(observation_completed and sdk_state_exact) if eligible else None,
            'strict_qualification_pass': bool(observation_completed and sdk_state_exact and whole_body_exact) if eligible else None,
            'split_signature_preserved': None}


class Fake(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_POST(self):
        size = int(self.headers.get('content-length', '0'))
        if size < 1 or size > 1024 * 1024: self.send_error(413); return
        raw = self.rfile.read(size)
        try: body = json.loads(raw)
        except ValueError: self.send_error(400); return
        self.server.requests.append({'path': self.path, 'body': body,
            'synthetic_upstream_auth': self.headers.get('x-api-key') == 'sk-ant-local-fake-only' and not self.headers.get('authorization'),
            'gateway_key_leaked': key in self.path or key.encode() in raw or any(key in value for value in self.headers.values()),
            'relay_key_leaked': bool(relay_key) and (relay_key in self.path or relay_key.encode() in raw or any(relay_key in value for value in self.headers.values()))})
        self.server.raw_requests.append(raw)
        self.server.beta_headers.append(self.headers.get('anthropic-beta'))
        if self.path.split('?')[0] != '/v1/messages' or len(self.server.requests) > 2 or body.get('model') != model or body.get('stream') is not True:
            self.server.failure = 'unexpected_request_shape_or_count'; self.send_error(400); return
        results = [block for message in body.get('messages', []) for block in message.get('content', [])
                   if isinstance(block, dict) and block.get('type') == 'tool_result']
        if not results:
            if [tool.get('name') for tool in body.get('tools', [])] != ['Read']:
                self.server.failure = 'only_Read_must_be_offered'; self.send_error(400); return
            content = [{'type': 'thinking', 'thinking': 'Synthetic 한글 🧪 reasoning only.', 'signature': 'fixture-nonempty-signature+/='}]
            if self.server.mode == 'full_opaque':
                content += [{'type': 'thinking', 'thinking': '', 'signature': 'fixture-empty-signature+/='},
                            {'type': 'redacted_thinking', 'data': 'fixture-redacted-data+/='}]
            content += [{'type': 'tool_use', 'id': 'toolu_local_Read', 'name': 'Read',
                         'input': {'file_path': str(self.server.fixture), 'offset': 1, 'limit': 1}}]
            self.server.issued = copy.deepcopy(content)
            self.respond_stream(content, 'tool_use')
        else:
            self.server.replayed = copy.deepcopy(body)
            self.respond_stream([{'type': 'text', 'text': marker}], 'end_turn')

    def respond_stream(self, content, reason):
        message = {'id': 'msg_claude_fixture', 'type': 'message', 'role': 'assistant', 'model': model,
                   'content': [], 'stop_reason': None, 'stop_sequence': None,
                   'usage': {'input_tokens': 10, 'output_tokens': 0, 'cache_read_input_tokens': 80, 'cache_creation_input_tokens': 0}}
        wire = event('message_start', {'type': 'message_start', 'message': message})
        for index, block in enumerate(content):
            kind = block['type']
            initial = {'type': 'thinking', 'thinking': ''} if kind == 'thinking' else {**block, 'input': {}} if kind == 'tool_use' else {'type': 'text', 'text': ''} if kind == 'text' else block
            wire += event('content_block_start', {'type': 'content_block_start', 'index': index, 'content_block': initial})
            deltas = []
            if kind == 'thinking':
                text = block['thinking']
                deltas += [{'type': 'thinking_delta', 'thinking': part} for part in [text[:9], text[9:]] if part]
                if not text: deltas.append({'type': 'thinking_delta', 'thinking': ''})
                signature = block['signature']
                values = signature_event_values(signature, args.signature_events)
                deltas += [{'type': 'signature_delta', 'signature': value} for value in values]
            elif kind == 'tool_use':
                encoded = json.dumps(block['input'], ensure_ascii=False)
                deltas += [{'type': 'input_json_delta', 'partial_json': part} for part in [encoded[:9], encoded[9:]]]
            elif kind == 'text': deltas = [{'type': 'text_delta', 'text': block['text']}]
            for delta in deltas: wire += event('content_block_delta', {'type': 'content_block_delta', 'index': index, 'delta': delta})
            wire += event('content_block_stop', {'type': 'content_block_stop', 'index': index})
        wire += event('message_delta', {'type': 'message_delta', 'delta': {'stop_reason': reason, 'stop_sequence': None}, 'usage': {'output_tokens': 9}})
        wire += event('message_stop', {'type': 'message_stop'})
        self.server.wires.append(wire)
        self.send_response(200); self.send_header('content-type', 'text/event-stream'); self.send_header('content-length', str(len(wire))); self.end_headers()
        for offset in range(0, len(wire), 7):
            self.wfile.write(wire[offset:offset + 7]); self.wfile.flush()

class Observer(BaseHTTPRequestHandler):
    """Fixture-only raw-byte observer and rejecting incidental-network proxy."""
    def log_message(self, *_): pass
    def do_CONNECT(self):
        self.server.blocked += 1; self.send_error(502)
    def do_GET(self):
        self.server.blocked += 1; self.send_error(502)
    def do_POST(self):
        size = int(self.headers.get('content-length', '0'))
        if self.path.split('?')[0] != response_path or size < 1 or size > 1024 * 1024 or len(self.server.records) >= 2:
            self.server.blocked += 1; self.send_error(400); return
        raw = self.rfile.read(size)
        record = {'request': json.loads(raw), 'response_sse': ''}
        self.server.records.append(record); self.server.raw_requests.append(raw)
        self.server.beta_headers.append(self.headers.get('anthropic-beta'))
        connection = http.client.HTTPConnection('127.0.0.1', self.server.target_port, timeout=30)
        try:
            headers = {name: value for name, value in self.headers.items() if name.lower() not in {'host', 'connection', 'transfer-encoding', 'accept-encoding'}}
            headers['accept-encoding'] = 'identity'
            connection.request('POST', self.path, raw, headers)
            response = connection.getresponse(); record['status'] = response.status
            self.send_response(response.status)
            for name, value in response.getheaders():
                if name.lower() not in {'connection', 'transfer-encoding', 'content-length', 'server', 'date'}: self.send_header(name, value)
            self.send_header('Connection', 'close'); self.end_headers()
            wire = bytearray()
            while chunk := response.read1(8192):
                wire.extend(chunk)
                if len(wire) > 4 * 1024 * 1024: raise RuntimeError('Synthetic response exceeds bound')
                self.wfile.write(chunk); self.wfile.flush()
            self.server.wires.append(bytes(wire)); record['response_sse'] = wire.decode('utf-8')
        finally: connection.close()

def launch(command, env, folder, prefix, timeout):
    child = subprocess.Popen(command, cwd=folder, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT, text=True, encoding='utf-8', errors='replace', creationflags=creationflags)
    lines = queue.Queue(); log = []
    def read():
        captured = 0
        for line in child.stdout:
            captured += len(line)
            if captured <= 1024 * 1024: log.append(line); lines.put(line)
    reader = threading.Thread(target=read, daemon=True); reader.start()
    ready = None; deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try: line = lines.get(timeout=.2)
        except queue.Empty:
            if child.poll() is not None: break
            continue
        if prefix == 'relay':
            try: value = json.loads(line)
            except ValueError: continue
            if isinstance(value.get('local_relay_port'), int) and isinstance(value.get('local_relay_key'), str): ready = value; break
        elif line.startswith('LOCAL_GATEWAY_PORT='):
            ready = int(line.strip().split('=')[1]); break
    if ready is None:
        stop_process(child); reader.join(3); child.stdout.close()
        raise RuntimeError(prefix + '_startup_failed')
    return child, reader, log, ready

report = {'scope': 'actual Claude Code / unmodified stock passthrough / current native relay / fake Anthropic',
    'signature_events': args.signature_events,
    'litellm_version': importlib.metadata.version('litellm'), 'before': identities(), 'scenarios': [],
    'not_tested': ['real provider/signature validation', 'billing/cache hits', 'OS-enforced isolation', 'deployed .7 gateway', 'long session/compaction']}
if report['litellm_version'] != '1.103.1': raise SystemExit('Use pristine stock LiteLLM1.103.1 Python')
fake = ThreadingHTTPServer(('127.0.0.1', 0), Fake)
fake_thread = threading.Thread(target=fake.serve_forever, daemon=True); fake_thread.start()
observer = ThreadingHTTPServer(('127.0.0.1', 0), Observer); observer.blocked = 0; observer.records = []; observer.target_port = 0
observer_thread = threading.Thread(target=observer.serve_forever, daemon=True); observer_thread.start()
proxy_url = 'http://127.0.0.1:' + str(observer.server_port)
fake_url = 'http://127.0.0.1:' + str(fake.server_port)
relay_process = gateway_process = relay_reader = gateway_reader = None
relay_logs = []; gateway_logs = []
try:
    service_env = env_for(output)
    service_env.update({'HTTP_PROXY': proxy_url, 'HTTPS_PROXY': proxy_url, 'ALL_PROXY': proxy_url, 'NO_PROXY': '127.0.0.1,localhost'})
    relay_process, relay_reader, relay_logs, ready = launch([str(node), str(root / 'integration/clients/boot_responses_relay.mjs'), fake_url], service_env, output, 'relay', 20)
    relay_key = ready['local_relay_key']; relay_url = 'http://127.0.0.1:' + str(ready['local_relay_port'])
    config = {'litellm_settings': {'telemetry': False, 'num_retries': 0, 'callbacks': []}, 'router_settings': {'num_retries': 0},
        'general_settings': {'master_key': 'os.environ/LOCAL_GATEWAY_KEY', 'pass_through_endpoints': [{
            'path': response_path, 'target': relay_url + '/v1/messages', 'auth': True, 'methods': ['POST'], 'forward_headers': True,
            'headers': {'Authorization': 'os.environ/LOCAL_RELAY_AUTHORIZATION', 'x-api-key': ''}}]}}
    config_path = output / 'gateway.yaml'; config_path.write_text(yaml.safe_dump(config), encoding='utf-8')
    service_env.update({'CONFIG_FILE_PATH': str(config_path), 'LOCAL_GATEWAY_KEY': key,
        'LOCAL_RELAY_AUTHORIZATION': 'Bearer ' + relay_key, 'LITELLM_LOCAL_MODEL_COST_MAP': 'True'})
    gateway_process, gateway_reader, gateway_logs, gateway_port = launch([sys.executable, str(root / 'integration/litellm/boot_gateway.py')], service_env, output, 'gateway', 45)
    observer.target_port = gateway_port
    gateway_url = 'http://127.0.0.1:' + str(gateway_port)
    deadline = time.monotonic() + 30
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    while time.monotonic() < deadline:
        try: opener.open(gateway_url + '/health/liveliness', timeout=.5).close(); break
        except Exception: time.sleep(.1)
    else: raise RuntimeError('gateway_health_timeout')
    for mode in ['signed_nonempty', 'full_opaque']:
        folder = output / mode; folder.mkdir(); workspace = folder / 'workspace'; workspace.mkdir()
        state = folder / 'claude-state'; state.mkdir()
        local_fixture = workspace / 'fixture.txt'; local_fixture.write_text(fixture_text + '\n', encoding='utf-8')
        settings = folder / 'settings.json'; settings.write_text(json.dumps({'permissions': {'allow': ['Read(./fixture.txt)'],
            'deny': ['Bash', 'Edit', 'Write', 'WebFetch', 'WebSearch', 'Agent', 'Task', 'Skill']}, 'hooks': {}, 'autoMemoryEnabled': False}), encoding='utf-8')
        client_env = env_for(folder)
        client_env.update({'CLAUDE_CONFIG_DIR': str(state), 'ANTHROPIC_BASE_URL': proxy_url + '/claude-native', 'ANTHROPIC_API_KEY': key,
            'ANTHROPIC_MODEL': model, 'ANTHROPIC_DEFAULT_HAIKU_MODEL': model, 'ANTHROPIC_DEFAULT_SONNET_MODEL': model,
            'HTTP_PROXY': proxy_url, 'HTTPS_PROXY': proxy_url, 'ALL_PROXY': proxy_url, 'NO_PROXY': '127.0.0.1,localhost',
            'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1', 'CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL': '1',
            'CLAUDE_CODE_DISABLE_CLAUDE_MDS': '1', 'CLAUDE_CODE_DISABLE_POLICY_SKILLS': '1', 'CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS': '1',
            'CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK': '1', 'CLAUDE_CODE_DISABLE_TERMINAL_TITLE': '1',
            'CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING': '1', 'CLAUDE_CODE_DISABLE_CRON': '1', 'CLAUDE_CODE_MAX_RETRIES': '0',
            'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY': '0', 'ENABLE_TOOL_SEARCH': 'false', 'DISABLE_AUTOUPDATER': '1',
            'DISABLE_TELEMETRY': '1', 'DISABLE_ERROR_REPORTING': '1', 'DISABLE_COMPACT': '1', 'MAX_THINKING_TOKENS': '1024'})
        if 'claude_version' not in report:
            version = subprocess.run([str(claude), '--version'], cwd=workspace, env=client_env, capture_output=True, text=True, timeout=15, creationflags=creationflags)
            report['claude_version'] = version.stdout.strip()
            if version.returncode != 0 or not report['claude_version'].startswith('2.1.289 '): raise RuntimeError('Expected official pinned Claude Code2.1.289')
            with claude.open('rb') as executable: report['claude_sha256'] = hashlib.file_digest(executable, 'sha256').hexdigest()
        fake.mode = mode; fake.fixture = local_fixture; fake.requests = []; fake.raw_requests = []; fake.beta_headers = []
        fake.issued = []; fake.replayed = None; fake.failure = None; fake.wires = []
        observer.records = []; observer.raw_requests = []; observer.beta_headers = []; observer.wires = []
        command = [str(claude), '-p', 'Synthetic protocol test. Use only Read to read fixture.txt, then return ' + marker + '.',
            '--model', model, '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
            '--tools', 'Read', '--allowedTools', 'Read(./fixture.txt)', '--permission-mode', 'dontAsk',
            '--settings', str(settings), '--setting-sources', '', '--no-session-persistence', '--strict-mcp-config',
            '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands', '--max-turns', '3']
        try:
            result = subprocess.run(command, cwd=workspace, env=client_env, stdin=subprocess.DEVNULL, capture_output=True,
                text=True, encoding='utf-8', errors='replace', timeout=60, creationflags=creationflags)
            events = [json.loads(line) for line in result.stdout.splitlines() if line.strip()]
            final = [item for item in events if item.get('type') == 'result']
            item = {'mode': mode, 'exit_code': result.returncode, 'successful_final': len(final) == 1 and final[0].get('subtype') == 'success'
                and final[0].get('is_error') is False and final[0].get('result') == marker,
                'client_result_count': len(final), 'client_event_count': len(events)}
            (folder / 'client-events.jsonl').write_text(redact(result.stdout), encoding='utf-8')
            (folder / 'client-stderr.log').write_text(redact(result.stderr), encoding='utf-8')
        except subprocess.TimeoutExpired:
            item = {'mode': mode, 'timed_out': True}
        assistant = [block for message in (fake.replayed or {}).get('messages', []) if message.get('role') == 'assistant'
                     for block in message.get('content', []) if isinstance(block, dict)]
        results = [block for message in (fake.replayed or {}).get('messages', []) if message.get('role') == 'user'
                   for block in message.get('content', []) if isinstance(block, dict) and block.get('type') == 'tool_result']
        tool_result_ok = len(results) == 1 and results[0].get('tool_use_id') == 'toolu_local_Read' and not results[0].get('is_error', False)
        tool_result_has_fixture = tool_result_ok and fixture_text in json.dumps(results[0].get('content'))
        signed = [block for block in fake.issued if block['type'] == 'thinking']
        metadata_removed_only = len(fake.requests) == 2 and len(observer.records) == 2 and all(
            'metadata' in sent['request'] and 'metadata' not in received['body']
            and {name: value for name, value in sent['request'].items() if name != 'metadata'} == received['body']
            for sent, received in zip(observer.records, fake.requests))
        sdk_expected = copy.deepcopy(fake.issued)
        for block in sdk_expected:
            if block.get('type') == 'thinking':
                block['signature'] = signature_event_values(block['signature'], args.signature_events)[-1]
        normative = args.signature_events != 'split'
        item.update({'upstream_requests': len(fake.requests), 'gateway_requests': len(observer.records), 'fixture_failure': fake.failure,
            'tool_result_replayed': tool_result_ok, 'local_fixture_read': tool_result_has_fixture,
            'signature_oracle': 'sdk_last_event_value', 'normative_signature_case': normative,
            'ordered_assistant_original_value_match': bool(fake.issued) and assistant == fake.issued,
            'ordered_assistant_exact': bool(fake.issued) and assistant == sdk_expected if normative else None,
            'ordered_assistant_sdk_expected_exact': bool(fake.issued) and assistant == sdk_expected,
            'signed_nonempty_preserved': bool(signed) and signed[0] in assistant if normative else None,
            'signed_empty_preserved': None if mode != 'full_opaque' or not normative else len(signed) > 1 and signed[1] in assistant,
            'redacted_preserved': None if mode != 'full_opaque' else len(fake.issued) > 2 and fake.issued[2] in assistant,
            'native_request_bytes_exact': len(fake.raw_requests) == 2 and fake.raw_requests == observer.raw_requests,
            'native_request_objects_exact': len(fake.requests) == 2 and [record['body'] for record in fake.requests] == [record['request'] for record in observer.records],
            'native_metadata_removed_only': metadata_removed_only,
            'native_sse_bytes_exact': len(fake.wires) == 2 and fake.wires == observer.wires,
            'beta_headers_exact': len(fake.beta_headers) == 2 and fake.beta_headers == observer.beta_headers,
            'http_success': len(observer.records) == 2 and all(record.get('status') == 200 for record in observer.records),
            'synthetic_upstream_auth': len(fake.requests) == 2 and all(record['synthetic_upstream_auth'] for record in fake.requests),
            'gateway_key_leaked': any(record['gateway_key_leaked'] for record in fake.requests),
            'relay_key_leaked': any(record['relay_key_leaked'] for record in fake.requests)})
        report['scenarios'].append(item)
        (folder / 'fake-requests.json').write_text(redact(json.dumps(fake.requests, ensure_ascii=False, indent=2)), encoding='utf-8')
        (folder / 'client-wire.json').write_text(redact(json.dumps(observer.records, ensure_ascii=False, indent=2)), encoding='utf-8')
        print(json.dumps(item), flush=True)
finally:
    for process, reader in [(gateway_process, gateway_reader), (relay_process, relay_reader)]:
        stop_process(process)
        if reader: reader.join(3)
        if process: process.stdout.close()
    observer.shutdown(); observer.server_close(); observer_thread.join(3)
    fake.shutdown(); fake.server_close(); fake_thread.join(3)
    (output / 'gateway.log').write_text(redact(''.join(gateway_logs)), encoding='utf-8')
    (output / 'relay.log').write_text(redact(''.join(relay_logs)), encoding='utf-8')
    report['after'] = identities(); report['source_unchanged'] = report['before'] == report['after']
    report['blocked_incidental_requests'] = observer.blocked
    report['observation_completed'] = report['source_unchanged'] and len(report['scenarios']) == 2 and all(
        item.get('exit_code') == 0 and item.get('successful_final') and item.get('fixture_failure') is None
        and item.get('upstream_requests') == 2 and item.get('gateway_requests') == 2 and item.get('http_success')
        and item.get('tool_result_replayed') and item.get('local_fixture_read') and item.get('synthetic_upstream_auth')
        and not item.get('gateway_key_leaked') and not item.get('relay_key_leaked') for item in report['scenarios'])
    sdk_state_exact = all(item.get('ordered_assistant_sdk_expected_exact')
        and (item.get('native_request_objects_exact') or item.get('native_metadata_removed_only'))
        and item.get('native_sse_bytes_exact') and item.get('beta_headers_exact') for item in report['scenarios'])
    report['whole_body_semantic_exact'] = report['observation_completed'] and all(item.get('native_request_objects_exact') for item in report['scenarios'])
    report.update(signature_qualification(args.signature_events, report['observation_completed'], sdk_state_exact,
                                          report['whole_body_semantic_exact']))
    report['split_concat_matches_observed'] = (report['observation_completed'] and all(
        item.get('ordered_assistant_original_value_match') for item in report['scenarios'])) if args.signature_events == 'split' else None
    report['split_sdk_last_event_matches_observed'] = (report['observation_completed'] and sdk_state_exact) if args.signature_events == 'split' else None
    (output / 'claude-code-smoke.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
print('Report:', output / 'claude-code-smoke.json')
print('State subset pass:', report['state_subset_pass'])
print('Whole body semantic exact:', report['whole_body_semantic_exact'])
print('Split signature preserved:', report['split_signature_preserved'])
strict_pass = report['strict_qualification_pass']
observation_only = args.observe_only or args.signature_events == 'split'
raise SystemExit(0 if strict_pass or observation_only and report['observation_completed'] else 1)
