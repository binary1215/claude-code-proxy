"""Opt-in actual Codex -> existing gateway or local stock LiteLLM -> real Haiku.

Gateway mode starts no LiteLLM service and requires no local LiteLLM package.
Local diagnosis uses existing stock LiteLLM 1.103.1. Both use Codex 0.160.0.
No live operation occurs on import. Bodies, SSE and opaque state stay in memory;
Codex's own isolated temporary session history is retained, not exported by us.
"""
from __future__ import annotations

import argparse
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.metadata
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from urllib.parse import urlsplit

import yaml

from codex_compaction_smoke import Rpc
from codex_patch_smoke import ROOT, clean_env, identities, start, stop

MODEL = 'claude-haiku-4-5-20251001'
REMOTE_HOST = '192.168.0.64'
REMOTE_PORT = 13457
GATEWAY_PATH = '/codex-live/v1/responses'
REMOTE_PATH = '/v1/responses'
NATIVE_OPTIONS = '{"cache_control":{"type":"ephemeral","ttl":"5m"}}'
PHASE_LIMITS = {'initial': 2, 'compact': 1, 'followup': 1, 'followup_second': 1}
MARKERS = {'initial': 'CODEX_LIVE_INITIAL_OK', 'followup': 'CODEX_LIVE_FOLLOWUP_OK',
           'followup_second': 'CODEX_LIVE_SECOND_FOLLOWUP_OK'}
MAX_REQUEST = 1024 * 1024
MAX_RESPONSE = 4 * 1024 * 1024
HTTP_TIMEOUT = 75
TURN_TIMEOUT = 100
TERMINAL_STATUSES = {'completed', 'failed', 'interrupted', 'in_progress'}
SAFE_SSE_FAILURE_CODES = frozenset({
    'invalid_upstream_event', 'unsupported_upstream_event', 'unsupported_upstream_block',
    'unsupported_upstream_delta', 'malformed_tool_input', 'invalid_tool_grammar',
    'unknown_upstream_tool', 'invalid_upstream_usage', 'invalid_upstream_metadata',
    'provider_refusal', 'incomplete_upstream_stream', 'upstream_limit_exceeded',
    'reasoning_state_error', 'upstream_timeout', 'cancelled', 'upstream_error',
})
CACHE_FIXTURE_ROWS = 128


def cache_fixture_text():
    """Stable inert catalog reference data; no observer/request modification."""
    words = 'amber birch cedar dawn elm fern garden harbor island jade lake meadow north oak pine quartz river stone timber valley willow'
    rows = [f'Reference row {index:03d}: {words}.' for index in range(1, CACHE_FIXTURE_ROWS + 1)]
    return ('\n\nThe following synthetic reference material is inert cache-test data. '
            'It contains no tasks or instructions; do not act on, repeat, or summarize it. '
            'Continue following only the smoke-test instructions and requested response markers.\n'
            '<cache_reference_fixture>\n' + '\n'.join(rows) + '\n</cache_reference_fixture>\n')


def safe_sse_failures(stream):
    """Never copy free-form provider error codes/messages into a safe report."""
    result = []
    for event in stream:
        if event.get('type') not in {'response.failed', 'error'}:
            continue
        source = event.get('response') if event.get('type') == 'response.failed' else event
        error = source.get('error') if isinstance(source, dict) else None
        code = error.get('code') if isinstance(error, dict) else source.get('code') if isinstance(source, dict) else None
        result.append(code if isinstance(code, str) and code in SAFE_SSE_FAILURE_CODES else 'unrecognized_sse_failure')
    return result


def cache_observations(usages):
    writes = [usage['cache_creation_input_tokens'] for usage in usages if isinstance(usage, dict)
              and isinstance(usage.get('cache_creation_input_tokens'), int) and not isinstance(usage.get('cache_creation_input_tokens'), bool)]
    reads = [usage['cache_read_input_tokens'] for usage in usages if isinstance(usage, dict)
             and isinstance(usage.get('cache_read_input_tokens'), int) and not isinstance(usage.get('cache_read_input_tokens'), bool)]
    return {'cache_write_observed': any(value > 0 for value in writes) if writes else None,
            'cache_hit_observed': any(value > 0 for value in reads) if reads else None,
            'cache_write_usage_response_count': len(writes), 'cache_read_usage_response_count': len(reads)}


