#!/usr/bin/env python3
"""Standalone stdlib Linux Codex apply_patch preflight/live smoke; import is inert.

--offline uses a loopback Responses fake, never remote inference or credentials.
--live forwards unmodified bodies/SSE to the existing .7 gateway, at most four
requests. Only the actual Codex tool writes fixture.txt. No sandbox bypass.
"""
from __future__ import annotations

import argparse
import copy
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import queue
import re
import secrets
import subprocess
import sys
import tempfile
import threading
import time

MODEL = 'claude-haiku-4-5-20251001'
GATEWAY_HOST, GATEWAY_PORT = '192.168.0.7', 4000
REQUEST_PATH = '/claude-responses/v1/responses'
NATIVE_OPTIONS = '{"cache_control":{"type":"ephemeral","ttl":"5m"}}'
CONTENT = {'create': b'SYNTHETIC_PATCH_CREATED\n', 'update': b'SYNTHETIC_PATCH_UPDATED\n'}
PATCHES = {
    'create': '*** Begin Patch\n*** Add File: fixture.txt\n+SYNTHETIC_PATCH_CREATED\n*** End Patch',
    'update': '*** Begin Patch\n*** Update File: fixture.txt\n@@\n-SYNTHETIC_PATCH_CREATED\n+SYNTHETIC_PATCH_UPDATED\n*** End Patch',
}
MARKERS = {'create': 'CODEX_LIVE_PATCH_CREATE_OK', 'update': 'CODEX_LIVE_PATCH_UPDATE_OK'}
SAFE_CODES = frozenset({
    'invalid_upstream_event', 'unsupported_upstream_event', 'unsupported_upstream_block',
    'unsupported_upstream_delta', 'malformed_tool_input', 'invalid_tool_grammar',
    'unknown_upstream_tool', 'invalid_upstream_usage', 'invalid_upstream_metadata',
    'provider_refusal', 'incomplete_upstream_stream', 'upstream_limit_exceeded',
    'reasoning_state_error', 'upstream_timeout', 'cancelled', 'upstream_error',
})
REQUEST_LIMIT, RESPONSE_LIMIT = 1024 * 1024, 4 * 1024 * 1024
HTTP_TIMEOUT, TURN_TIMEOUT = 75, 120


class Failure(Exception):
    """Harness-owned fixed diagnostic codes only."""


