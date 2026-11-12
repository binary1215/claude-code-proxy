#!/usr/bin/env python3
"""Genuine Linux Codex project work through an existing Responses gateway.

Imports are inert. Only --live starts a client or contacts the gateway. The
operator supplies an existing sandbox-capable container and pinned stock prompt.
"""
from __future__ import annotations

import argparse
import hashlib
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import urlsplit

from codex_patch_live_smoke import Rpc, Failure as ClientFailure, clean_env, events, capsules, usage_only, offered_tools
from generate_client_profiles import PROMPT_SHA256

MODEL = 'claude-opus-5-5-responses-han'
NATIVE_OPTIONS = '{"cache_control":{"type":"ephemeral","ttl":"5m"}}'
MAX_REQUESTS = 18
PHASE_LIMITS = {'initial': 12, 'followup': 6}
HTTP_TIMEOUT = 100
TURN_TIMEOUTS = {'initial': 570, 'followup': 270}
REQUEST_LIMIT, RESPONSE_LIMIT = 2 * 1024 * 1024, 8 * 1024 * 1024
MARKERS = {'initial': 'CODEX_PROJECT_FIXED', 'followup': 'CODEX_PROJECT_EXTENDED'}
SOURCES = ('billing.py', 'display.py')
FILES = {
    'billing.py': '# PROJECT_BILLING_SOURCE\ndef total_cents(items):\n    return sum(item["unit_cents"] + item["quantity"] for item in items)\n',
    'display.py': '# PROJECT_DISPLAY_SOURCE\ndef format_total(cents):\n    return f"${cents / 100:.1f}"\n',
    'test_project.py': (
        'import unittest\nfrom billing import total_cents\nfrom display import format_total\n\n'
        'class InvoiceTests(unittest.TestCase):\n'
        '    def test_quantity_is_multiplied(self):\n'
        '        self.assertEqual(total_cents([{"unit_cents": 399, "quantity": 2}, {"unit_cents": 250, "quantity": 3}]), 1548)\n'
        '    def test_empty_invoice(self):\n        self.assertEqual(total_cents([]), 0)\n'
        '    def test_money_has_two_decimal_places(self):\n'
        '        self.assertEqual(format_total(1548), "$15.48")\n'
        '        self.assertEqual(format_total(0), "$0.00")\n'
        '        self.assertEqual(format_total(5), "$0.05")\n\n'
        'if __name__ == "__main__":\n    unittest.main()\n'
    ),
    'README.md': (
        '# Tiny invoice project\n\nPython standard library only; no installation or network is needed.\n'
        '`billing.total_cents(items)` totals integer unit_cents times quantity.\n'
        '`display.format_total(cents)` returns a dollar amount with exactly two decimal places.\n'
        'Run `python3 -B -m unittest -v` from this directory. Repair source code, preserving the supplied tests.\n'
    ),
}
FOLLOWUP_TEST = (
    'import unittest\nfrom billing import total_cents\nfrom display import format_total\n\n'
    'class ExtendedInvoiceTests(unittest.TestCase):\n'
    '    def test_fixed_discount_and_clamping(self):\n'
    '        items = [{"unit_cents": 399, "quantity": 2}, {"unit_cents": 250, "quantity": 3}]\n'
    '        self.assertEqual(total_cents(items, discount_cents=200), 1348)\n'
    '        self.assertEqual(total_cents(items, discount_cents=9000), 0)\n'
    '        self.assertEqual(total_cents([], discount_cents=20), 0)\n'
    '        self.assertEqual(total_cents(items), 1548)\n'
    '    def test_optional_currency_symbol(self):\n'
    '        self.assertEqual(format_total(1348, symbol="EUR "), "EUR 13.48")\n'
    '        self.assertEqual(format_total(5, symbol="EUR "), "EUR 0.05")\n'
    '        self.assertEqual(format_total(1348), "$13.48")\n\n'
    'if __name__ == "__main__":\n    unittest.main()\n'
)