class HarnessFailure(Exception):
    """Only harness-owned fixed codes may be put in the safe report."""


class State:
    def __init__(self, gateway_key, relay_key=None, gateway_target=None):
        self.phase = 'initial'
        self.gateway_key = gateway_key
        self.relay_key = relay_key
        self.gateway_target = gateway_target
        self.client_path = gateway_target[3] if gateway_target else GATEWAY_PATH
        self.records = {'client': [], 'remote': []}
        self.lock = threading.Lock()
        self.failure = None
        self.remote_attempts = 0
        self.gateway_attempts = 0

    def fail(self, code):
        with self.lock:
            if self.failure is None:
                self.failure = code


class QuietServer(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, _request, _address):
        # Never let a handler traceback print request data or provider errors.
        self.state.fail('observer_handler_failed')


class Observer(BaseHTTPRequestHandler):
    """Forward received bytes once; gateway mode never contacts .64 directly."""
    def log_message(self, *_):
        pass

    def reject(self, status=502):
        body = b'{"error":{"message":"Live smoke stopped"}}'
        self.send_response(status)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(body)))
        self.send_header('connection', 'close')
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True

    def do_POST(self):
        state = self.server.state
        leg = self.server.leg
        record = None
        connection = None
        wire = bytearray()
        headers_sent = False
        self.connection.settimeout(HTTP_TIMEOUT)
        try:
            size = int(self.headers.get('content-length', '0'))
            if self.path != (state.client_path if leg == 'client' else REMOTE_PATH) or not 0 < size <= MAX_REQUEST:
                raise HarnessFailure('observer_request_shape_failed')
            raw = self.rfile.read(size)
            request = json.loads(raw)
            if len(raw) != size or not isinstance(request, dict) or request.get('model') != MODEL:
                raise HarnessFailure('observer_request_shape_failed')
            if self.headers.get('x-claude-proxy-native-options') != NATIVE_OPTIONS:
                raise HarnessFailure('caller_cache_header_changed')
            expected_key = state.gateway_key if leg == 'client' else state.relay_key
            if self.headers.get('authorization') != 'Bearer ' + expected_key:
                raise HarnessFailure('observer_authentication_failed')
            # Bodies are never repaired. Stock LiteLLM can reserialize JSON;
            # body-byte equality is an observation, not a forwarding gate.
            with state.lock:
                phase = state.phase
                if state.failure is not None:
                    raise HarnessFailure('earlier_failure')
                same_phase = [r for r in state.records[leg] if r['phase'] == phase]
                if len(same_phase) >= PHASE_LIMITS[phase]:
                    raise HarnessFailure('phase_request_limit')
                if leg == 'remote':
                    if state.remote_attempts >= 5:
                        raise HarnessFailure('remote_request_limit')
                    # Count BEFORE connect/write: an uncertain outcome consumes
                    # its slot, and is never replayed by the observer.
                    state.remote_attempts += 1
                elif state.gateway_target is not None:
                    if state.gateway_attempts >= 5:
                        raise HarnessFailure('gateway_request_limit')
                    state.gateway_attempts += 1
                record = {'phase': phase, 'raw': raw, 'request': request,
                          'wire': b'', 'status': None, 'finished': False,
                          'auth_exact': True, 'cache_header_exact': True}
                state.records[leg].append(record)
            headers = {k: v for k, v in self.headers.items()
                       if k.lower() not in {'host', 'connection', 'transfer-encoding', 'accept-encoding'}}
            headers['accept-encoding'] = 'identity'
            if leg == 'remote':
                scheme, host, port = 'http', REMOTE_HOST, REMOTE_PORT
            elif state.gateway_target is not None:
                scheme, host, port, _ = state.gateway_target
            else:
                scheme, host, port = 'http', '127.0.0.1', self.server.target_port
            connection_type = http.client.HTTPSConnection if scheme == 'https' else http.client.HTTPConnection
            connection = connection_type(host, port, timeout=HTTP_TIMEOUT)
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
                if len(wire) > MAX_RESPONSE:
                    raise HarnessFailure('response_capture_limit')
                self.wfile.write(chunk)
                self.wfile.flush()
            self.close_connection = True
        except Exception as error:
            state.fail(str(error) if isinstance(error, HarnessFailure) else 'observer_transport_failed')
            if not headers_sent:
                try:
                    self.reject()
                except OSError:
                    pass
        finally:
            if connection is not None:
                connection.close()
            if record is not None:
                record['wire'] = bytes(wire)
                record['finished'] = True