def clean_env(home):
    env = {name: value for name, value in os.environ.items() if name in {'PATH', 'LANG', 'LC_ALL'}}
    for name in ('HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'TMPDIR', 'TMP', 'TEMP'):
        env[name] = str(home)
    env.update(CODEX_HOME=str(home / 'codex-state'), RUST_LOG='off', PYTHONDONTWRITEBYTECODE='1')
    return env


def stop(child):
    if child.poll() is None:
        child.terminate()
    try:
        child.wait(timeout=5)
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait(timeout=5)


class Rpc:
    """Bounded stdio protocol; no approvals, commands, or dynamic tool execution."""
    def __init__(self, command, env, cwd):
        self.child = subprocess.Popen(command, env=env, cwd=cwd, stdin=subprocess.PIPE,
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                      text=True, encoding='utf-8', errors='replace')
        self.queue = queue.Queue()
        self.events, self.pending = [], []
        self.problem = None
        self.stdout_bytes = self.stderr_bytes = 0

        def stdout():
            for line in self.child.stdout:
                self.stdout_bytes += len(line.encode())
                if self.stdout_bytes > 5 * 1024 * 1024 or len(self.events) >= 1500:
                    self.problem = 'rpc_capture_limit'
                    self.child.terminate()
                    break
                try:
                    value = json.loads(line)
                    if not isinstance(value, dict):
                        raise ValueError()
                except ValueError:
                    self.problem = 'rpc_invalid_json'
                    self.child.terminate()
                    break
                self.events.append(value)
                self.queue.put(value)

        def stderr():
            # Drain without retaining or printing raw client errors.
            while chunk := self.child.stderr.read(4096):
                self.stderr_bytes += len(chunk.encode())
                if self.stderr_bytes > 1024 * 1024:
                    self.problem = 'rpc_stderr_limit'
                    self.child.terminate()
                    break

        self.readers = [threading.Thread(target=stdout, daemon=True), threading.Thread(target=stderr, daemon=True)]
        for reader in self.readers:
            reader.start()

    def send(self, value):
        self.child.stdin.write(json.dumps(value) + '\n')
        self.child.stdin.flush()

    def wait(self, predicate, timeout=30):
        for index, value in enumerate(self.pending):
            if predicate(value):
                return self.pending.pop(index)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.problem:
                raise Failure(self.problem)
            try:
                value = self.queue.get(timeout=.2)
            except queue.Empty:
                if self.child.poll() is not None:
                    raise Failure('rpc_process_exited')
                continue
            if value.get('method') and 'id' in value:
                self.send({'id': value['id'], 'error': {'code': -32601, 'message': 'Smoke test cannot approve additional actions'}})
                raise Failure('unexpected_server_action')
            if predicate(value):
                return value
            self.pending.append(value)
        raise Failure('rpc_timeout')

    def request(self, request_id, method, params):
        self.send({'id': request_id, 'method': method, 'params': params})
        reply = self.wait(lambda value: value.get('id') == request_id)
        if 'error' in reply:
            raise Failure('rpc_rejected')
        return reply['result']

    def close(self):
        stop(self.child)
        for reader in self.readers:
            reader.join(3)
        for stream in (self.child.stdin, self.child.stdout, self.child.stderr):
            stream.close()


def offered_tools(request):
    result = []
    for tool in request.get('tools', []):
        if not isinstance(tool, dict):
            continue
        if tool.get('type') == 'namespace':
            result.extend((child, tool.get('name')) for child in tool.get('tools', []) if isinstance(child, dict))
        else:
            result.append((tool, None))
    return result


def patch_offer(request):
    return [(tool, namespace) for tool, namespace in offered_tools(request)
            if tool.get('type') == 'custom' and tool.get('name') == 'apply_patch'
            and tool.get('format', {}).get('type') == 'grammar'
            and tool.get('format', {}).get('syntax') == 'lark']


def encode_events(values):
    return ''.join('event: ' + value['type'] + '\r\ndata: ' + json.dumps(value, ensure_ascii=False) + '\r\n\r\n'
                   for value in values).encode('utf-8')


def fake_response(phase, ordinal, request):
    """Deterministic Responses fixture; no filesystem writes or native provider."""
    offered = patch_offer(request)
    if len(offered) != 1:
        raise Failure('offline_patch_tool_not_offered')
    call_id = 'call_offline_' + phase
    if ordinal == 0:
        namespace = offered[0][1]
        items = [
            {'id': 'rs_offline_' + phase, 'type': 'reasoning', 'summary': [],
             'encrypted_content': 'OFFLINE_SYNTHETIC_OPAQUE_' + phase},
            {'id': 'ctc_offline_' + phase, 'type': 'custom_tool_call', 'call_id': call_id,
             'name': 'apply_patch', 'input': PATCHES[phase], 'status': 'completed',
             **({'namespace': namespace} if namespace is not None else {})},
        ]
    else:
        results = [item for item in request.get('input', []) if isinstance(item, dict)
                   and item.get('type') == 'custom_tool_call_output' and item.get('call_id') == call_id]
        if len(results) != 1:
            raise Failure('offline_tool_result_missing')
        items = [{'id': 'msg_offline_' + phase, 'type': 'message', 'role': 'assistant', 'status': 'completed',
                  'content': [{'type': 'output_text', 'text': MARKERS[phase], 'annotations': [], 'logprobs': []}]}]
    response = {'id': 'resp_offline_' + phase + '_' + str(ordinal), 'object': 'response', 'created_at': 1,
                'model': MODEL, 'status': 'in_progress', 'output': [], 'error': None,
                'incomplete_details': None, 'usage': None}
    values = [{'type': 'response.created', 'response': copy.deepcopy(response)},
              {'type': 'response.in_progress', 'response': copy.deepcopy(response)}]
    for index, item in enumerate(items):
        added = copy.deepcopy(item)
        if item['type'] == 'custom_tool_call':
            added.update(input='', status='in_progress')
        if item['type'] == 'message':
            added.update(content=[], status='in_progress')
        if item['type'] == 'reasoning':
            added.pop('encrypted_content')
        values.append({'type': 'response.output_item.added', 'output_index': index, 'item': added})
        if item['type'] == 'custom_tool_call':
            base = {'item_id': item['id'], 'output_index': index}
            values.extend([
                {'type': 'response.custom_tool_call_input.delta', **base, 'delta': item['input']},
                {'type': 'response.custom_tool_call_input.done', **base, 'input': item['input']},
            ])
        if item['type'] == 'message':
            part = item['content'][0]
            base = {'item_id': item['id'], 'output_index': index, 'content_index': 0}
            values.extend([
                {'type': 'response.content_part.added', **base, 'part': {**part, 'text': ''}},
                {'type': 'response.output_text.delta', **base, 'delta': part['text'], 'logprobs': []},
                {'type': 'response.output_text.done', **base, 'text': part['text'], 'logprobs': []},
                {'type': 'response.content_part.done', **base, 'part': part},
            ])
        values.append({'type': 'response.output_item.done', 'output_index': index, 'item': item})
    response.update(status='completed', output=items,
                    usage={'input_tokens': 100, 'output_tokens': 20, 'total_tokens': 120,
                           'input_tokens_details': {'cached_tokens': 0, 'cache_write_tokens': 0}})
    values.append({'type': 'response.completed', 'response': response})
    for sequence, value in enumerate(values):
        value['sequence_number'] = sequence
    return encode_events(values)


class State:
    def __init__(self, offline, key):
        self.offline, self.key = offline, key
        self.phase = 'create'
        self.records = []
        self.outgoing_attempts = 0
        self.failure = None
        self.lock = threading.Lock()

    def fail(self, code):
        with self.lock:
            if self.failure is None:
                self.failure = code

    def reserve(self, raw, request):
        with self.lock:
            if self.failure:
                raise Failure('earlier_failure')
            ordinal = sum(record['phase'] == self.phase for record in self.records)
            if len(self.records) >= 4 or ordinal >= 2:
                raise Failure('request_limit')
            record = {'phase': self.phase, 'ordinal': ordinal, 'raw': raw, 'request': request,
                      'wire': b'', 'status': None, 'finished': False}
            self.records.append(record)
            if not self.offline:
                # Consume before connecting; uncertain outcomes are never replayed.
                self.outgoing_attempts += 1
            return record


class QuietServer(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, _request, _address):
        self.state.fail('observer_handler_failed')


class Observer(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        state = self.server.state
        connection = record = None
        wire = bytearray()
        headers_sent = False
        self.connection.settimeout(HTTP_TIMEOUT)
        try:
            size = int(self.headers.get('content-length', '0'))
            if self.path != REQUEST_PATH or not 0 < size <= REQUEST_LIMIT:
                raise Failure('request_shape_failed')
            if self.headers.get('authorization') != 'Bearer ' + state.key:
                raise Failure('observer_authentication_failed')
            raw = self.rfile.read(size)
            request = json.loads(raw)
            if len(raw) != size or not isinstance(request, dict) or request.get('model') != MODEL:
                raise Failure('request_shape_failed')
            record = state.reserve(raw, request)
            if state.offline:
                wire.extend(fake_response(record['phase'], record['ordinal'], request))
                record['status'] = 200
                self.send_response(200)
                self.send_header('content-type', 'text/event-stream')
                self.send_header('content-length', str(len(wire)))
                self.end_headers()
                headers_sent = True
                self.wfile.write(wire)
                self.wfile.flush()
            else:
                headers = {name: value for name, value in self.headers.items()
                           if name.lower() not in {'host', 'connection', 'transfer-encoding', 'accept-encoding'}}
                headers['accept-encoding'] = 'identity'
                connection = http.client.HTTPConnection(GATEWAY_HOST, GATEWAY_PORT, timeout=HTTP_TIMEOUT)
                connection.request('POST', self.path, raw, headers)
                response = connection.getresponse()
                record['status'] = response.status
                self.send_response(response.status)
                for name, value in response.getheaders():
                    if name.lower() not in {'connection', 'transfer-encoding', 'content-length', 'server', 'date'}:
                        self.send_header(name, value)
                self.send_header('connection', 'close')
                self.end_headers()
                headers_sent = True
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
            if not headers_sent:
                try:
                    self.send_response(502)
                    self.send_header('content-length', '0')
                    self.send_header('connection', 'close')
                    self.end_headers()
                except OSError:
                    pass
        finally:
            if connection is not None:
                connection.close()
            if record is not None:
                record['wire'], record['finished'] = bytes(wire), True


def events(record):
    values = []
    for block in record['wire'].decode('utf-8').replace('\r\n', '\n').split('\n\n'):
        data = '\n'.join(line[5:].lstrip(' ') for line in block.split('\n') if line.startswith('data:'))
        if data and data != '[DONE]':
            value = json.loads(data)
            if not isinstance(value, dict):
                raise ValueError()
            values.append(value)
    return values


def capsules(items):
    return [(item.get('id'), item.get('encrypted_content')) for item in items
            if isinstance(item, dict) and item.get('type') == 'reasoning']


def completed_output(record):
    responses = [value['response'] for value in events(record) if value.get('type') == 'response.completed']
    return responses[0].get('output', []) if len(responses) == 1 else []


def usage_only(response):
    def count(value):
        return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None
    native, standard = response.get('anthropic_usage') or {}, response.get('usage') or {}
    details = standard.get('input_tokens_details') or {}
    return {'native_input_tokens': count(native.get('input_tokens')), 'native_output_tokens': count(native.get('output_tokens')),
            'cache_creation_input_tokens': count(native.get('cache_creation_input_tokens')),
            'cache_read_input_tokens': count(native.get('cache_read_input_tokens')),
            'input_tokens': count(standard.get('input_tokens')), 'output_tokens': count(standard.get('output_tokens')),
            'total_tokens': count(standard.get('total_tokens')), 'cached_tokens': count(details.get('cached_tokens')),
            'cache_write_tokens': count(details.get('cache_write_tokens'))}


def request_summary(record, previous_capsules):
    summary = {'http_status': record['status'], 'finished': record['finished'], 'completed_count': 0,
               'failure_codes': [], 'reasoning_count': 0, 'reasoning_done_completed_exact': None,
               'prior_reasoning_replay_exact': None, 'marker_present': False, 'usage': None}
    try:
        values = events(record)
        for value in values:
            if value.get('type') == 'response.failed':
                error = (value.get('response') or {}).get('error') or {}
                code = error.get('code')
                summary['failure_codes'].append(code if isinstance(code, str) and code in SAFE_CODES else 'unrecognized_sse_failure')
        done = [value['item'] for value in values if value.get('type') == 'response.output_item.done']
        complete = [value['response'] for value in values if value.get('type') == 'response.completed']
        summary['completed_count'] = len(complete)
        if previous_capsules:
            summary['prior_reasoning_replay_exact'] = previous_capsules == capsules(record['request'].get('input', []))
        if len(complete) == 1:
            issued, final = capsules(done), capsules(complete[0].get('output', []))
            summary['reasoning_count'] = len(issued)
            if issued or final:
                summary['reasoning_done_completed_exact'] = issued == final and all(
                    isinstance(item_id, str) and item_id and isinstance(sealed, str) and sealed for item_id, sealed in issued)
            summary['marker_present'] = any(MARKERS[record['phase']] in part.get('text', '')
                for item in complete[0].get('output', []) if item.get('type') == 'message'
                for part in item.get('content', []) if isinstance(part, dict) and isinstance(part.get('text'), str))
            summary['usage'] = usage_only(complete[0])
    except (ValueError, KeyError, TypeError, AttributeError, UnicodeError):
        summary['parse_failed'] = True
    return summary


def phase_evidence(state, phase, workspace, notifications, terminal):
    records = [record for record in state.records if record['phase'] == phase]
    summaries, previous = [], []
    for record in state.records:
        if record['phase'] == phase:
            summaries.append(request_summary(record, previous))
        try:
            previous.extend(capsules(completed_output(record)))
        except (ValueError, KeyError, TypeError):
            pass
    calls = [item for record in records for item in completed_output(record)
             if item.get('type') in {'custom_tool_call', 'function_call'}]
    patch_calls = [item for item in calls if item.get('type') == 'custom_tool_call' and item.get('name') == 'apply_patch']
    results = [item for record in records[1:] for item in record['request'].get('input', [])
               if item.get('type') == 'custom_tool_call_output' and len(patch_calls) == 1
               and item.get('call_id') == patch_calls[0].get('call_id')]
    changes = [event.get('params', {}).get('item', {}) for event in notifications
               if event.get('method') == 'item/completed' and event.get('params', {}).get('item', {}).get('type') == 'fileChange']
    path = workspace / 'fixture.txt'
    file_exact = path.is_file() and not path.is_symlink() and path.read_bytes() == CONTENT[phase]
    files = [path for path in workspace.rglob('*') if path.is_file() or path.is_symlink()]
    status = terminal.get('params', {}).get('turn', {}).get('status')
    metadata = records[0]['request'].get('client_metadata', {}) if records else {}
    try:
        mode = json.loads(metadata.get('x-codex-turn-metadata', '{}')).get('sandbox_mode')
    except (ValueError, AttributeError, TypeError):
        mode = None
    offered = offered_tools(records[0]['request']) if records else []
    evidence = {'terminal_status': status if status in {'completed', 'failed', 'interrupted'} else 'unobserved',
        'requests': summaries, 'request_count': len(records), 'expected_request_count': len(records) == 2,
        'patch_call_count': len(patch_calls), 'non_patch_tool_call_count': len(calls) - len(patch_calls),
        'patch_result_present': len(results) == 1, 'patch_result_error_flag': any(item.get('is_error', False) for item in results),
        'file_change_completed_count': sum(item.get('status') == 'completed' for item in changes),
        'file_change_failed_count': sum(item.get('status') != 'completed' for item in changes),
        'file_exact': file_exact, 'workspace_file_count': len(files),
        'apply_patch_freeform_offered': bool(records) and len(patch_offer(records[0]['request'])) == 1,
        'shell_tool_offered': any(tool.get('name') in {'shell', 'shell_command', 'exec_command'} for tool, _ in offered),
        'client_metadata_workspace_write': mode == 'workspace-write' if mode is not None else None,
        'patch_input_matches_requested': len(patch_calls) == 1 and patch_calls[0].get('input') == PATCHES[phase],
        'marker_present': any(summary['marker_present'] for summary in summaries)}
    evidence['functional_pass'] = (status == 'completed' and state.failure is None and len(records) == 2
        and all(record['status'] == 200 and record['finished'] for record in records)
        and len(patch_calls) == len(calls) == len(results) == 1 and not evidence['patch_result_error_flag']
        and evidence['file_change_completed_count'] == 1 and evidence['file_change_failed_count'] == 0
        and file_exact and len(files) == 1 and evidence['apply_patch_freeform_offered']
        and not evidence['shell_tool_offered'] and evidence['marker_present'])
    return evidence


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--offline', action='store_true', help='Actual client against a deterministic loopback fake; no credential or inference')
    mode.add_argument('--live', action='store_true', help='Actual client through existing .7; at most four real Haiku requests')
    parser.add_argument('--codex', type=Path, required=True)
    parser.add_argument('--gateway-key-env', default='CODEX_PATCH_GATEWAY_KEY', help='Environment variable NAME only, never a credential value')
    parser.add_argument('--output', type=Path, required=True, help='NEW directory beneath system temp')
    args = parser.parse_args(argv)
    if not sys.platform.startswith('linux'):
        parser.error('This harness targets the isolated Linux test container')
    if args.live and not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,127}', args.gateway_key_env):
        parser.error('--gateway-key-env must be an environment variable name')
    output = args.output.resolve()
    if output.exists() or Path(tempfile.gettempdir()).resolve() not in output.parents:
        parser.error('--output must be a NEW directory beneath system temp')
    output.mkdir(parents=True)
    home, workspace = output / 'home', output / 'workspace'
    home.mkdir()
    workspace.mkdir()
    (home / 'codex-state').mkdir()
    report = {'mode': 'offline' if args.offline else 'live', 'model': MODEL, 'functional_pass': False,
              'sandbox_requested': 'workspace-write', 'approval_policy': 'never', 'sandbox_bypass': False,
              'same_thread_followup': True, 'installed_client_modified': False, 'raw_observations_persisted': False,
              'temporary_client_history_retained': True, 'gateway_internals_observed': False,
              'request_limit': 4, 'request_max_retries': 0, 'stream_max_retries': 0,
              'phases': {}, 'failure_code': None, 'failure_phase': None}
    state = rpc = server = server_thread = None
    try:
        codex = args.codex.resolve(strict=True)
        env = clean_env(home)
        version = subprocess.run([str(codex), '--version'], env=env, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, text=True, timeout=10)
        report['codex_version_pinned'] = version.returncode == 0 and version.stdout.strip() == 'codex-cli 0.160.0'
        if not report['codex_version_pinned']:
            raise Failure('codex_version_mismatch')
        # Offline mode never reads the named credential variable.
        key = 'sk-offline-' + secrets.token_hex(24) if args.offline else os.environ.get(args.gateway_key_env)
        if not key or not key.isascii() or not all(33 <= ord(char) <= 126 for char in key) or len(key) > 4096:
            raise Failure('gateway_key_environment_missing_or_invalid')
        state = State(args.offline, key)
        server = QuietServer(('127.0.0.1', 0), Observer)
        server.state = state
        server_thread = threading.Thread(target=server.serve_forever, daemon=True)
        server_thread.start()
        catalog = {'models': [{'slug': MODEL, 'display_name': 'Limited patch test profile (NOT official Claude metadata)',
            'supported_reasoning_levels': [], 'shell_type': 'disabled', 'visibility': 'list', 'supported_in_api': True,
            'priority': 0, 'support_verbosity': False, 'apply_patch_tool_type': 'freeform',
            'truncation_policy': {'mode': 'bytes', 'limit': 100000}, 'experimental_supported_tools': [],
            'base_instructions': 'Bounded file-edit test. Only the apply_patch tool may create or update the relative fixture.txt in the current workspace. Never use shell, commands, network, search, agents or other tools. Make exactly the requested patch, then return the requested marker.',
            'supports_reasoning_summary_parameter': False, 'input_modalities': ['text']}]}
        catalog_path = home / 'model-catalog.json'
        catalog_path.write_text(json.dumps(catalog, indent=2), encoding='utf-8')
        env['CODEX_PATCH_GATEWAY_KEY'] = key
        overrides = {'model': MODEL, 'model_provider': 'patch_smoke', 'model_catalog_json': str(catalog_path),
            'sandbox_mode': 'workspace-write', 'sandbox_workspace_write.network_access': False,
            'sandbox_workspace_write.exclude_tmpdir_env_var': True, 'sandbox_workspace_write.exclude_slash_tmp': True,
            'approval_policy': 'never', 'web_search': 'disabled', 'agents.enabled': False,
            'analytics.enabled': False, 'feedback.enabled': False, 'check_for_update_on_startup': False,
            'otel.exporter': 'none', 'otel.trace_exporter': 'none', 'cli_auth_credentials_store': 'file',
            'model_providers.patch_smoke.name': 'Isolated patch smoke',
            'model_providers.patch_smoke.base_url': 'http://127.0.0.1:' + str(server.server_port) + REQUEST_PATH.removesuffix('/responses'),
            'model_providers.patch_smoke.wire_api': 'responses', 'model_providers.patch_smoke.env_key': 'CODEX_PATCH_GATEWAY_KEY',
            'model_providers.patch_smoke.requires_openai_auth': False, 'model_providers.patch_smoke.supports_websockets': False,
            'model_providers.patch_smoke.request_max_retries': 0, 'model_providers.patch_smoke.stream_max_retries': 0,
            'model_providers.patch_smoke.stream_idle_timeout_ms': HTTP_TIMEOUT * 1000}
        command = [str(codex), 'app-server', '--stdio']
        for name, value in overrides.items():
            command.extend(['-c', name + '=' + json.dumps(value)])
        command.extend(['-c', 'model_providers.patch_smoke.http_headers={"x-claude-proxy-native-options"=' + json.dumps(NATIVE_OPTIONS) + '}'])
        rpc = Rpc(command, env, workspace)
        rpc.request(0, 'initialize', {'clientInfo': {'name': 'codex_patch_smoke', 'version': '1.0'},
                                      'capabilities': {'experimentalApi': True}})
        rpc.send({'method': 'initialized', 'params': {}})
        thread = rpc.request(1, 'thread/start', {'model': MODEL, 'modelProvider': 'patch_smoke', 'cwd': str(workspace),
            'sandbox': 'workspace-write', 'approvalPolicy': 'never', 'ephemeral': False})
        thread_id = thread['thread']['id']
        for request_id, phase in enumerate(PATCHES, start=2):
            state.phase = phase
            begin = len(rpc.events)
            prompt = ('Use apply_patch exactly once to apply the following patch to fixture.txt in the current workspace. '
                      'Do not run commands or use other tools. After the tool result, reply with exactly ' + MARKERS[phase] + '.\n\n' + PATCHES[phase])
            rpc.request(request_id, 'turn/start', {'threadId': thread_id, 'input': [{'type': 'text', 'text': prompt}],
                'approvalPolicy': 'never', 'sandboxPolicy': {'type': 'workspaceWrite', 'writableRoots': [str(workspace)],
                    'networkAccess': False, 'excludeTmpdirEnvVar': True, 'excludeSlashTmp': True}})
            terminal = rpc.wait(lambda value: value.get('method') == 'turn/completed'
                and value.get('params', {}).get('threadId') == thread_id, TURN_TIMEOUT)
            deadline = time.monotonic() + 5
            while any(not record['finished'] for record in state.records) and time.monotonic() < deadline:
                time.sleep(.05)
            evidence = phase_evidence(state, phase, workspace, rpc.events[begin:], terminal)
            report['phases'][phase] = evidence
            if not evidence['functional_pass']:
                raise Failure('phase_failed')
        report['functional_pass'] = True
    except Exception as error:
        report['failure_code'] = str(error) if isinstance(error, Failure) else 'runtime_or_protocol_failed'
        report['failure_phase'] = state.phase if state else 'setup'
    finally:
        if rpc is not None:
            try:
                rpc.close()
            except Exception:
                report['functional_pass'], report['cleanup_failed'] = False, True
        if server is not None:
            server.shutdown()
            server.server_close()
            server_thread.join(3)
        report['client_request_count'] = len(state.records) if state else 0
        report['gateway_request_attempts'] = state.outgoing_attempts if state else 0
        report['actual_dot7_gateway_tested'] = bool(state and state.outgoing_attempts)
        report['observer_failure_code'] = state.failure if state else None
        report['offline_fake_used'] = args.offline
        report['native_signature_validation_tested'] = False
        report['observed_four_request_sequence'] = report['client_request_count'] == 4 and report['gateway_request_attempts'] == (0 if args.offline else 4)
        report['functional_pass'] = report['functional_pass'] and report['observed_four_request_sequence']
        # Save only projections; raw SSE/request/RPC data and errors never leave memory.
        previous = []
        for record in state.records if state else []:
            if record['phase'] not in report['phases']:
                report['phases'][record['phase']] = {'functional_pass': False, 'terminal_status': 'unobserved', 'requests': []}
            if 'request_count' not in report['phases'][record['phase']]:
                report['phases'][record['phase']]['requests'].append(request_summary(record, previous))
            try:
                previous.extend(capsules(completed_output(record)))
            except (ValueError, TypeError, KeyError):
                pass
        checks = [summary[name] for phase in report['phases'].values() for summary in phase.get('requests', [])
                  for name in ('reasoning_done_completed_exact', 'prior_reasoning_replay_exact') if summary.get(name) is not None]
        report['opaque_reasoning_check_count'] = len(checks)
        report['observed_opaque_reasoning_preserved'] = all(checks) if checks else None
        report['reasoning_source'] = 'synthetic_offline' if args.offline else 'gateway_response'
        report_path = output / 'codex-patch-live-smoke.json'
        report_path.write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps(report, indent=2))
    print('Report:', report_path)
    return 0 if report['functional_pass'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