class Failure(Exception):
    """Only fixed harness diagnostic codes may be exported."""


def endpoint(base):
    value = urlsplit(base)
    if (value.scheme not in {'http', 'https'} or not value.hostname or value.username is not None
            or value.password is not None or value.query or value.fragment
            or not value.path.rstrip('/').endswith('/v1') or any(ord(c) < 33 for c in base)):
        raise ValueError('Use an explicit HTTP(S) /v1 endpoint without embedded credentials')
    return value.scheme, value.hostname, value.port or (443 if value.scheme == 'https' else 80), value.path.rstrip('/') + '/responses'


def build_catalog(model, stock_prompt):
    normalized = stock_prompt.replace('\r\n', '\n')
    if hashlib.sha256(normalized.encode()).hexdigest() != PROMPT_SHA256:
        raise ValueError('The stock prompt does not match the pinned Codex source')
    return {'models': [{'slug': model, 'display_name': 'Isolated real project test (NOT official Claude metadata)',
        'supported_reasoning_levels': [], 'shell_type': 'unified_exec', 'apply_patch_tool_type': 'freeform',
        'visibility': 'list', 'supported_in_api': True, 'priority': 0, 'upgrade': None,
        'support_verbosity': False, 'supports_reasoning_summary_parameter': False,
        'model_messages': {'instructions_template': normalized},
        'truncation_policy': {'mode': 'bytes', 'limit': 100000}, 'experimental_supported_tools': [],
        'input_modalities': ['text']}]}


def turn_prompt(phase):
    if phase == 'initial':
        return ('Work only in this temporary invoice project. Use exec_command to read README.md, billing.py, display.py '
                'and test_project.py before editing. Run python3 -B -m unittest -v and observe the existing failures first. '
                'Fix both source files with apply_patch, preserving the supplied tests, then run the tests again until they pass. '
                'Do not install anything, access the network, use external tools, change goals or touch other projects. '
                'Finish with exactly ' + MARKERS[phase] + '.')
    return ('Continue this same temporary invoice project. The caller has added test_followup.py for a new requirement. '
            'Read that test. Extend total_cents with optional discount_cents=0; subtract that fixed discount from the total '
            'and clamp the result at zero. Extend format_total with optional symbol="$" so symbol="EUR " works. '
            'Preserve old behavior and every supplied test. Update both source files with apply_patch, and run '
            'python3 -B -m unittest -v to verify all tests pass. Do not install anything, use the network, external tools '
            'or other projects. Finish with exactly ' + MARKERS[phase] + '.')


def source_snapshot(workspace):
    return {name: hashlib.sha256((workspace / name).read_bytes()).hexdigest()
            if (workspace / name).is_file() and not (workspace / name).is_symlink() else None for name in SOURCES}


def protected_tests_exact(workspace, phase):
    expected = {'test_project.py': FILES['test_project.py']}
    if phase == 'followup':
        expected['test_followup.py'] = FOLLOWUP_TEST
    return all((workspace / name).is_file() and not (workspace / name).is_symlink()
               and (workspace / name).read_text(encoding='utf-8') == text for name, text in expected.items())


def run_tests(workspace):
    result = subprocess.run([sys.executable, '-I', '-B', '-m', 'unittest', 'discover', '-v'], cwd=workspace,
                            capture_output=True, timeout=20, text=True)
    return {'exit_code': result.returncode, 'unittest_ran': 'Ran ' in result.stderr,
            'passed': result.returncode == 0 and 'OK' in result.stderr}


def test_command(item):
    command = item.get('command', '')
    if isinstance(command, list):
        command = ' '.join(str(part) for part in command)
    return isinstance(command, str) and bool(re.search(
        r'(?<![\w])python(?:3(?:\.\d+)?)?(?:\.exe)?[\'\"]?(?:\s+-(?:B|I|u))*\s+'
        r'(?:-m\s+unittest\b|(?:\./)?test_(?:project|followup)\.py\b)', command))