def events(record):
    result = []
    for block in record['wire'].decode('utf-8').replace('\r\n', '\n').split('\n\n'):
        data = '\n'.join(line[5:].lstrip(' ') for line in block.split('\n') if line.startswith('data:'))
        if data and data != '[DONE]':
            value = json.loads(data)
            if not isinstance(value, dict):
                raise ValueError('Invalid SSE event')
            result.append(value)
    return result


def response_items(record):
    stream = events(record)
    done = [e['item'] for e in stream if e.get('type') == 'response.output_item.done']
    completed = [e['response'] for e in stream if e.get('type') == 'response.completed']
    return done, completed


def capsules(items):
    return [(item.get('id'), item.get('encrypted_content')) for item in items
            if isinstance(item, dict) and item.get('type') == 'reasoning']


def request_capsules(record):
    return capsules(record['request'].get('input', []))


def usage_only(response):
    """Project only known numeric counters; missing values remain unknown."""
    def count(value):
        return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None

    native = response.get('anthropic_usage') or {}
    standard = response.get('usage') or {}
    cache = native.get('cache_creation') or {}
    details = standard.get('input_tokens_details') or {}
    return {
        'native_input_tokens': count(native.get('input_tokens')),
        'native_output_tokens': count(native.get('output_tokens')),
        'cache_creation_input_tokens': count(native.get('cache_creation_input_tokens')),
        'cache_read_input_tokens': count(native.get('cache_read_input_tokens')),
        'ephemeral_5m_input_tokens': count(cache.get('ephemeral_5m_input_tokens')),
        'ephemeral_1h_input_tokens': count(cache.get('ephemeral_1h_input_tokens')),
        'input_tokens': count(standard.get('input_tokens')),
        'output_tokens': count(standard.get('output_tokens')),
        'total_tokens': count(standard.get('total_tokens')),
        'cached_tokens': count(details.get('cached_tokens')),
        'cache_write_tokens': count(details.get('cache_write_tokens')),
    }


def record_summary(record):
    summary = {'http_status': record['status'], 'finished': record['finished'],
               'auth_exact': record['auth_exact'], 'caller_cache_header_exact': record['cache_header_exact'],
               'sse_parsed': False, 'sse_failure_codes': [], 'response_completed_count': 0, 'reasoning_count': 0,
               'reasoning_present': False, 'reasoning_done_completed_exact': None,
               'encrypted_content_present': False, 'marker_present': False, 'usage': None}
    try:
        stream = events(record)
        summary['sse_failure_codes'] = safe_sse_failures(stream)
        done = [event['item'] for event in stream if event.get('type') == 'response.output_item.done']
        completed = [event['response'] for event in stream if event.get('type') == 'response.completed']
        summary['sse_parsed'] = True
        summary['response_completed_count'] = len(completed)
        if len(completed) != 1:
            return summary
        output = completed[0].get('output', [])
        done_capsules = capsules(done)
        complete_capsules = capsules(output)
        summary.update(reasoning_count=len(done_capsules), reasoning_present=bool(done_capsules or complete_capsules),
                       reasoning_done_completed_exact=done_capsules == complete_capsules if done_capsules or complete_capsules else None,
                       encrypted_content_present=bool(done_capsules) and all(
                           isinstance(item_id, str) and bool(item_id) and isinstance(sealed, str) and bool(sealed)
                           for item_id, sealed in done_capsules), usage=usage_only(completed[0]))
        marker = MARKERS.get(record['phase'])
        summary['marker_present'] = marker is not None and any(
            marker in block.get('text', '') for item in output if item.get('type') == 'message'
            for block in item.get('content', []) if isinstance(block, dict) and isinstance(block.get('text'), str))
    except (ValueError, KeyError, TypeError, AttributeError, UnicodeError):
        pass
    return summary


def phase_records(state, leg, phase):
    return [record for record in state.records[leg] if record['phase'] == phase]


