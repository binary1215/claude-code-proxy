"""Actual Codex shell + multi-file patch workflow over the stock local chain.

Offline only: synthetic credentials and scripted loopback Anthropic responses.
The supplied opt-in catalog retains the stock Codex prompt and enables normal
unified_exec + freeform apply_patch. No client/source/OS permissions are changed.
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
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

import yaml
from codex_patch_smoke import ROOT, SOURCE, clean_env, identities, start, stop, event
from codex_compaction_smoke import Rpc
from generate_client_profiles import PROMPT_SHA256

MODEL = 'claude-haiku-4-5-20251001'
REQUEST_PATH = '/coding-workflow/v1/responses'
MAX_REQUESTS = 7
INITIAL_MARKER = 'CODEX_CODING_WORKFLOW_FIXED'
FOLLOWUP_MARKER = 'CODEX_CODING_WORKFLOW_RECHECKED'
READ_MARKER = 'CODING_FIXTURE_READ_OK'
FAIL_MARKER = 'CODING_FIXTURE_TEST_FAILED'
PASS_MARKER = 'CODING_FIXTURE_TEST_PASSED'
FILES = {
    'calculator.py': 'def add(a, b):\n    return a - b\n',
    'display.py': 'def label(value):\n    return "wrong=" + str(value)\n',
    'test_fixture.py': (
        'from calculator import add\nfrom display import label\n'
        'ok = add(2, 3) == 5 and label(5) == "result=5"\n'
        f'print("{PASS_MARKER}" if ok else "{FAIL_MARKER}", flush=True)\n'
        'raise SystemExit(0 if ok else 3)\n'
    ),
}
EXPECTED_FILES = {**FILES,
    'calculator.py': 'def add(a, b):\n    return a + b\n',
    'display.py': 'def label(value):\n    return "result=" + str(value)\n',
}
PATCH = ('*** Begin Patch\n*** Update File: calculator.py\n@@\n def add(a, b):\n'
         '-    return a - b\n+    return a + b\n*** Update File: display.py\n@@\n'
         ' def label(value):\n-    return "wrong=" + str(value)\n'
         '+    return "result=" + str(value)\n*** End Patch')


def offered_tools(request):
    result = []
    for tool in request.get('tools', []):
        if tool.get('type') == 'namespace':
            result.extend((child, tool.get('name')) for child in tool.get('tools', []))
        else:
            result.append((tool, None))
    return result


def native_name(name, namespace):
    if namespace is None:
        return name
    encoded = json.dumps([namespace, name], ensure_ascii=False, separators=(',', ':')).encode()
    return 'ns_' + hashlib.sha256(encoded).hexdigest()[:60]


def catalog_entry(catalog, model):
    entries = [item for item in catalog.get('models', []) if item.get('slug') == model]
    if len(entries) != 1:
        raise ValueError('Catalog must contain exactly one selected native model entry')
    entry = entries[0]
    prompt = entry.get('model_messages', {}).get('instructions_template') or entry.get('base_instructions')
    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError('A supplied stock prompt is required; no replacement fixture system prompt')
    if entry.get('shell_type') != 'unified_exec' or entry.get('apply_patch_tool_type') != 'freeform':
        raise ValueError('Catalog must expose unified_exec and freeform apply_patch together')
    if entry.get('upgrade') is not None:
        raise ValueError('Selected native model must not advertise an implicit model migration')
    return entry


def catalog_prompt_sha256(entry):
    prompt = entry.get('model_messages', {}).get('instructions_template') or entry.get('base_instructions')
    return hashlib.sha256(prompt.encode()).hexdigest()


def catalog_list_evidence(result, model):
    entries = result.get('data', [])
    selected = [item for item in entries if item.get('model') == model]
    return {'selected_model_listed': len(selected) == 1,
            'listed_models': [item.get('model') for item in entries],
            'model_list_selected': selected}


def check_catalog_only(codex, catalog_path, output, model):
    """Read-only app-server model/list; no server, inference or tool execution."""
    (output / 'codex-state').mkdir()
    env = clean_env(output)
    env.update(CODEX_HOME=str(output / 'codex-state'), CODEX_FIXTURE_KEY='sk-local-catalog-only', RUST_LOG='error')
    settings = {'model': model, 'model_provider': 'fixture', 'model_catalog_json': str(catalog_path),
        'analytics.enabled': False, 'feedback.enabled': False, 'check_for_update_on_startup': False,
        'otel.exporter': 'none', 'otel.trace_exporter': 'none', 'cli_auth_credentials_store': 'file',
        'model_providers.fixture.name': 'Local catalog check only',
        'model_providers.fixture.base_url': 'http://127.0.0.1:9/v1',
        'model_providers.fixture.wire_api': 'responses', 'model_providers.fixture.env_key': 'CODEX_FIXTURE_KEY',
        'model_providers.fixture.requires_openai_auth': False, 'model_providers.fixture.supports_websockets': False}
    command = [str(codex), 'app-server', '--stdio']
    for name, value in settings.items():
        command.extend(['-c', name + '=' + json.dumps(value)])
    rpc = Rpc(command, env, output)
    try:
        rpc.request(0, 'initialize', {'clientInfo': {'name': 'catalog_check', 'version': '1.0'}, 'capabilities': {'experimentalApi': True}})
        rpc.send({'method': 'initialized', 'params': {}})
        evidence = catalog_list_evidence(rpc.request(1, 'model/list', {}), model)
        evidence.update(scope='actual pinned Codex model/list only; no inference or tool execution',
            codex_version=subprocess.check_output([str(codex), '--version'], env=env, text=True).strip())
    finally:
        rpc.close()
        (output / 'client-stderr.log').write_text(''.join(rpc.stderr), encoding='utf-8')
    evidence['passed'] = evidence['selected_model_listed'] and evidence['codex_version'] == 'codex-cli 0.160.0'
    (output / 'catalog-check.json').write_text(json.dumps(evidence, indent=2), encoding='utf-8')
    print(json.dumps(evidence, indent=2))
    return 0 if evidence['passed'] else 1


def shell_arguments(command, workspace):
    # The pinned unified_exec tool executes the client's ordinary configured shell.
    return {'cmd': command, 'workdir': str(workspace), 'yield_time_ms': 10000, 'max_output_tokens': 2000}


def fixture_commands(python, windows):
    code = ('from pathlib import Path; '
            f'print({READ_MARKER!r}); '
            'print(Path("calculator.py").read_text()); print(Path("display.py").read_text())')
    if windows:
        quote = lambda text: "'" + str(text).replace("'", "''") + "'"
        interpreter = '& ' + quote(python)
    else:
        import shlex
        quote = shlex.quote
        interpreter = quote(str(python))
    return interpreter + ' -B -c ' + quote(code), interpreter + ' -B test_fixture.py'


def native_blocks(body, role=None, kinds=None):
    return [block for message in body.get('messages', []) if role is None or message.get('role') == role
            for block in message.get('content', []) if isinstance(block, dict)
            and (kinds is None or block.get('type') in kinds)]


def wire_output(record):
    events = [json.loads(line[6:]) for line in record.get('response_sse', '').splitlines()
              if line.startswith('data: ') and line[6:] != '[DONE]']
    done = [event['item'] for event in events if event.get('type') == 'response.output_item.done']
    completed = [event['response'] for event in events if event.get('type') == 'response.completed']
    return done, completed


def capsules(items):
    return [(item.get('id'), item.get('encrypted_content')) for item in items if item.get('type') == 'reasoning']


def projected_tool_results(request):
    results = []
    for item in request.get('input', []):
        if item.get('type') not in ('function_call_output', 'custom_tool_call_output'):
            continue
        value = item.get('output')
        if isinstance(value, list):
            converted = []
            for block in value:
                if block.get('type') not in ('input_text', 'output_text', 'text') or not isinstance(block.get('text'), str):
                    raise ValueError('The fixture oracle does not support this tool-result content')
                converted.append({'type': 'text', 'text': block['text'],
                                  **({'cache_control': block['cache_control']} if 'cache_control' in block else {})})
            value = converted
        elif not isinstance(value, str):
            raise ValueError('The fixture expected text tool results')
        results.append({'type': 'tool_result', 'tool_use_id': item['call_id'], 'content': value,
            **{key: item[key] for key in ('is_error', 'cache_control') if key in item}})
    return results


def workflow_evidence(records, upstream, events, files, terminal_statuses):
    """Independent report predicates: a model's final marker is not execution proof."""
    requests_ok = len(records) == len(upstream) == MAX_REQUESTS
    replay_checks, prior_capsules, done_calls = [], [], []
    for index, record in enumerate(records):
        try:
            done, completed = wire_output(record)
            replay = capsules(record.get('request', {}).get('input', []))
            emitted = capsules(done)
            replay_checks.append(bool(len(completed) == 1 and record.get('status') == 200
                and replay == prior_capsules and emitted == capsules(completed[0].get('output', []))
                and all(item_id and sealed for item_id, sealed in emitted)))
            prior_capsules.extend(emitted)
            done_calls.extend(item for item in done if item.get('type') in {'function_call', 'custom_tool_call'})
        except (ValueError, TypeError, KeyError):
            replay_checks.append(False)
    native_checks = [native_blocks(item['body'], 'assistant') == item['expected_assistant'] for item in upstream]
    tool_result_checks = []
    for record, item in zip(records, upstream):
        try:
            tool_result_checks.append(projected_tool_results(record['request']) == native_blocks(item['body'], kinds={'tool_result'}))
        except (ValueError, TypeError, KeyError):
            tool_result_checks.append(False)
    expected_ids = ['toolu_workflow_read', 'toolu_workflow_fail', 'toolu_workflow_patch',
                    'toolu_workflow_pass', 'toolu_workflow_recheck']
    all_results = native_blocks(upstream[-1]['body'], kinds={'tool_result'}) if upstream else []
    results_exact = [block.get('tool_use_id') for block in all_results] == expected_ids
    notifications = [event.get('params', {}).get('item', {}) for event in events if event.get('method') == 'item/completed']
    commands = [item for item in notifications if item.get('type') == 'commandExecution']
    patches = [item for item in notifications if item.get('type') == 'fileChange']
    finals = [item.get('text') for item in notifications if item.get('type') == 'agentMessage']
    command_exits = [item.get('exitCode') for item in commands]
    command_outputs = [item.get('aggregatedOutput', '') for item in commands]
    offered = offered_tools(records[0].get('request', {})) if records else []
    tool_offers = {(tool.get('type'), tool.get('name')) for tool, _ in offered}
    patch_calls = [item for item in done_calls if item.get('type') == 'custom_tool_call']
    metadata = records[0].get('request', {}).get('client_metadata', {}) if records else {}
    try:
        sandbox = json.loads(metadata.get('x-codex-turn-metadata', '{}')).get('sandbox_mode')
    except (ValueError, TypeError):
        sandbox = None
    report = {
        'responses_requests': len(records), 'upstream_requests': len(upstream),
        'expected_request_count': requests_ok, 'reasoning_replay_checks': replay_checks,
        'ordered_native_assistant_checks': native_checks,
        'tool_result_content_checks': tool_result_checks,
        'tool_result_ids_exact': results_exact, 'tool_call_count': len(done_calls),
        'shell_and_patch_offered': {('function', 'exec_command'), ('custom', 'apply_patch')} <= tool_offers,
        'patch_input_exact': len(patch_calls) == 1 and patch_calls[0].get('input') == PATCH,
        'command_exit_codes': command_exits,
        'read_command_succeeded': len(commands) >= 1 and command_exits[0] == 0 and READ_MARKER in command_outputs[0],
        'initial_test_really_failed': len(commands) >= 2 and command_exits[1] == 3 and FAIL_MARKER in command_outputs[1],
        'repaired_test_really_passed': len(commands) >= 3 and command_exits[2] == 0 and PASS_MARKER in command_outputs[2],
        'followup_test_really_passed': len(commands) >= 4 and command_exits[3] == 0 and PASS_MARKER in command_outputs[3],
        'file_change_completed': len(patches) == 1 and patches[0].get('status') == 'completed',
        'final_markers_exact': finals == [INITIAL_MARKER, FOLLOWUP_MARKER],
        'workspace_files_exact': files == EXPECTED_FILES,
        'actual_sandbox_mode': sandbox, 'terminal_statuses': terminal_statuses,
        'upstream_auth_exact': bool(upstream) and all(item.get('upstream_auth_exact') for item in upstream),
        'credential_leak': any(item.get('credential_leak') for item in upstream),
    }
    report['transport_state_pass'] = (requests_ok and all(replay_checks) and all(native_checks) and all(tool_result_checks)
        and results_exact and len(done_calls) == 5 and report['shell_and_patch_offered']
        and report['patch_input_exact'] and report['upstream_auth_exact'] and not report['credential_leak'])
    report['functional_pass'] = (report['transport_state_pass'] and terminal_statuses == ['completed', 'completed']
        and command_exits == [0, 3, 0, 0] and report['file_change_completed']
        and report['final_markers_exact'] and report['workspace_files_exact']
        and all(report[key] for key in ('read_command_succeeded', 'initial_test_really_failed',
                                       'repaired_test_really_passed', 'followup_test_really_passed')))
    return report


