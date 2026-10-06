"""Actual OpenCode Responses client: local fake-native qualification or opt-in live.

Offline: unmodified OpenCode -> actual built Responses proxy -> fake native SSE.
Live: unmodified OpenCode -> unchanged byte observer -> existing .7 route.
No client prompt/identity substitution, request repair, installation or fallback.
Only sanitized evidence is written; ordinary isolated OpenCode history is private.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import queue
import re
import secrets
import subprocess
import tempfile
import threading
from urllib.parse import urlsplit

import opencode_live_smoke as native

ROOT, MODEL, VERSION = native.ROOT, native.MODEL, native.VERSION
Failure, require = native.Failure, native.require
CLIENT_PATH = '/claude-responses/v1/responses'
REQUEST_LIMIT = 4
WIRE_LIMIT = native.WIRE_LIMIT
# Inventory only: unknown names are reported, never removed or repaired.
KNOWN_FIELDS = frozenset({'model', 'input', 'instructions', 'stream', 'store', 'tools', 'tool_choice',
    'parallel_tool_calls', 'reasoning', 'include', 'max_output_tokens', 'temperature', 'top_p',
    'text', 'previous_response_id', 'truncation', 'metadata', 'client_metadata', 'prompt_cache_key',
    'service_tier', 'background', 'user', 'safety_identifier'})
SAFE_FAILURE_CODES = frozenset({'invalid_upstream_event', 'unsupported_upstream_event',
    'unsupported_upstream_block', 'unsupported_upstream_delta', 'malformed_tool_input',
    'invalid_tool_grammar', 'unknown_upstream_tool', 'invalid_upstream_usage',
    'invalid_upstream_metadata', 'provider_refusal', 'incomplete_upstream_stream',
    'upstream_limit_exceeded', 'reasoning_state_error', 'upstream_timeout', 'cancelled', 'upstream_error'})
SAFE_HTTP_CODES = frozenset({'invalid_request', 'unsupported_parameter', 'invalid_reasoning_state',
    'invalid_tool_history', 'invalid_model', 'model_not_allowed', 'invalid_native_options',
    'responses_disabled', 'upstream_not_configured', 'adapter_configuration_error', 'request_too_large'})


def gateway_target(base):
    parsed = urlsplit(base)
    require(parsed.scheme == 'http' and parsed.hostname == '192.168.0.7' and parsed.port == 4000
            and not parsed.username and not parsed.password and not parsed.query and not parsed.fragment,
            'unexpected_gateway_origin')
    require(parsed.path.rstrip('/') in ('/claude-responses', '/claude-responses/v1'), 'unexpected_gateway_base_path')
    return parsed.hostname, parsed.port, CLIENT_PATH


def isolated_env(folder, binary, fixture, origin, key):
    env = native.isolated_env(folder, binary, fixture, origin, key)
    config = json.loads(env['OPENCODE_CONFIG_CONTENT'])
    # The built-in openai provider loader explicitly selects sdk.responses().
    # Do not use openai-compatible, which selects Chat Completions instead.
    config.update(model='openai/' + MODEL, small_model='openai/' + MODEL, enabled_providers=['openai'])
    config['provider'] = {'openai': {
        'options': {'apiKey': '{env:OPENCODE_LIVE_GATEWAY_TOKEN}', 'baseURL': origin + '/claude-responses/v1'},
        'models': {MODEL: {'name': 'Claude Haiku Responses comparison', 'reasoning': True,
            'tool_call': True, 'limit': {'context': 200000, 'output': 8192},
            'options': {'store': False, 'include': ['reasoning.encrypted_content']}}}}}
    env['OPENCODE_CONFIG_CONTENT'] = json.dumps(config)
    return env


def sse_events(wire):
    result = []
    for frame in wire.decode('utf-8').replace('\r\n', '\n').split('\n\n'):
        data = '\n'.join(line[5:].lstrip(' ') for line in frame.split('\n') if line.startswith('data:'))
        if data and data != '[DONE]':
            value = json.loads(data)
            require(isinstance(value, dict), 'responses_sse_invalid')
            result.append(value)
    return result


def parse_response(wire):
    try:
        events = sse_events(wire)
        errors = [e for e in events if e.get('type') in ('error', 'response.failed')]
        require(not errors, 'responses_sse_error')
        completed = [e.get('response') for e in events if e.get('type') == 'response.completed']
        require(len(completed) == 1 and isinstance(completed[0], dict), 'responses_sse_incomplete')
        require(completed[0].get('status') == 'completed' and isinstance(completed[0].get('output'), list),
                'responses_sse_incomplete')
        done = [e.get('item') for e in events if e.get('type') == 'response.output_item.done']
        return completed[0], done
    except Failure:
        raise
    except (ValueError, KeyError, TypeError, AttributeError, UnicodeError):
        raise Failure('responses_sse_invalid') from None


def error_diagnostics(wire):
    # HTTP errors may be a native provider body or the proxy's preserved nested
    # upstream error. Classify only documented shapes, never export free prose.
    direct = native.error_diagnostics(wire)
    try:
        body = json.loads(wire)
        error = body.get('error', {})
        direct['adapter_error_code'] = error.get('code') if error.get('code') in SAFE_HTTP_CODES else None
        for value in (error.get('upstream_error'), error.get('details'), body.get('upstream_error')):
            if isinstance(value, dict) and isinstance(value.get('error'), dict):
                found = native.error_diagnostics(json.dumps(value).encode())
                if found['reason'] not in ('unclassified_provider_error', 'non_json_or_unknown_error_shape'):
                    return found
    except (ValueError, TypeError, AttributeError):
        pass
    return direct


def capsules(items):
    return [(item.get('id'), item.get('encrypted_content')) for item in items
            if isinstance(item, dict) and item.get('type') == 'reasoning']


def function_identity(items, parsed=False):
    try:
        return [(i.get('call_id'), i.get('name'), json.loads(i.get('arguments', 'null')) if parsed else i.get('arguments'))
                for i in items]
    except (ValueError, TypeError):
        return None


def usages(response):
    standard = response.get('usage') or {}
    result = {name: value for name in ('input_tokens', 'output_tokens', 'total_tokens')
              if isinstance(value := standard.get(name), int) and not isinstance(value, bool) and value >= 0}
    for source, output in (('input_tokens_details', 'input_tokens_details'), ('output_tokens_details', 'output_tokens_details')):
        details = standard.get(source) or {}
        result[output] = {name: value for name in ('cached_tokens', 'cache_write_tokens', 'reasoning_tokens')
                          if isinstance(value := details.get(name), int) and not isinstance(value, bool) and value >= 0}
    result['anthropic_usage'] = native.usage_counts(response.get('anthropic_usage') or {})
    return result


class State(native.State):
    def __init__(self, fixture, marker, key, offline, first_request_only=False):
        super().__init__(fixture, marker, key)
        self.offline = offline
        self.first_request_only = first_request_only
        self.native_records = []

    def reserve(self, body, raw, headers):
        with self.lock:
            try:
                require(self.failure is None, 'stopped_after_failure')
                require(not self.active, 'concurrent_model_attempt')
                require(len(self.records) < (1 if self.first_request_only else REQUEST_LIMIT), 'gateway_request_limit')
                ordinal = sum(r['phase'] == self.phase for r in self.records)
                require(ordinal < (3 if self.phase == 'read' else 1), 'phase_request_limit')
                require(body.get('model') == MODEL and body.get('stream') is True
                        and isinstance(body.get('input'), list), 'unexpected_model_or_protocol')
                require(body.get('store') is False, 'store_false_required')
                require([t.get('name') for t in body.get('tools', [])] == ['read'], 'unexpected_tool_set')
                require(all(t.get('type') == 'function' for t in body.get('tools', [])), 'unexpected_tool_type')
                require(headers.get('authorization') == 'Bearer ' + self.key, 'unexpected_gateway_key')
                require(not any(r['raw'] == raw for r in self.records), 'duplicate_request_attempt')
            except Failure:
                self.blocked_model_attempts += 1
                raise
            record = {'body': body, 'raw': raw, 'phase': self.phase, 'ordinal': ordinal,
                      'status': None, 'wire': b'', 'response': None, 'done': [], 'response_complete': False,
                      'beta_header_present': bool(headers.get('anthropic-beta')),
                      'opencode_user_agent_present': 'opencode/' in (headers.get('user-agent') or '').lower(),
                      'request_bytes_forwarded_unchanged': False, 'response_bytes_forwarded_unchanged': False}
            self.records.append(record)
            self.outgoing += int(not self.offline)  # Consume before connection, including uncertain outcomes.
            self.active = True
            return record


class QuietServer(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, *_):
        self.state.fail('observer_handler_failed')


class Observer(native.Observer):
    def do_POST(self):
        state = self.server.state
        connection = None; sent_headers = False; record = None; wire = bytearray()
        try:
            self.connection.settimeout(90)
            path = urlsplit(self.path)
            if path.scheme or path.path != CLIENT_PATH:
                self.incidental(); return
            size = int(self.headers.get('content-length', '0'))
            require(0 < size <= WIRE_LIMIT and not self.headers.get('transfer-encoding'), 'invalid_request_framing')
            raw = self.rfile.read(size)
            require(len(raw) == size, 'incomplete_client_request')
            body = json.loads(raw)
            require(isinstance(body, dict), 'invalid_client_json')
            record = state.reserve(body, raw, self.headers)
            headers = {key: value for key, value in self.headers.items()
                       if key.lower() not in {'host', 'connection', 'transfer-encoding', 'accept-encoding'}}
            headers['accept-encoding'] = 'identity'
            connection = http.client.HTTPConnection(self.server.target_host, self.server.target_port, timeout=90)
            with state.lock:
                state.active_connection = connection
            target = self.server.target_path + (('?' + path.query) if path.query else '')
            connection.request('POST', target, raw, headers)
            record['request_bytes_forwarded_unchanged'] = True
            response = connection.getresponse(); record['status'] = response.status
            if response.status != 200:
                state.fail('gateway_http_failure')
            self.send_response(response.status)
            for key, value in response.getheaders():
                if key.lower() not in {'connection', 'transfer-encoding', 'content-length', 'server', 'date'}:
                    self.send_header(key, value)
            self.send_header('Connection', 'close'); self.end_headers()
            sent_headers = True; self.close_connection = True
            while chunk := response.read1(8192):
                wire.extend(chunk); require(len(wire) <= WIRE_LIMIT, 'response_size_limit')
                self.wfile.write(chunk); self.wfile.flush()
            record['wire'] = bytes(wire)
            record['response_bytes_forwarded_unchanged'] = True
            if response.status == 200:
                record['response'], record['done'] = parse_response(record['wire'])
                record['response_complete'] = True
                if state.first_request_only:
                    # End this explicit acceptance probe before any tool-result
                    # or same-session model call. The original reply reached
                    # OpenCode unchanged; this is not a functional multi-turn pass.
                    state.fail('first_request_probe_complete')
            else:
                record['error_diagnostics'] = error_diagnostics(record['wire'])
        except Failure as error:
            state.fail(str(error))
            if not sent_headers:
                self.reject()
        except (ValueError, TypeError):
            state.fail('invalid_client_json')
            if not sent_headers:
                self.reject()
        except Exception:
            state.fail('observer_transport_failure')
            if not sent_headers:
                self.reject()
        finally:
            if connection:
                connection.close()
            if record is not None:
                record['wire'] = bytes(wire)
                with state.lock:
                    state.active = False
                    if state.active_connection is connection:
                        state.active_connection = None


def fake_native_events(state, ordinal):
    """Real proxy seals these synthetic blocks; no generated provider data."""
    if ordinal == 0:
        blocks = [
            {'type': 'thinking', 'thinking': 'Synthetic visible reasoning.', 'signature': 'synthetic-signature'},
            {'type': 'thinking', 'thinking': '', 'signature': 'synthetic-empty-signature'},
            {'type': 'redacted_thinking', 'data': 'synthetic-redacted'},
            {'type': 'tool_use', 'id': 'tool_synthetic_read', 'name': 'read', 'input': {'filePath': str(state.fixture)}},
        ]
    else:
        blocks = [{'type': 'text', 'text': ('FOLLOWUP_CONFIRMED: ' if state.phase == 'followup' else 'READ_CONFIRMED: ') + state.marker}]
    events = [{'type': 'message_start', 'message': {'id': 'msg_synthetic_' + str(ordinal),
        'type': 'message', 'role': 'assistant', 'model': MODEL, 'content': [], 'stop_reason': None,
        'stop_sequence': None, 'usage': {'input_tokens': 100, 'output_tokens': 0,
            'cache_creation_input_tokens': 20, 'cache_read_input_tokens': 30}}}]
    for index, block in enumerate(blocks):
        start = copy.deepcopy(block)
        if block['type'] == 'thinking':
            start.update(thinking=''); start.pop('signature')
        elif block['type'] == 'text':
            start['text'] = ''
        elif block['type'] == 'tool_use':
            start['input'] = {}
        events.append({'type': 'content_block_start', 'index': index, 'content_block': start})
        deltas = []
        if block['type'] == 'thinking':
            deltas.append({'type': 'thinking_delta', 'thinking': block['thinking']})
            deltas.append({'type': 'signature_delta', 'signature': block['signature']})
        elif block['type'] == 'text':
            deltas.append({'type': 'text_delta', 'text': block['text']})
        elif block['type'] == 'tool_use':
            deltas.append({'type': 'input_json_delta', 'partial_json': json.dumps(block['input'])})
        events.extend({'type': 'content_block_delta', 'index': index, 'delta': delta} for delta in deltas)
        events.append({'type': 'content_block_stop', 'index': index})
    events.extend([{'type': 'message_delta', 'delta': {'stop_reason': 'tool_use' if ordinal == 0 else 'end_turn',
                    'stop_sequence': None}, 'usage': {'output_tokens': 20}}, {'type': 'message_stop'}])
    wire = ''.join('event: ' + e['type'] + '\ndata: ' + json.dumps(e) + '\n\n' for e in events).encode()
    return wire, blocks


class FakeNative(native.Observer):
    def do_POST(self):
        state = self.server.state
        try:
            require(urlsplit(self.path).path == '/v1/messages', 'offline_native_path_mismatch')
            size = int(self.headers.get('content-length', '0'))
            require(0 < size <= WIRE_LIMIT, 'offline_native_request_size')
            body = json.loads(self.rfile.read(size))
            require(body.get('model') == MODEL and body.get('stream') is True, 'offline_native_shape_mismatch')
            with state.lock:
                ordinal = len(state.native_records)
                require(ordinal < REQUEST_LIMIT, 'offline_native_limit')
                wire, blocks = fake_native_events(state, ordinal)
                state.native_records.append({'body': body, 'blocks': blocks})
            self.send_response(200); self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Content-Length', str(len(wire))); self.end_headers()
            self.wfile.write(wire); self.wfile.flush()
        except Exception:
            state.fail('offline_native_fixture_failed'); self.reject()


def start_server(state, handler):
    server = QuietServer(('127.0.0.1', 0), handler); server.state = state
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    return server, thread


def start_local_proxy(node, fake_port):
    binary = node.resolve(strict=True)
    child = subprocess.Popen([str(binary), str(ROOT / 'integration/clients/boot_responses_relay.mjs'),
        'http://127.0.0.1:' + str(fake_port) + '/', 'hoist'], cwd=ROOT,
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        creationflags=native.CREATIONFLAGS)
    result = queue.Queue()
    def first_line():
        result.put(child.stdout.readline(WIRE_LIMIT))
    reader = threading.Thread(target=first_line, daemon=True); reader.start()
    try:
        line = result.get(timeout=30)
        value = json.loads(line)
        require(isinstance(value.get('local_relay_port'), int)
                and isinstance(value.get('local_relay_key'), str), 'offline_proxy_start_failed')
        return child, value['local_relay_port'], value['local_relay_key']
    except Exception:
        native.stop(child); child.stdout.close(); child.stderr.close()
        raise Failure('offline_proxy_start_failed') from None


def read_phase_complete(state, records):
    if not records or not all(r['status'] == 200 and r['response_complete'] for r in records):
        return False
    calls = [item for r in records for item in (r['response'] or {}).get('output', []) if item.get('type') == 'function_call']
    if not calls or any(item.get('name') != 'read' for item in calls):
        return False
    try:
        for call in calls:
            value = json.loads(call.get('arguments', 'null'))['filePath']
            path = Path(value); path = path if path.is_absolute() else state.fixture.parent / path
            if path.resolve() != state.fixture:
                return False
        results = [i for i in records[-1]['body']['input'] if i.get('type') == 'function_call_output']
        return ([r.get('call_id') for r in results] == [c.get('call_id') for c in calls]
                and all(state.marker in json.dumps(r.get('output')) for r in results)
                and not any(i.get('type') == 'function_call' for i in records[-1]['response']['output']))
    except (ValueError, KeyError, TypeError):
        return False


def observations(state):
    responses = []; replays = []
    for index, record in enumerate(state.records):
        response = record['response'] or {}; body = record['body']; output = response.get('output', [])
        issued = capsules(output); done = capsules(record['done'])
        errors = []
        try:
            for event in sse_events(record['wire']):
                if event.get('type') in ('error', 'response.failed'):
                    error = (event.get('response') or event).get('error') or event
                    code = error.get('code')
                    errors.append(code if code in SAFE_FAILURE_CODES else 'unrecognized_sse_failure')
        except Exception:
            pass
        responses.append({'phase': record['phase'], 'http_status': record['status'],
            'complete': record['response_complete'], 'usage': usages(response),
            'error_diagnostics': record.get('error_diagnostics'), 'sse_failure_codes': errors,
            'request_fields': sorted(body), 'unknown_inventory_fields': sorted(set(body) - KNOWN_FIELDS),
            'input_item_types': [i.get('type', 'message') for i in body['input']],
            'input_message_roles': [i.get('role') for i in body['input'] if 'role' in i],
            'store_false': body.get('store') is False, 'previous_response_id_present': bool(body.get('previous_response_id')),
            'encrypted_content_requested': 'reasoning.encrypted_content' in (body.get('include') or []),
            'instructions_present': bool(body.get('instructions')),
            'system_message_present': any(i.get('role') == 'system' for i in body['input']),
            'opencode_user_agent_present': record['opencode_user_agent_present'],
            'beta_header_present': record['beta_header_present'],
            'observer_request_bytes_unchanged': record['request_bytes_forwarded_unchanged'],
            'observer_response_bytes_unchanged': record['response_bytes_forwarded_unchanged'],
            'reasoning_count': len(issued), 'opaque_done_completed_exact': done == issued if issued else None,
            'encrypted_content_present': all(bool(item_id) and bool(blob) for item_id, blob in issued) if issued else None,
            'function_call_count': sum(i.get('type') == 'function_call' for i in output)})
        if index:
            prior = [i for r in state.records[:index] for i in (r['response'] or {}).get('output', [])]
            expected = capsules(prior); actual = capsules(body['input'])
            tools = [i for i in prior if i.get('type') == 'function_call']
            replayed = [i for i in body['input'] if i.get('type') == 'function_call']
            results = [i for i in body['input'] if i.get('type') == 'function_call_output']
            # SDKs may omit status/id metadata; compare executable tool identity and arguments separately.
            replays.append({'phase': record['phase'], 'issued_reasoning_count': len(expected),
                'opaque_reasoning_exact': actual == expected if expected else None,
                'reasoning_item_fields': [sorted(i) for i in body['input'] if i.get('type') == 'reasoning'],
                'reasoning_ids_exact': [i[0] for i in actual] == [i[0] for i in expected] if expected else None,
                'reasoning_ciphertexts_exact': [i[1] for i in actual] == [i[1] for i in expected] if expected else None,
                'reasoning_id_present': [bool(i[0]) for i in actual],
                'reasoning_ciphertext_present': [bool(i[1]) for i in actual],
                'function_calls_exact': function_identity(replayed) == function_identity(tools) if tools else None,
                'function_calls_json_equal': function_identity(replayed, True) == function_identity(tools, True) if tools else None,
                'tool_result_ids_match_issued_order': [i.get('call_id') for i in results] == [i.get('call_id') for i in tools] if tools else None,
                'fixture_read_result_present': any(state.marker in json.dumps(i.get('output')) for i in results)})
    native_checks = []
    for index, record in enumerate(state.native_records):
        if index:
            expected = [b for r in state.native_records[:index] for b in r['blocks']]
            actual = native.history(record['body'], 'assistant')
            wanted = [b for b in expected if b.get('type') in native.STATE_TYPES]
            found = [b for b in actual if b.get('type') in native.STATE_TYPES]
            native_checks.append({'ordered_native_state_exact': wanted == found,
                'thinking_blocks': sum(b.get('type') == 'thinking' for b in wanted),
                'signed_empty_blocks': sum(b.get('type') == 'thinking' and b.get('thinking') == '' for b in wanted),
                'redacted_blocks': sum(b.get('type') == 'redacted_thinking' for b in wanted)})
    checks = [r['opaque_reasoning_exact'] for r in replays if r['opaque_reasoning_exact'] is not None]
    return {'client_edge_requests': len(state.records), 'outgoing_gateway_attempts': state.outgoing,
        'blocked_model_attempts': state.blocked_model_attempts, 'blocked_incidental_requests': state.blocked_incidental,
        'responses': responses, 'replays': replays, 'observed_opaque_state_pass': all(checks) if checks else None,
        'offline_native_requests': len(state.native_records) if state.offline else None,
        'offline_native_replay': native_checks if state.offline else None,
        'offline_native_replay_pass': all(r['ordered_native_state_exact'] for r in native_checks) if native_checks else None,
        'deployed_gateway_to_relay_body_fidelity': None, 'downstream_provider_call_count': None,
        'downstream_retry_count': None, 'gateway_usage_cost_accounting_exact': None}


def first_request_evidence(state, first):
    probe = state.records[0] if len(state.records) == 1 else None
    accepted = bool(probe and probe['status'] == 200 and probe['response_complete'])
    return {'functional_pass': False,
        'first_request_probe_complete': bool(probe and probe['status'] is not None
            and probe['response_bytes_forwarded_unchanged']),
        'first_request_accepted': accepted,
        'expected_probe_stop': state.failure == 'first_request_probe_complete',
        'multi_turn_tested': False,
        'harness_error': None if accepted else state.failure or 'first_request_not_accepted',
        'phases': [{'phase': 'first_request_probe', **{name: first[name] for name in
            ('exit_code', 'timed_out', 'overflow', 'stopped_on_observer_failure')}}]}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--offline', action='store_true'); mode.add_argument('--live', action='store_true')
    parser.add_argument('--opencode', type=Path, required=True)
    parser.add_argument('--node', type=Path, help='Existing Node executable for built local proxy; offline only')
    parser.add_argument('--gateway-base-url'); parser.add_argument('--gateway-key-env')
    parser.add_argument('--first-request-only', action='store_true',
                        help='Live acceptance probe only: max one request, no round-trip pass claim')
    parser.add_argument('--output', type=Path, required=True, help='New system-temp directory; sanitized report only')
    args = parser.parse_args(argv)
    if args.offline and (not args.node or args.gateway_base_url or args.gateway_key_env):
        parser.error('--offline requires --node and forbids gateway arguments')
    if args.live and (args.node or not args.gateway_base_url or not args.gateway_key_env):
        parser.error('--live requires both gateway arguments and forbids --node')
    if args.first_request_only and not args.live:
        parser.error('--first-request-only is available only with --live')
    state = None; child = None; servers = []; output = args.output.resolve()
    report = {'functional_pass': False, 'phases': [], 'harness_error': None}
    try:
        require(not output.exists() and Path(tempfile.gettempdir()).resolve() in output.parents
                and ROOT not in output.parents, 'output_must_be_new_system_temp_child')
        binary = args.opencode.resolve(strict=True)
        with binary.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        require(digest == native.BINARY_SHA256, 'opencode_binary_identity_mismatch')
        key = 'offline-only-' + secrets.token_hex(24)
        if args.live:
            host, port, target = gateway_target(args.gateway_base_url)
            require(re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', args.gateway_key_env) is not None, 'invalid_key_environment_name')
            key = os.environ.get(args.gateway_key_env, '')
            require(bool(key) and '\r' not in key and '\n' not in key, 'test_gateway_key_missing')
        output.mkdir(parents=True)
        runtime = Path(tempfile.mkdtemp(prefix='opencode-responses-runtime-')).resolve()
        workspace = runtime / 'fixture'; workspace.mkdir()
        fixture = workspace / 'fixture.txt'; marker = 'OPENCODE_LIVE_' + secrets.token_hex(16)
        fixture.write_bytes((marker + '\n').encode())
        state = State(fixture, marker, key, args.offline, args.first_request_only)
        if args.offline:
            fake, thread = start_server(state, FakeNative); servers.append((fake, thread))
            child, port, key = start_local_proxy(args.node, fake.server_port)
            state.key = key; host, target = '127.0.0.1', '/v1/responses'
        server, thread = start_server(state, Observer); servers.append((server, thread))
        server.target_host, server.target_port, server.target_path = host, port, target
        env = isolated_env(runtime, binary, fixture, 'http://127.0.0.1:' + str(server.server_port), key)
        report.update(mode='offline' if args.offline else 'live', opencode_version=VERSION, opencode_sha256=digest,
            model=MODEL, provider='bundled @ai-sdk/openai Responses',
            gateway_endpoint=None if args.offline else 'http://192.168.0.7:4000' + target,
            local_proxy_started=args.offline, local_gateway_started=False, direct_deployed_relay_calls=False,
            maximum_gateway_attempts=0 if args.offline else 1 if args.first_request_only else REQUEST_LIMIT,
            maximum_client_attempts=1 if args.first_request_only else REQUEST_LIMIT,
            first_request_only=args.first_request_only,
            retained_runtime_directory=str(runtime), client_source_modified=False, client_system_prompt_replaced=False,
            client_user_agent_replaced=False, paid_fallback=False, observer_body_repair=False,
            not_tested=['deployed downstream wire fidelity/retries', 'gateway accounting/model ACL',
                'real signed-empty/redacted if not emitted', 'compaction/cancellation/model switch',
                'OS-enforced filesystem/network sandbox'])
        version = native.run_client([str(binary), '--version'], env, workspace, state, timeout=20)
        require(version['exit_code'] == 0 and version['stdout'].decode().strip() == VERSION, 'opencode_version_mismatch')
        base = [str(binary), 'run', '--format', 'json', '--model', 'openai/' + MODEL,
                '--log-level', 'ERROR', '--title', 'Bounded Responses gateway read smoke']
        first = native.run_client(base + ['Use only the read tool to read fixture.txt once. Do not use any other tool or network. '
            'Then answer READ_CONFIRMED: followed by the exact first line from the file, and finish.'], env, workspace, state)
        if args.first_request_only:
            # Do not misinterpret deliberately terminated client output as a
            # completed Read/answer session; record only transport/process facts.
            report.update(first_request_evidence(state, first))
        else:
            finish_multi_turn(state, report, first, marker, binary, base, env, workspace, fixture)
    except Failure as error:
        report['harness_error'] = str(error)
    except Exception:
        report['harness_error'] = 'harness_runtime_failure'
    finally:
        if state:
            state.close_active()
        for server, thread in reversed(servers):
            server.shutdown(); server.server_close(); thread.join(3)
        if child:
            native.stop(child); child.stdout.close(); child.stderr.close()
        if state:
            report['observer_failure'] = None if state.failure == 'first_request_probe_complete' else state.failure
            report.update(observations(state))
        if output.is_dir() and state is not None:
            (output / 'opencode-responses-live-smoke.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps({'functional_pass': report['functional_pass'], 'harness_error': report['harness_error'],
        'first_request_accepted': report.get('first_request_accepted'),
        'gateway_attempts': report.get('outgoing_gateway_attempts', 0), 'client_requests': report.get('client_edge_requests', 0),
        'report_written': output.is_dir() and state is not None}))
    return 0 if (report.get('first_request_accepted') if args.first_request_only else report['functional_pass']) else 1


def finish_multi_turn(state, report, first, marker, binary, base, env, workspace, fixture):
    """Shared offline/live full scenario; never called by single-request probe."""
    summary, session = native.client_events(first, marker)
    summary.update(phase='read', actual_read_roundtrip=read_phase_complete(state, state.records))
    report['phases'].append(summary)
    require(state.failure is None, state.failure or 'observer_failure')
    require(summary['functional_pass'] and summary['actual_read_roundtrip'], 'read_phase_incomplete')
    require(isinstance(session, str) and re.fullmatch(r'ses_[A-Za-z0-9]+', session), 'session_id_not_observed')
    before = len(state.records); state.phase = 'followup'
    second = native.run_client(base + ['--session', session,
        'Without using any tool or re-reading the file, answer FOLLOWUP_CONFIRMED: followed by the exact first line you read in this session. Then finish.'],
        env, workspace, state)
    summary, resumed = native.client_events(second, marker); following = state.records[before:]
    summary.update(phase='followup', same_session_resumed=resumed == session,
        one_complete_followup_request=len(following) == 1 and following[0]['response_complete']
            and not any(i.get('type') == 'function_call' for i in following[0]['response']['output']))
    report['phases'].append(summary)
    require(state.failure is None, state.failure or 'observer_failure')
    require(summary['functional_pass'] and summary['same_session_resumed']
            and summary['one_complete_followup_request'], 'followup_phase_incomplete')
    report['fixture_unchanged'] = (fixture.read_bytes() == (marker + '\n').encode()
                                  and sorted(p.name for p in workspace.iterdir()) == ['fixture.txt'])
    require(report['fixture_unchanged'], 'fixture_modified')
    report['functional_pass'] = True


if __name__ == '__main__':
    raise SystemExit(main())