def phase_evidence(state, phase):
    client = phase_records(state, 'client', phase)
    remote = phase_records(state, 'remote', phase)
    summaries = [record_summary(r) for r in client]
    double_observed = state.gateway_target is None
    paired = len(client) == len(remote) == PHASE_LIMITS[phase] if double_observed else None
    expected = paired if double_observed else len(client) == PHASE_LIMITS[phase]
    return {'client_requests': len(client), 'remote_requests': len(remote) if double_observed else None, 'requests': summaries,
            'relay_ingress_observed': double_observed, 'gateway_internals_observed': False,
            'expected_request_count': expected,
            'request_bytes_exact': paired and all(a['raw'] == b['raw'] for a, b in zip(client, remote)),
            'request_json_exact': paired and all(a['request'] == b['request'] for a, b in zip(client, remote)),
            'request_json_exact_except_metadata': paired and all(
                {k: v for k, v in a['request'].items() if k != 'metadata'} ==
                {k: v for k, v in b['request'].items() if k != 'metadata'} for a, b in zip(client, remote)),
            'request_metadata_removed': paired and any('metadata' in a['request'] and 'metadata' not in b['request'] for a, b in zip(client, remote)),
            'request_input_exact': paired and all(a['request'].get('input') == b['request'].get('input') for a, b in zip(client, remote)),
            'sse_bytes_exact': paired and all(a['wire'] == b['wire'] for a, b in zip(client, remote)),
            'transport_pass': expected and all(r['status'] == 200 and r['finished'] for r in client)
                              and (not double_observed or all(r['status'] == 200 and r['finished'] for r in remote)),
            'responses_with_reasoning': sum(s['reasoning_present'] for s in summaries),
            'responses_without_reasoning': sum(not s['reasoning_present'] for s in summaries),
            'reasoning_done_completed_exact': all(
                s['response_completed_count'] == 1 and s['reasoning_done_completed_exact'] and s['encrypted_content_present']
                for s in summaries if s['reasoning_present']) if any(s['reasoning_present'] for s in summaries) else None,
            'marker_present': None if phase == 'compact' else any(s['marker_present'] for s in summaries)}


def goal_evidence(initial):
    result = {'get_goal_call_count': 0, 'get_goal_tool_result_present': False,
              'get_goal_tool_result_success': False, 'initial_reasoning_replay_exact': None}
    if len(initial) != 2:
        return result
    try:
        _, completed = response_items(initial[0])
        output = completed[0]['output']
        calls = [item for item in output if item.get('type') == 'function_call']
        goal_calls = [item for item in calls if item.get('name') == 'get_goal' and json.loads(item.get('arguments', 'null')) == {}]
        result['get_goal_call_count'] = len(goal_calls)
        results = [item for item in initial[1]['request'].get('input', [])
                   if item.get('type') == 'function_call_output' and len(goal_calls) == 1
                   and item.get('call_id') == goal_calls[0].get('call_id')]
        result['get_goal_tool_result_present'] = len(calls) == len(goal_calls) == len(results) == 1
        if result['get_goal_tool_result_present']:
            content = results[0].get('output')
            result['get_goal_tool_result_success'] = not results[0].get('is_error', False) and isinstance(content, str) and json.loads(content) == {
                'goal': None, 'remainingTokens': None, 'completionBudgetReport': None}
        issued = capsules(output)
        result['initial_reasoning_replay_exact'] = issued == request_capsules(initial[1]) if issued else None
    except (ValueError, KeyError, TypeError, IndexError):
        pass
    return result


def settle(state, phase):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        records = phase_records(state, 'client', phase) + phase_records(state, 'remote', phase)
        if records and all(record['finished'] for record in records):
            return
        time.sleep(.05)
    raise HarnessFailure('observer_settle_timeout')