class Fake(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def stream(self, content, stop_reason):
        message = {'id': 'msg_workflow_' + str(len(self.server.requests)), 'type': 'message', 'role': 'assistant',
            'model': self.server.model, 'content': [], 'stop_reason': None, 'stop_sequence': None,
            'usage': {'input_tokens': 10, 'output_tokens': 0, 'cache_read_input_tokens': 80, 'cache_creation_input_tokens': 0}}
        wire = event('message_start', {'type': 'message_start', 'message': message})
        for index, block in enumerate(content):
            kind = block['type']
            initial = ({'type': 'thinking', 'thinking': ''} if kind == 'thinking' else
                       {**block, 'input': {}} if kind == 'tool_use' else
                       {'type': 'text', 'text': ''} if kind == 'text' else block)
            wire += event('content_block_start', {'type': 'content_block_start', 'index': index, 'content_block': initial})
            deltas = []
            if kind == 'thinking':
                if block['thinking']:
                    deltas.append({'type': 'thinking_delta', 'thinking': block['thinking']})
                deltas.append({'type': 'signature_delta', 'signature': block['signature']})
            elif kind == 'tool_use':
                encoded = json.dumps(block['input'])
                deltas.extend({'type': 'input_json_delta', 'partial_json': encoded[offset:offset + 7]} for offset in range(0, len(encoded), 7))
            elif kind == 'text':
                deltas.append({'type': 'text_delta', 'text': block['text']})
            for delta in deltas:
                wire += event('content_block_delta', {'type': 'content_block_delta', 'index': index, 'delta': delta})
            wire += event('content_block_stop', {'type': 'content_block_stop', 'index': index})
        wire += event('message_delta', {'type': 'message_delta', 'delta': {'stop_reason': stop_reason, 'stop_sequence': None}, 'usage': {'output_tokens': 9}})
        wire += event('message_stop', {'type': 'message_stop'})
        self.send_response(200)
        self.send_header('content-type', 'text/event-stream')
        self.send_header('content-length', str(len(wire)))
        self.end_headers()
        try:
            for offset in range(0, len(wire), 7):
                self.wfile.write(wire[offset:offset + 7])
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            self.server.failure = 'fixture_stream_closed_early'

    def do_POST(self):
        size = int(self.headers.get('content-length', '0'))
        if self.path != '/v1/messages' or not 0 < size <= 2 * 1024 * 1024 or len(self.server.requests) >= MAX_REQUESTS:
            self.send_error(400)
            return
        raw = self.rfile.read(size)
        body = json.loads(raw)
        step = len(self.server.requests)
        self.server.requests.append({'body': body, 'step': step, 'expected_assistant': copy.deepcopy(self.server.issued),
            'upstream_auth_exact': self.headers.get('x-api-key') == 'sk-ant-local-fake-only' and not self.headers.get('authorization'),
            'credential_leak': any(key.encode() in raw or any(key in value for value in self.headers.values()) for key in self.server.local_keys)})
        current = self.server.observer.records[-1]['request']
        tools = offered_tools(current)
        shell = [(tool, namespace) for tool, namespace in tools if tool.get('type') == 'function' and tool.get('name') == 'exec_command']
        patch = [(tool, namespace) for tool, namespace in tools if tool.get('type') == 'custom' and tool.get('name') == 'apply_patch']
        if len(shell) != 1 or len(patch) != 1:
            self.server.failure = 'ordinary_shell_and_patch_not_offered'
            self.send_error(400)
            return
        if step in (4, 6):
            content = [{'type': 'text', 'text': INITIAL_MARKER if step == 4 else FOLLOWUP_MARKER}]
            self.server.issued.extend(content)
            self.stream(content, 'end_turn')
            return
        stage = {0: 'read', 1: 'fail', 2: 'patch', 3: 'pass', 5: 'recheck'}[step]
        if stage == 'patch':
            selected, namespace = patch[0]
            arguments = {'input': PATCH}
        else:
            selected, namespace = shell[0]
            command = self.server.read_command if stage == 'read' else self.server.test_command
            arguments = shell_arguments(command, self.server.workspace)
        call_name = native_name(selected['name'], namespace)
        if call_name not in [tool.get('name') for tool in body.get('tools', [])]:
            self.server.failure = 'native_tool_mapping_missing'
            self.send_error(400)
            return
        content = [
            {'type': 'thinking', 'thinking': 'Synthetic coding workflow ' + stage + ' 🔧.', 'signature': 'fixture-' + stage + '-signed+/='},
            {'type': 'thinking', 'thinking': '', 'signature': 'fixture-' + stage + '-empty+/='},
            {'type': 'redacted_thinking', 'data': 'fixture-' + stage + '-redacted+/='},
            {'type': 'tool_use', 'id': 'toolu_workflow_' + stage, 'name': call_name, 'input': arguments},
        ]
        self.server.issued.extend(copy.deepcopy(content))
        self.stream(content, 'tool_use')


class Observer(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        size = int(self.headers.get('content-length', '0'))
        if self.path != REQUEST_PATH or not 0 < size <= 2 * 1024 * 1024 or len(self.server.records) >= MAX_REQUESTS:
            self.send_error(400)
            return
        raw = self.rfile.read(size)
        record = {'request': json.loads(raw), 'response_sse': ''}
        self.server.records.append(record)
        connection = http.client.HTTPConnection('127.0.0.1', self.server.target_port, timeout=30)
        try:
            headers = {key: value for key, value in self.headers.items()
                       if key.lower() not in {'host', 'connection', 'transfer-encoding', 'accept-encoding'}}
            headers['accept-encoding'] = 'identity'
            connection.request('POST', self.path, raw, headers)
            response = connection.getresponse()
            record['status'] = response.status
            self.send_response(response.status)
            for name, value in response.getheaders():
                if name.lower() not in {'connection', 'transfer-encoding', 'content-length', 'server', 'date'}:
                    self.send_header(name, value)
            self.send_header('connection', 'close')
            self.end_headers()
            wire = bytearray()
            while chunk := response.read1(8192):
                wire.extend(chunk)
                if len(wire) > 4 * 1024 * 1024:
                    raise RuntimeError('Fixture response bound exceeded')
                self.wfile.write(chunk)
                self.wfile.flush()
            record['response_sse'] = wire.decode('utf-8')
        finally:
            connection.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--codex', type=Path, required=True)
    parser.add_argument('--catalog', type=Path, required=True, help='Opt-in catalog produced by the profile helper; never existing user configuration')
    parser.add_argument('--model', default=MODEL)
    parser.add_argument('--node', type=Path)
    parser.add_argument('--output', type=Path, required=True, help='NEW external system-temp directory')
    parser.add_argument('--catalog-check-only', action='store_true', help='Read-only actual model/list; never run inference or tools')
    args = parser.parse_args(argv)
    output = args.output.resolve()
    if output.exists() or Path(tempfile.gettempdir()).resolve() not in output.parents or ROOT in output.parents:
        parser.error('--output must be a NEW system-temp child outside the repository')
    codex = args.codex.resolve(strict=True)
    node = args.node.resolve(strict=True) if args.node else shutil.which('node')
    if not node:
        parser.error('Existing Node executable is required')
    catalog_path = args.catalog.resolve(strict=True)
    catalog = json.loads(catalog_path.read_text(encoding='utf-8'))
    entry = catalog_entry(catalog, args.model)
    if catalog_prompt_sha256(entry) != PROMPT_SHA256:
        parser.error('Catalog instruction template does not match the pinned stock Codex prompt')
    output.mkdir(parents=True)
    if args.catalog_check_only:
        return check_catalog_only(codex, catalog_path, output, args.model)
    workspace, home = output / 'workspace', output / 'codex-state'
    workspace.mkdir()
    home.mkdir()
    for name, content in FILES.items():
        (workspace / name).write_text(content, encoding='utf-8', newline='\n')
    report = {'scope': 'actual Codex -> pristine stock LiteLLM -> actual Responses adapter -> scripted loopback Anthropic',
        'mode': 'offline', 'source_commit': SOURCE, 'model': args.model, 'litellm_version': importlib.metadata.version('litellm'),
        'before': identities(), 'catalog_sha256': hashlib.sha256(catalog_path.read_bytes()).hexdigest(),
        'catalog_instruction_sha256': catalog_prompt_sha256(entry),
        'stock_prompt_not_replaced': True, 'client_source_modified': False, 'sandbox_bypass': False,
        'sandbox_requested': 'workspace-write', 'maximum_upstream_requests': MAX_REQUESTS,
        'not_tested': ['real provider model capability, acceptance, signatures, billing or cache hits',
            'deployed Linux sandbox and actual .7/.64 chain', 'automatic compaction and process-restart resume',
            'OS-enforced total network isolation', 'arbitrary repositories, shell commands or external tools']}
    report['repository_head'] = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    report['built_request_adapter_sha256'] = hashlib.sha256((ROOT / 'dist/services/responsesRequest.js').read_bytes()).hexdigest()
    report['codex_version'] = subprocess.check_output([str(codex), '--version'], env=clean_env(output), text=True).strip()
    with codex.open('rb') as binary:
        report['codex_sha256'] = hashlib.file_digest(binary, 'sha256').hexdigest()
    if report['codex_version'] != 'codex-cli 0.160.0' or report['litellm_version'] != '1.103.1':
        parser.error('Pinned Codex 0.160.0 and pristine LiteLLM 1.103.1 are required')
    gateway_key, relay_key = 'sk-local-fixture-' + secrets.token_hex(24), None

    def redact(text):
        for key in (gateway_key, relay_key):
            if key:
                text = text.replace(key, '[LOCAL_FIXTURE_KEY]')
        return text

    fake = ThreadingHTTPServer(('127.0.0.1', 0), Fake)
    fake.requests, fake.issued, fake.failure, fake.local_keys = [], [], None, [gateway_key]
    fake.model = args.model
    fake.workspace = workspace
    fake.read_command, fake.test_command = fixture_commands(sys.executable, os.name == 'nt')
    fake_thread = threading.Thread(target=fake.serve_forever, daemon=True)
    fake_thread.start()
    children, observer, rpc, terminals = [], None, None, []
    try:
        def relay_ready(line):
            try:
                value = json.loads(line)
                port, key = value.get('local_relay_port'), value.get('local_relay_key')
                if type(port) is int and 0 < port <= 65535 and isinstance(key, str) and key.startswith('sk-'):
                    return value
            except ValueError:
                pass
        child, thread, logs, ready = start([str(node), str(ROOT / 'integration/clients/boot_codex_patch_relay.mjs'),
            'http://127.0.0.1:' + str(fake.server_port)], clean_env(output), output, relay_ready, 20)
        children.append((child, thread, logs, 'relay.log'))
        relay_key = ready['local_relay_key']
        fake.local_keys.append(relay_key)
        config = {'litellm_settings': {'telemetry': False, 'num_retries': 0, 'callbacks': []},
            'router_settings': {'num_retries': 0}, 'general_settings': {'master_key': 'os.environ/LOCAL_GATEWAY_KEY',
            'pass_through_endpoints': [{'path': REQUEST_PATH, 'target': 'http://127.0.0.1:' + str(ready['local_relay_port']) + '/v1/responses',
                'auth': True, 'methods': ['POST'], 'forward_headers': True,
                'headers': {'Authorization': 'os.environ/LOCAL_RELAY_AUTHORIZATION', 'x-api-key': ''}}]}}
        config_path = output / 'gateway.yaml'
        config_path.write_text(yaml.safe_dump(config), encoding='utf-8')
        env = clean_env(output)
        env.update(CONFIG_FILE_PATH=str(config_path), LOCAL_GATEWAY_KEY=gateway_key,
                   LOCAL_RELAY_AUTHORIZATION='Bearer ' + relay_key, LITELLM_LOCAL_MODEL_COST_MAP='True')
        child, thread, logs, port = start([sys.executable, str(ROOT / 'integration/litellm/boot_gateway.py')], env, output,
            lambda line: int(line.strip().split('=')[1]) if line.startswith('LOCAL_GATEWAY_PORT=') else None, 45)
        children.append((child, thread, logs, 'gateway.log'))
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        deadline = time.monotonic() + 30
        while True:
            try:
                opener.open('http://127.0.0.1:' + str(port) + '/health/liveliness', timeout=.5).close()
                break
            except Exception:
                if time.monotonic() > deadline:
                    raise RuntimeError('Gateway startup deadline')
                time.sleep(.2)
        observer = ThreadingHTTPServer(('127.0.0.1', 0), Observer)
        observer.records, observer.target_port = [], port
        fake.observer = observer
        observer_thread = threading.Thread(target=observer.serve_forever, daemon=True)
        observer_thread.start()
        env = clean_env(output)
        env.update(CODEX_HOME=str(home), CODEX_FIXTURE_KEY=gateway_key, RUST_LOG='error')
        overrides = {'model_provider': 'fixture', 'model': args.model, 'model_catalog_json': str(catalog_path),
            'sandbox_mode': 'workspace-write', 'sandbox_workspace_write.network_access': False,
            'approval_policy': 'never', 'web_search': 'disabled', 'analytics.enabled': False, 'feedback.enabled': False,
            'check_for_update_on_startup': False, 'otel.exporter': 'none', 'otel.trace_exporter': 'none',
            'cli_auth_credentials_store': 'file', 'model_providers.fixture.name': 'Local coding workflow fixture',
            'model_providers.fixture.base_url': 'http://127.0.0.1:' + str(observer.server_port) + REQUEST_PATH.removesuffix('/responses'),
            'model_providers.fixture.wire_api': 'responses', 'model_providers.fixture.env_key': 'CODEX_FIXTURE_KEY',
            'model_providers.fixture.requires_openai_auth': False, 'model_providers.fixture.supports_websockets': False,
            'model_providers.fixture.request_max_retries': 0, 'model_providers.fixture.stream_max_retries': 0,
            'model_providers.fixture.stream_idle_timeout_ms': 15000}
        command = [str(codex), 'app-server', '--stdio']
        for name, value in overrides.items():
            command.extend(['-c', name + '=' + json.dumps(value)])
        rpc = Rpc(command, env, workspace)
        rpc.request(0, 'initialize', {'clientInfo': {'name': 'coding_workflow_fixture', 'title': 'Offline coding workflow', 'version': '1.0'},
                                     'capabilities': {'experimentalApi': True}})
        rpc.send({'method': 'initialized', 'params': {}})
        report.update(catalog_list_evidence(rpc.request(10, 'model/list', {}), args.model))
        thread = rpc.request(1, 'thread/start', {'model': args.model, 'modelProvider': 'fixture', 'cwd': str(workspace),
            'approvalPolicy': 'never', 'sandbox': 'workspace-write', 'ephemeral': False})
        thread_id = thread['thread']['id']
        report['thread_start'] = thread
        rpc.request(2, 'turn/start', {'threadId': thread_id, 'input': [{'type': 'text', 'text':
            'In this isolated fixture workspace, read calculator.py and display.py, run test_fixture.py to observe the failure, '
            'repair the two source files with apply_patch, and rerun the test. Do not change the test or access network. '
            'Finish with ' + INITIAL_MARKER + '.'}]})
        initial = rpc.completed(thread_id)
        terminals.append(initial.get('params', {}).get('turn', {}).get('status'))
        if terminals[-1] == 'completed':
            rpc.request(3, 'turn/start', {'threadId': thread_id, 'input': [{'type': 'text', 'text':
                'Rerun the existing fixture test using the shell, without changing any files or accessing network. '
                'Finish with ' + FOLLOWUP_MARKER + '.'}]})
            followup = rpc.completed(thread_id)
            terminals.append(followup.get('params', {}).get('turn', {}).get('status'))
    except Exception as error:
        report['harness_error'] = redact(str(error))[:2048]
    finally:
        if rpc:
            rpc.close()
            (output / 'app-server-events.jsonl').write_text(redact('\n'.join(json.dumps(event, ensure_ascii=False) for event in rpc.events)), encoding='utf-8')
            (output / 'client-stderr.log').write_text(redact(''.join(rpc.stderr)), encoding='utf-8')
        if observer:
            observer.shutdown()
            observer.server_close()
            observer_thread.join(3)
        for child, thread, logs, name in reversed(children):
            stop(child)
            thread.join(3)
            child.stdout.close()
            (output / name).write_text(redact(''.join(logs)), encoding='utf-8')
        fake.shutdown()
        fake.server_close()
        fake_thread.join(3)
        records = observer.records if observer else []
        files = {str(path.relative_to(workspace)).replace('\\', '/'): path.read_text(encoding='utf-8', errors='replace')
                 for path in workspace.rglob('*') if path.is_file()}
        report.update(workflow_evidence(records, fake.requests, rpc.events if rpc else [], files, terminals))
        report['fixture_failure'] = fake.failure
        report['after'] = identities()
        report['stock_unchanged'] = report['before'] == report['after']
        report['metadata_fallback'] = bool(rpc and 'Model metadata for' in ''.join(rpc.stderr))
        report['functional_pass'] = (report['functional_pass'] and report['stock_unchanged']
            and report.get('selected_model_listed') and not report['metadata_fallback']
            and not report.get('harness_error') and fake.failure is None)
        (output / 'responses-wire.json').write_text(redact(json.dumps(records, indent=2)), encoding='utf-8')
        (output / 'fake-requests.json').write_text(redact(json.dumps(fake.requests, indent=2)), encoding='utf-8')
        (output / 'codex-coding-workflow.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps({key: report[key] for key in ('functional_pass', 'transport_state_pass', 'responses_requests',
        'upstream_requests', 'command_exit_codes', 'file_change_completed', 'workspace_files_exact', 'actual_sandbox_mode',
        'terminal_statuses', 'fixture_failure')}, indent=2))
    print('Report:', output / 'codex-coding-workflow.json')
    return 0 if report['functional_pass'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