def unittest_outcomes(item):
    if not test_command(item) or type(item.get('exitCode')) is not int:
        return []
    output = item.get('aggregatedOutput', '')
    if not isinstance(output, str):
        return []
    # A combined shell command may finish successfully after unittest failed.
    # Pair each positive test count with its actual anchored unittest summary;
    # shell status alone cannot distinguish that failure from passing tests.
    summaries = re.findall(
        r'^Ran ([1-9]\d*) tests?(?: in [^\r\n]+)?\r?\n(?:[ \t]*\r?\n)*'
        r'(OK(?: \([^\r\n]+\))?|FAILED \([^\r\n]+\))[ \t]*\r?$', output, re.MULTILINE)
    return ['passed' if summary.startswith('OK') else 'failed' for _, summary in summaries
            if summary.startswith('OK') or re.search(r'(?:failures|errors|unexpected successes)=[1-9]\d*', summary)]


def successful_test(item):
    outcomes = unittest_outcomes(item)
    return bool(outcomes and outcomes[-1] == 'passed' and item['exitCode'] == 0)


def execution_evidence(notifications):
    completed = [(index, value.get('params', {}).get('item', {})) for index, value in enumerate(notifications)
                 if value.get('method') == 'item/completed']
    commands = [(i, item) for i, item in completed if item.get('type') == 'commandExecution']
    changes = [(i, item) for i, item in completed if item.get('type') == 'fileChange']
    # A real read followed by the expected failing tests can share one shell
    # command. The shell's final exit does not establish the test outcome.
    read_outputs = [item['aggregatedOutput'] for _, item in commands if isinstance(item.get('aggregatedOutput'), str)]
    billing_read = any('PROJECT_BILLING_SOURCE' in output or 'def total_cents' in output for output in read_outputs)
    display_read = any('PROJECT_DISPLAY_SOURCE' in output or 'def format_total' in output for output in read_outputs)
    failed = [(i, item) for i, item in commands if 'failed' in unittest_outcomes(item)]
    passed = [(i, item) for i, item in commands if successful_test(item)]
    successful_changes = [(i, item) for i, item in changes if item.get('status') == 'completed']
    return {'command_count': len(commands), 'source_read_observed': billing_read and display_read,
            'model_test_failure_observed': bool(failed), 'model_test_success_observed': bool(passed),
            'file_change_completed_count': len(successful_changes),
            'file_change_failed_count': sum(item.get('status') != 'completed' for _, item in changes),
            'failed_test_before_file_change': min(i for i, _ in failed) < min(i for i, _ in successful_changes) if failed and successful_changes else None,
            'passed_test_after_file_change': max(i for i, _ in passed) > max(i for i, _ in successful_changes) if passed and successful_changes else None}


def automatic_compaction_evidence(notifications):
    started, finished = [], []
    successful_tests = []
    for index, value in enumerate(notifications):
        item = value.get('params', {}).get('item', {})
        if item.get('type') == 'contextCompaction':
            if value.get('method') == 'item/started':
                started.append(index)
            if value.get('method') == 'item/completed':
                finished.append(index)
        if value.get('method') == 'item/completed' and item.get('type') == 'commandExecution' and successful_test(item):
            successful_tests.append(index)
    return {'automatic_compaction_started_count': len(started), 'automatic_compaction_completed_count': len(finished),
            'successful_test_after_automatic_compaction': bool(finished and any(index > min(finished) for index in successful_tests))}


class State:
    def __init__(self, key, target, model):
        self.key, self.target, self.model = key, target, model
        self.phase = 'initial'
        self.records = []
        self.attempts = 0
        self.failure = None
        self.lock = threading.Lock()

    def fail(self, code):
        with self.lock:
            if self.failure is None:
                self.failure = code

    def reserve(self, request):
        with self.lock:
            if self.failure:
                raise Failure('earlier_failure')
            if self.attempts >= MAX_REQUESTS or sum(r['phase'] == self.phase for r in self.records) >= PHASE_LIMITS[self.phase]:
                raise Failure('request_budget_exhausted')
            self.attempts += 1  # Uncertain outcomes consume their slot; no replay.
            record = {'phase': self.phase, 'request': request, 'wire': b'', 'status': None, 'finished': False}
            self.records.append(record)
            return record