def check_phase(state, report, phase, terminal, rpc):
    status = terminal.get('params', {}).get('turn', {}).get('status')
    report['phases'][phase] = {'terminal_status': status if status in TERMINAL_STATUSES else 'unknown', 'pass': False}
    settle(state, phase)
    evidence = phase_evidence(state, phase)
    evidence['terminal_status'] = status if status in TERMINAL_STATUSES else 'unknown'
    if phase == 'initial':
        evidence.update(goal_evidence(phase_records(state, 'client', phase)))
    elif phase == 'compact':
        compaction = phase_records(state, 'client', phase)
        initial = phase_records(state, 'client', 'initial')
        emitted = [item for record in initial for item in response_items(record)[1][0].get('output', [])]
        evidence['initial_reasoning_compaction_replay_exact'] = len(compaction) == 1 and capsules(emitted) == request_capsules(compaction[0]) if capsules(emitted) else None
        evidence['compact_current_tools_empty'] = len(compaction) == 1 and compaction[0]['request'].get('tools', []) == []
        for name, method in [('context_compaction_started', 'item/started'), ('context_compaction_completed', 'item/completed')]:
            evidence[name] = any(e.get('method') == method and e.get('params', {}).get('item', {}).get('type') == 'contextCompaction' for e in rpc.events)
    elif phase == 'followup':
        records = phase_records(state, 'client', phase)
        evidence['post_compaction_input_has_no_old_reasoning'] = len(records) == 1 and request_capsules(records[0]) == []
    elif phase == 'followup_second':
        previous = phase_records(state, 'client', 'followup')
        current = phase_records(state, 'client', phase)
        issued = capsules(response_items(previous[0])[1][0].get('output', [])) if len(previous) == 1 else []
        evidence['post_compaction_reasoning_replay_exact'] = len(current) == 1 and issued == request_capsules(current[0]) if issued else None
    report['phases'][phase] = evidence
    # Functional progress is distinct from reasoning coverage and byte-level
    # diagnostics. Real Haiku may emit text only on a successful continuation.
    functional = status == 'completed' and state.failure is None and evidence['transport_pass']
    if phase != 'compact':
        functional = functional and evidence['marker_present']
    if phase == 'initial':
        functional = functional and evidence['get_goal_tool_result_present'] and evidence['get_goal_tool_result_success']
    if phase == 'compact':
        functional = functional and evidence['context_compaction_started'] and evidence['context_compaction_completed']
    evidence['functional_pass'] = bool(functional)
    evidence['pass'] = evidence['functional_pass']
    if not evidence['functional_pass']:
        raise HarnessFailure('phase_failed')


def start_observer(state, leg):
    server = QuietServer(('127.0.0.1', 0), Observer)
    server.state = state
    server.leg = leg
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread


def gateway_target(base_url):
    """Parse an explicit base URL; credentials must be supplied by env only."""
    parsed = urlsplit(base_url)
    if (parsed.scheme not in {'http', 'https'} or not parsed.hostname or parsed.hostname == REMOTE_HOST or parsed.username is not None
            or parsed.password is not None or parsed.query or parsed.fragment
            or not parsed.path.rstrip('/').endswith('/v1')
            or any(ord(char) < 33 for char in base_url)):
        raise ValueError('Use an HTTP(S) gateway base URL ending in /v1 without credentials, query or fragment')
    return parsed.scheme, parsed.hostname, parsed.port or (443 if parsed.scheme == 'https' else 80), parsed.path.rstrip('/') + '/responses'


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--live', action='store_true', help='Required explicit opt-in for at most five live outbound requests')
    parser.add_argument('--codex', type=Path, required=True, help='Existing Codex 0.160.0 executable')
    parser.add_argument('--relay-key-env', default='CODEX_LIVE_RELAY_KEY', help='Environment variable NAME only; never put a key in an argument')
    parser.add_argument('--gateway-base-url', help='Existing gateway base URL, e.g. http://192.168.0.7:4000/claude-responses/v1; skips local LiteLLM')
    parser.add_argument('--gateway-key-env', default='CODEX_LIVE_GATEWAY_KEY', help='Existing gateway credential environment variable NAME only')
    parser.add_argument('--cache-fixture', action='store_true', help='Add stable inert catalog reference text for a roughly 6k-input-token cache test; same five-call cap')
    parser.add_argument('--output', type=Path, required=True, help='NEW directory under system temp, outside the repository')
    args = parser.parse_args(argv)
    if not args.live:
        parser.error('--live is required; no live request was made')
    target = None
    if args.gateway_base_url:
        try:
            target = gateway_target(args.gateway_base_url)
        except ValueError:
            parser.error('--gateway-base-url must be an HTTP(S) base ending in /v1, without credentials, query or fragment')
    gateway_mode = target is not None
    key_env = args.gateway_key_env if gateway_mode else args.relay_key_env
    if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,127}', key_env):
        parser.error('The selected key environment argument must be a variable name')
    output = args.output.resolve()
    temp_root = Path(tempfile.gettempdir()).resolve()
    if output.exists() or temp_root not in output.parents or output == ROOT or ROOT in output.parents:
        parser.error('--output must be a NEW system-temp child outside the repository')
    output.mkdir(parents=True)
    workspace = output / 'workspace'
    workspace.mkdir()
    home = output / 'codex-state'
    home.mkdir()
    cache_reference = cache_fixture_text() if args.cache_fixture else ''
    report = {'scope': 'actual Codex -> existing gateway -> configured relay -> real Haiku' if gateway_mode else 'actual Codex -> temporary local stock LiteLLM -> .64 relay -> real Haiku',
              'mode': 'existing_gateway' if gateway_mode else 'local_stock',
              'actual_dot7_gateway_tested': False, 'live_opt_in': True, 'model': MODEL,
              'local_litellm_started': False, 'gateway_internals_observed': False,
              'relay_ingress_observed': False, 'gateway_retry_configuration_observed': not gateway_mode,
              'temporary_codex_session_history_retained': True, 'observer_raw_data_persisted': False,
              'gateway_logs_persisted': False, 'installed_client_modified': False,
              'request_max_retries': 0, 'stream_max_retries': 0, 'outbound_request_limit': 5,
              'remote_request_limit': None if gateway_mode else 5,
              'cache_fixture_requested': args.cache_fixture,
              'cache_fixture_utf8_bytes': len(cache_reference.encode('utf-8')),
              'cache_fixture_words': len(cache_reference.split()),
              'cache_fixture_reference_rows': CACHE_FIXTURE_ROWS if args.cache_fixture else 0,
              'phases': {}, 'pass': False, 'failure_code': None, 'failure_phase': None}
    state = None
    rpc = None
    child = None
    gateway_thread = None
    gateway_logs = None
    servers = []
    before = None
    try:
        codex = args.codex.resolve(strict=True)
        report['litellm_version'] = None if gateway_mode else importlib.metadata.version('litellm')
        version = subprocess.run([str(codex), '--version'], env=clean_env(output), stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, text=True, timeout=10)
        report['codex_version_pinned'] = version.returncode == 0 and version.stdout.strip() == 'codex-cli 0.160.0'
        if not report['codex_version_pinned'] or not gateway_mode and report['litellm_version'] != '1.103.1':
            raise HarnessFailure('runtime_version_mismatch')
        before = None if gateway_mode else identities()
        report['stock_guarded_source_count'] = None if gateway_mode else len(before)
        selected_key = os.environ.get(key_env)
        if not selected_key or not selected_key.isascii() or not all(33 <= ord(c) <= 126 for c in selected_key) or len(selected_key) > 4096:
            raise HarnessFailure('gateway_key_environment_missing_or_invalid' if gateway_mode else 'relay_key_environment_missing_or_invalid')
        if gateway_mode:
            state = State(selected_key, gateway_target=target)
        else:
            state = State('sk-local-live-' + secrets.token_hex(24), selected_key)
            remote, remote_thread = start_observer(state, 'remote')
            servers.append((remote, remote_thread))
            config = {'litellm_settings': {'telemetry': False, 'num_retries': 0, 'callbacks': [], 'request_timeout': HTTP_TIMEOUT},
                  'router_settings': {'num_retries': 0},
                  'general_settings': {'master_key': 'os.environ/LOCAL_GATEWAY_KEY', 'pass_through_endpoints': [{
                      'path': GATEWAY_PATH, 'target': 'http://127.0.0.1:' + str(remote.server_port) + REMOTE_PATH,
                      'auth': True, 'methods': ['POST'], 'forward_headers': True,
                      'headers': {'Authorization': 'os.environ/LOCAL_RELAY_AUTHORIZATION', 'x-api-key': ''}}]}}
            config_path = output / 'gateway.yaml'
            config_path.write_text(yaml.safe_dump(config), encoding='utf-8')
            env = clean_env(output)
            env.update(CONFIG_FILE_PATH=str(config_path), LOCAL_GATEWAY_KEY=state.gateway_key,
                       LOCAL_RELAY_AUTHORIZATION='Bearer ' + selected_key, LITELLM_LOCAL_MODEL_COST_MAP='True')
            child, gateway_thread, gateway_logs, port = start(
                [sys.executable, str(ROOT / 'integration/litellm/boot_gateway.py')], env, output,
                lambda line: int(line.strip().split('=')[1]) if line.startswith('LOCAL_GATEWAY_PORT=') else None, 45)
            report['local_litellm_started'] = True
            env.clear()
            deadline = time.monotonic() + 30
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            while True:
                try:
                    opener.open('http://127.0.0.1:' + str(port) + '/health/liveliness', timeout=.5).close()
                    break
                except Exception:
                    if time.monotonic() > deadline:
                        raise HarnessFailure('gateway_startup_timeout')
                    time.sleep(.2)
        observer, observer_thread = start_observer(state, 'client')
        if not gateway_mode:
            observer.target_port = port
        servers.append((observer, observer_thread))
        # A bounded client test profile, NOT official Claude capability metadata.
        catalog = {'models': [{'slug': MODEL, 'display_name': 'Live Haiku limited test profile (NOT official Claude metadata)',
            'supported_reasoning_levels': [], 'shell_type': 'disabled', 'visibility': 'list', 'supported_in_api': True, 'priority': 0,
            'support_verbosity': False, 'apply_patch_tool_type': None, 'truncation_policy': {'mode': 'bytes', 'limit': 100000},
            'experimental_supported_tools': [], 'base_instructions': 'Protocol smoke test. Use only the no-I/O get_goal tool when requested. Do not create or update goals. Never access files, commands, network, search, agents or external tools. Follow requested final response markers.' + cache_reference,
            'supports_reasoning_summary_parameter': False, 'input_modalities': ['text']}]}
        catalog_path = output / 'model-catalog.json'
        catalog_path.write_text(json.dumps(catalog, indent=2), encoding='utf-8')
        client_env = clean_env(output)
        client_env.update(CODEX_HOME=str(home), CODEX_LIVE_GATEWAY_KEY=state.gateway_key, RUST_LOG='off')
        overrides = {'model_provider': 'live_relay', 'model': MODEL, 'model_catalog_json': str(catalog_path),
            'sandbox_mode': 'read-only', 'approval_policy': 'never', 'web_search': 'disabled',
            'analytics.enabled': False, 'feedback.enabled': False, 'check_for_update_on_startup': False,
            'otel.exporter': 'none', 'otel.trace_exporter': 'none', 'agents.enabled': False, 'cli_auth_credentials_store': 'file',
            'model_providers.live_relay.name': 'Existing gateway live smoke' if gateway_mode else 'Temporary stock LiteLLM to .64 live relay',
            'model_providers.live_relay.base_url': 'http://127.0.0.1:' + str(observer.server_port) + state.client_path.removesuffix('/responses'),
            'model_providers.live_relay.wire_api': 'responses', 'model_providers.live_relay.env_key': 'CODEX_LIVE_GATEWAY_KEY',
            'model_providers.live_relay.requires_openai_auth': False, 'model_providers.live_relay.supports_websockets': False,
            'model_providers.live_relay.request_max_retries': 0, 'model_providers.live_relay.stream_max_retries': 0,
            'model_providers.live_relay.stream_idle_timeout_ms': HTTP_TIMEOUT * 1000}
        command = [str(codex), 'app-server', '--stdio']
        for name, value in overrides.items():
            command += ['-c', name + '=' + json.dumps(value)]
        command += ['-c', 'model_providers.live_relay.http_headers={"x-claude-proxy-native-options"=' + json.dumps(NATIVE_OPTIONS) + '}']
        rpc = Rpc(command, client_env, workspace)
        rpc.request(0, 'initialize', {'clientInfo': {'name': 'codex_live_smoke', 'title': 'Bounded live relay smoke', 'version': '1.0'},
                                     'capabilities': {'experimentalApi': True}})
        rpc.send({'method': 'initialized', 'params': {}})
        thread = rpc.request(1, 'thread/start', {'model': MODEL, 'modelProvider': 'live_relay', 'cwd': str(workspace),
                                               'approvalPolicy': 'never', 'sandbox': 'read-only', 'ephemeral': False})
        thread_id = thread['thread']['id']
        for request_id, phase in enumerate(PHASE_LIMITS, start=2):
            state.phase = phase
            if phase == 'compact':
                rpc.request(request_id, 'thread/compact/start', {'threadId': thread_id})
            else:
                prompt = ('Call the built-in no-I/O get_goal tool exactly once with {}. After its result, do not call further tools. '
                          if phase == 'initial' else 'Continue this same conversation without using any tools. ')
                prompt += 'Never access files, commands, network, search or agents. Reply with exactly ' + MARKERS[phase] + '.'
                rpc.request(request_id, 'turn/start', {'threadId': thread_id, 'input': [{'type': 'text', 'text': prompt}]})
            terminal = rpc.wait(lambda value: value.get('method') == 'turn/completed'
                                and value.get('params', {}).get('threadId') == thread_id, TURN_TIMEOUT)
            check_phase(state, report, phase, terminal, rpc)
        report['pass'] = True
    except Exception as error:
        report['failure_code'] = str(error) if isinstance(error, HarnessFailure) else 'runtime_or_protocol_failed'
        report['failure_phase'] = state.phase if state else 'setup'
    finally:
        if rpc is not None:
            try:
                rpc.close()
            except Exception:
                report['pass'] = False
                report['cleanup_failed'] = True
        if child is not None:
            try:
                stop(child)
                gateway_thread.join(3)
                child.stdout.close()
            except Exception:
                report['pass'] = False
                report['cleanup_failed'] = True
        for server, server_thread in reversed(servers):
            server.shutdown()
            server.server_close()
            server_thread.join(3)
        if gateway_logs is not None:
            gateway_logs.clear()
        if gateway_mode:
            report['stock_guarded_sources_unchanged'] = None
        else:
            try:
                report['stock_guarded_sources_unchanged'] = before is not None and identities() == before
            except Exception:
                report['stock_guarded_sources_unchanged'] = False
        report['workspace_file_count'] = sum(1 for path in workspace.rglob('*') if path.is_file())
        report['remote_request_attempts'] = None if gateway_mode else state.remote_attempts if state else 0
        report['gateway_request_attempts'] = state.gateway_attempts if state and gateway_mode else None
        report['direct_relay_request_attempts'] = state.remote_attempts if state else 0
        report['actual_dot7_gateway_tested'] = bool(state and state.gateway_attempts and target == ('http', '192.168.0.7', 4000, '/claude-responses/v1/responses'))
        report['observer_failure_code'] = state.failure if state else None
        report['client_request_count'] = len(state.records['client']) if state else 0
        report['remote_request_count'] = None if gateway_mode else len(state.records['remote']) if state else 0
        report['relay_ingress_observed'] = bool(state and not gateway_mode and state.records['remote'])
        # Keep partial failure evidence, but never persist raw records, errors,
        # SDK notifications, opaque capsules or captured child output.
        if state:
            for phase in PHASE_LIMITS:
                if phase not in report['phases'] and phase_records(state, 'client', phase):
                    evidence = phase_evidence(state, phase)
                    evidence.update(terminal_status='unobserved', **{'pass': False})
                    report['phases'][phase] = evidence
        report['observed_no_retries'] = (report['gateway_request_attempts'] == report['client_request_count'] == 5 if gateway_mode else
            report['remote_request_attempts'] == report['client_request_count'] == report['remote_request_count'] == 5) and all(
            report['phases'].get(phase, {}).get('expected_request_count') for phase in PHASE_LIMITS)
        report['no_hidden_retries'] = None if gateway_mode else report['observed_no_retries']
        report['local_compaction_pass'] = report['phases'].get('compact', {}).get('pass', False)
        report['post_compaction_followups_pass'] = all(report['phases'].get(phase, {}).get('pass', False) for phase in ('followup', 'followup_second'))
        report['pass'] = report['pass'] and report['observed_no_retries'] and (gateway_mode or report['stock_guarded_sources_unchanged']) and report['workspace_file_count'] == 0
        report['functional_pass'] = report['pass']
        reasoning_checks = [phase.get(name) for phase in report['phases'].values() for name in (
            'reasoning_done_completed_exact', 'initial_reasoning_replay_exact',
            'initial_reasoning_compaction_replay_exact', 'post_compaction_reasoning_replay_exact')
            if phase.get(name) is not None]
        report['reasoning_check_count'] = len(reasoning_checks)
        report['observed_reasoning_preserved'] = all(reasoning_checks) if reasoning_checks else None
        report['post_compaction_reasoning_replay_observed'] = report['phases'].get('followup_second', {}).get('post_compaction_reasoning_replay_exact') is not None
        report.update(cache_observations([request.get('usage') for phase in report['phases'].values() for request in phase.get('requests', [])]))
        report_path = output / 'codex-live-smoke.json'
        report_path.write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps(report, indent=2))
    print('Report:', report_path)
    return 0 if report['pass'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