class QuietServer(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, _request, _address):
        self.state.fail('observer_handler_failed')


class Observer(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        state, connection, record = self.server.state, None, None
        wire = bytearray()
        sent_headers = False
        self.connection.settimeout(HTTP_TIMEOUT)
        try:
            size = int(self.headers.get('content-length', '0'))
            if self.path != state.target[3] or not 0 < size <= REQUEST_LIMIT:
                raise Failure('request_shape_failed')
            if self.headers.get('authorization') != 'Bearer ' + state.key:
                raise Failure('observer_authentication_failed')
            raw = self.rfile.read(size)
            request = json.loads(raw)
            if len(raw) != size or not isinstance(request, dict) or request.get('model') != state.model:
                raise Failure('request_shape_failed')
            record = state.reserve(request)
            headers = {name: value for name, value in self.headers.items()
                       if name.lower() not in {'host', 'connection', 'transfer-encoding', 'accept-encoding'}}
            headers['accept-encoding'] = 'identity'
            scheme, host, port, _ = state.target
            connection = (http.client.HTTPSConnection if scheme == 'https' else http.client.HTTPConnection)(host, port, timeout=HTTP_TIMEOUT)
            connection.request('POST', self.path, raw, headers)
            response = connection.getresponse()
            record['status'] = response.status
            self.send_response(response.status)
            for name, value in response.getheaders():
                if name.lower() not in {'connection', 'transfer-encoding', 'content-length', 'server', 'date'}:
                    self.send_header(name, value)
            self.send_header('connection', 'close')
            self.end_headers()
            sent_headers = True
            if response.status != 200:
                state.fail('http_response_failed')
            while chunk := response.read1(8192):
                wire.extend(chunk)
                if len(wire) > RESPONSE_LIMIT:
                    raise Failure('response_capture_limit')
                self.wfile.write(chunk)
                self.wfile.flush()
            self.close_connection = True
        except Exception as error:
            state.fail(str(error) if isinstance(error, Failure) else 'observer_transport_failed')
            if not sent_headers:
                try:
                    self.send_response(502)
                    self.send_header('content-length', '0')
                    self.end_headers()
                except OSError:
                    pass
        finally:
            if connection:
                connection.close()
            if record is not None:
                record['wire'], record['finished'] = bytes(wire), True


def wire_evidence(records):
    result, known = [], set()
    for ordinal, record in enumerate(records):
        row = {'ordinal': ordinal + 1, 'phase': record['phase'], 'http_status': record['status'], 'finished': record['finished'],
               'reasoning_done_completed_exact': None, 'replayed_reasoning_known_exact': None, 'usage': None,
               'completed_count': 0, 'marker_present': False}
        try:
            values = events(record)
            done = [value['item'] for value in values if value.get('type') == 'response.output_item.done']
            completed = [value['response'] for value in values if value.get('type') == 'response.completed']
            row['completed_count'] = len(completed)
            replayed = capsules(record['request'].get('input', []))
            if replayed:
                row['replayed_reasoning_known_exact'] = all(pair in known and all(isinstance(value, str) and value for value in pair) for pair in replayed)
            if len(completed) == 1:
                output = completed[0].get('output', [])
                emitted, final = capsules(done), capsules(output)
                row['reasoning_count'] = len(final)
                if emitted or final:
                    row['reasoning_done_completed_exact'] = emitted == final and bool(final) and all(
                        isinstance(item_id, str) and item_id and isinstance(sealed, str) and sealed for item_id, sealed in final)
                known.update(pair for pair in final if all(isinstance(value, str) and value for value in pair))
                row['usage'] = usage_only(completed[0])
                row['marker_present'] = any(MARKERS[record['phase']] in block.get('text', '')
                    for item in output if item.get('type') == 'message' for block in item.get('content', [])
                    if isinstance(block, dict) and isinstance(block.get('text'), str))
                tools = offered_tools(record['request'])
                row['shell_and_patch_offered'] = {'exec_command', 'apply_patch'} <= {tool.get('name') for tool, _ in tools}
        except (ValueError, KeyError, TypeError, AttributeError, UnicodeError):
            row['parse_failed'] = True
        result.append(row)
    return result


def phase_evidence(state, phase, workspace, before, notifications, terminal):
    records = [record for record in state.records if record['phase'] == phase]
    execution = execution_evidence(notifications)
    after = source_snapshot(workspace)
    independent = run_tests(workspace)
    wire = [row for row in wire_evidence(state.records) if row['phase'] == phase]
    status = terminal.get('params', {}).get('turn', {}).get('status')
    report = {**execution, 'terminal_status': status if status in {'completed', 'failed', 'interrupted'} else 'unobserved',
              'request_count': len(records), 'changed_source_file_count': sum(after[name] is not None and before[name] != after[name] for name in SOURCES),
              'supplied_tests_unchanged': protected_tests_exact(workspace, phase), 'independent_test': independent,
              'marker_present': any(row['marker_present'] for row in wire), 'requests': wire}
    report['functional_pass'] = bool(status == 'completed' and state.failure is None and records
        and all(row['http_status'] == 200 and row['finished'] and row['completed_count'] == 1 for row in wire)
        and report['changed_source_file_count'] == 2 and report['supplied_tests_unchanged'] and independent['passed']
        and execution['model_test_success_observed'] and report['marker_present']
        and (phase != 'initial' or execution['source_read_observed'] and execution['model_test_failure_observed']))
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--live', action='store_true', help='Explicit opt-in; up to18 existing-gateway calls')
    parser.add_argument('--codex', type=Path, required=True)
    parser.add_argument('--stock-prompt', type=Path, required=True, help='Read-only pinned Codex0.160.0 stock prompt')
    parser.add_argument('--model', default=MODEL)
    parser.add_argument('--gateway-base-url', default='http://192.168.0.7:4000/v1')
    parser.add_argument('--gateway-key-env', default='CODEX_PROJECT_GATEWAY_KEY', help='Variable NAME only; never a key value')
    parser.add_argument('--auto-compact-token-limit', type=int, help='Optional supported Codex automatic-compaction threshold; no manual compact RPC')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args(argv)
    if not args.live:
        parser.error('--live is required; no client or provider call was made')
    if not sys.platform.startswith('linux'):
        parser.error('Use an operator-prepared Linux test container')
    if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,127}', args.gateway_key_env):
        parser.error('--gateway-key-env must be a variable name')
    if args.auto_compact_token_limit is not None and args.auto_compact_token_limit < 1:
        parser.error('Automatic-compaction threshold must be positive')
    try:
        target = endpoint(args.gateway_base_url)
        catalog = build_catalog(args.model, args.stock_prompt.read_text(encoding='utf-8'))
    except (ValueError, OSError):
        parser.error('Invalid endpoint or pinned stock prompt')
    output = args.output.resolve()
    if output.exists() or Path(tempfile.gettempdir()).resolve() not in output.parents:
        parser.error('--output must be a NEW directory beneath system temp')
    output.mkdir(parents=True)
    home, workspace = output / 'home', output / 'workspace'
    home.mkdir(); workspace.mkdir(); (home / 'codex-state').mkdir()
    for name, text in FILES.items():
        (workspace / name).write_text(text, encoding='utf-8')
    report = {'model': args.model, 'functional_pass': False, 'request_limit': MAX_REQUESTS,
              'phase_request_limits': PHASE_LIMITS, 'sandbox_requested': 'workspace-write', 'sandbox_bypass': False,
              'approval_policy': 'never', 'raw_observations_persisted': False, 'temporary_client_history_retained': True,
              'client_source_modified': False, 'gateway_source_modified': False, 'gateway_internals_observed': False,
              'manual_compaction_rpc_calls': 0, 'auto_compact_token_limit_requested': args.auto_compact_token_limit,
              'stock_prompt_sha256': PROMPT_SHA256, 'phases': {}, 'failure_code': None, 'failure_phase': None}
    state = rpc = server = server_thread = None
    try:
        codex = args.codex.resolve(strict=True)
        env = clean_env(home)
        version = subprocess.run([str(codex), '--version'], env=env, capture_output=True, text=True, timeout=10)
        report['codex_version_pinned'] = version.returncode == 0 and version.stdout.strip() == 'codex-cli 0.160.0'
        if not report['codex_version_pinned']:
            raise Failure('codex_version_mismatch')
        report['initial_independent_baseline'] = run_tests(workspace)
        if report['initial_independent_baseline']['exit_code'] == 0:
            raise Failure('fixture_baseline_did_not_fail')
        key = os.environ.get(args.gateway_key_env)
        if not key or not key.isascii() or not all(33 <= ord(c) <= 126 for c in key) or len(key) > 4096:
            raise Failure('gateway_key_environment_missing_or_invalid')
        state = State(key, target, args.model)
        server = QuietServer(('127.0.0.1', 0), Observer); server.state = state
        server_thread = threading.Thread(target=server.serve_forever, daemon=True); server_thread.start()
        catalog_path = home / 'model-catalog.json'; catalog_path.write_text(json.dumps(catalog), encoding='utf-8')
        env['CODEX_PROJECT_GATEWAY_KEY'] = key
        settings = {'model': args.model, 'model_provider': 'project_live', 'model_catalog_json': str(catalog_path),
            'sandbox_mode': 'workspace-write', 'sandbox_workspace_write.network_access': False,
            'sandbox_workspace_write.exclude_tmpdir_env_var': True, 'sandbox_workspace_write.exclude_slash_tmp': True,
            'approval_policy': 'never', 'web_search': 'disabled', 'agents.enabled': False,
            'analytics.enabled': False, 'feedback.enabled': False, 'check_for_update_on_startup': False,
            'otel.exporter': 'none', 'otel.trace_exporter': 'none', 'cli_auth_credentials_store': 'file',
            'model_providers.project_live.name': 'Isolated project through existing native Responses route',
            'model_providers.project_live.base_url': 'http://127.0.0.1:' + str(server.server_port) + target[3].removesuffix('/responses'),
            'model_providers.project_live.wire_api': 'responses', 'model_providers.project_live.env_key': 'CODEX_PROJECT_GATEWAY_KEY',
            'model_providers.project_live.requires_openai_auth': False, 'model_providers.project_live.supports_websockets': False,
            'model_providers.project_live.request_max_retries': 0, 'model_providers.project_live.stream_max_retries': 0,
            'model_providers.project_live.stream_idle_timeout_ms': HTTP_TIMEOUT * 1000}
        if args.auto_compact_token_limit is not None:
            settings['model_auto_compact_token_limit'] = args.auto_compact_token_limit
        command = [str(codex), 'app-server', '--stdio']
        for name, value in settings.items():
            command.extend(['-c', name + '=' + json.dumps(value)])
        command.extend(['-c', 'model_providers.project_live.http_headers={"x-claude-proxy-native-options"=' + json.dumps(NATIVE_OPTIONS) + '}'])
        rpc = Rpc(command, env, workspace)
        rpc.request(0, 'initialize', {'clientInfo': {'name': 'codex_project_live', 'version': '1.0'}, 'capabilities': {'experimentalApi': True}})
        rpc.send({'method': 'initialized', 'params': {}})
        started = rpc.request(1, 'thread/start', {'model': args.model, 'modelProvider': 'project_live', 'cwd': str(workspace),
            'sandbox': 'workspace-write', 'approvalPolicy': 'never', 'ephemeral': False})
        thread_id = started['thread']['id']
        for request_id, phase in enumerate(PHASE_LIMITS, start=2):
            state.phase = phase
            if phase == 'followup':
                (workspace / 'test_followup.py').write_text(FOLLOWUP_TEST, encoding='utf-8')
                report['followup_independent_baseline'] = run_tests(workspace)
            before = source_snapshot(workspace)
            begin = len(rpc.events)
            rpc.request(request_id, 'turn/start', {'threadId': thread_id, 'input': [{'type': 'text', 'text': turn_prompt(phase)}],
                'approvalPolicy': 'never', 'sandboxPolicy': {'type': 'workspaceWrite', 'writableRoots': [str(workspace)],
                    'networkAccess': False, 'excludeTmpdirEnvVar': True, 'excludeSlashTmp': True}})
            terminal = rpc.wait(lambda value: value.get('method') == 'turn/completed'
                and value.get('params', {}).get('threadId') == thread_id, TURN_TIMEOUTS[phase])
            deadline = time.monotonic() + 5
            while any(not record['finished'] for record in state.records) and time.monotonic() < deadline:
                time.sleep(.05)
            evidence = phase_evidence(state, phase, workspace, before, rpc.events[begin:], terminal)
            report['phases'][phase] = evidence
            if not evidence['functional_pass']:
                raise Failure('project_phase_failed')
        report['functional_pass'] = True
    except Exception as error:
        report['failure_code'] = str(error) if isinstance(error, (Failure, ClientFailure)) else 'runtime_or_protocol_failed'
        report['failure_phase'] = state.phase if state else 'setup'
    finally:
        if rpc:
            report.update(automatic_compaction_evidence(rpc.events))
            try:
                rpc.close()
            except Exception:
                report['functional_pass'], report['cleanup_failed'] = False, True
        if server:
            server.shutdown(); server.server_close(); server_thread.join(3)
        report['gateway_request_attempts'] = state.attempts if state else 0
        report['actual_dot7_gateway_tested'] = bool(state and state.attempts and target[1:3] == ('192.168.0.7', 4000))
        report['gateway_responses_path'] = target[3]
        report['observer_failure_code'] = state.failure if state else None
        report['requests'] = wire_evidence(state.records) if state else []
        reads, writes, replay = [], [], []
        for row in report['requests']:
            usage = row['usage'] or {}
            reads.append(usage.get('cache_read_input_tokens') if usage.get('cache_read_input_tokens') is not None else usage.get('cached_tokens'))
            writes.append(usage.get('cache_creation_input_tokens') if usage.get('cache_creation_input_tokens') is not None else usage.get('cache_write_tokens'))
            if row['replayed_reasoning_known_exact'] is not None:
                replay.append(row['replayed_reasoning_known_exact'])
            if row['reasoning_done_completed_exact'] is not None:
                replay.append(row['reasoning_done_completed_exact'])
        valid_reads = [value for value in reads if type(value) is int]
        valid_writes = [value for value in writes if type(value) is int]
        report['cache_read_observed'] = any(value > 0 for value in valid_reads) if valid_reads else None
        report['cache_write_observed'] = any(value > 0 for value in valid_writes) if valid_writes else None
        report['observed_reasoning_preserved'] = all(replay) if replay else None
        report['signed_reasoning_replay_qualified'] = bool(report['functional_pass'] and report['observed_reasoning_preserved'] is True
            and any(row['replayed_reasoning_known_exact'] is True for row in report['requests']))
        report['automatic_compaction_qualified'] = bool(report['functional_pass'] and args.auto_compact_token_limit is not None
            and report.get('automatic_compaction_started_count', 0) > 0 and report.get('automatic_compaction_completed_count', 0) > 0
            and report.get('successful_test_after_automatic_compaction'))
        (output / 'codex-project-live.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps(report, indent=2))
    return 0 if report['functional_pass'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
