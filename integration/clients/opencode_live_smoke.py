"""Explicit live OpenCode -> existing .7 LiteLLM -> .64 native Messages smoke.

No live call without --live, no installation, and no local LiteLLM or relay.
One loopback observer forwards original request/response body bytes. Raw model
data and subprocess output stay in memory; only a sanitized report is written.
OpenCode retains its ordinary generated session in a separate temporary runtime.
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
import re
import secrets
import socket
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]
MODEL = 'claude-haiku-4-5-20251001'
VERSION = '1.18.34'
BINARY_SHA256 = '184f196ec97c843a64b2e1a2b49165f25e73a5d6993e2f842c9958c2b1f7a5b2'
CLIENT_PATH = '/claude-native/v1/messages'
REQUEST_LIMIT = 4
WIRE_LIMIT = 8 * 1024 * 1024
CREATIONFLAGS = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
USAGE_FIELDS = ('input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens')
STATE_TYPES = {'thinking', 'redacted_thinking', 'tool_use'}


class Failure(Exception):
    """Fixed harness-authored error codes only; never a provider error string."""


def require(condition, code):
    if not condition:
        raise Failure(code)


def gateway_target(base):
    parsed = urlsplit(base)
    require(parsed.scheme == 'http' and parsed.hostname == '192.168.0.7'
            and parsed.port == 4000 and not parsed.username and not parsed.password
            and not parsed.query and not parsed.fragment, 'unexpected_gateway_origin')
    require(parsed.path.rstrip('/') in ('/claude-native', '/claude-native/v1'), 'unexpected_gateway_base_path')
    return parsed.hostname, parsed.port, CLIENT_PATH


def content_blocks(message):
    content = message.get('content', [])
    return [b for b in content if isinstance(b, dict)] if isinstance(content, list) else [{'type': 'text', 'text': content}]


def history(body, role):
    return [block for message in body.get('messages', []) if message.get('role') == role
            for block in content_blocks(message)]


def without_cache(blocks):
    return [{k: v for k, v in block.items() if k != 'cache_control'} for block in blocks]


def usage_counts(usage):
    result = {name: usage[name] for name in USAGE_FIELDS
              if isinstance(usage.get(name), int) and not isinstance(usage[name], bool) and usage[name] >= 0}
    creation = usage.get('cache_creation')
    if isinstance(creation, dict):
        result['cache_creation'] = {name: creation[name] for name in ('ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens')
                                    if isinstance(creation.get(name), int) and not isinstance(creation[name], bool)
                                    and creation[name] >= 0}
    return result


def parse_sse(wire):
    """Preserve every signature delta and ignore nullable usage updates."""
    try:
        events = []
        for frame in wire.decode('utf-8').replace('\r\n', '\n').split('\n\n'):
            data = '\n'.join(line[5:].lstrip(' ') for line in frame.split('\n') if line.startswith('data:'))
            if data and data != '[DONE]':
                events.append(json.loads(data))
        starts = [e for e in events if e.get('type') == 'message_start']
        require(len(starts) == 1 and any(e.get('type') == 'message_stop' for e in events), 'native_sse_incomplete')
        require(not any(e.get('type') == 'error' for e in events), 'native_sse_error')
        message = copy.deepcopy(starts[0]['message'])
        blocks = {}; inputs = {}; signatures = {}; usage = dict(message.get('usage', {}))
        reason = message.get('stop_reason')
        for event in events:
            kind = event.get('type')
            if kind == 'content_block_start':
                blocks[event['index']] = copy.deepcopy(event['content_block'])
            elif kind == 'content_block_delta':
                index = event['index']; delta = event['delta']; block = blocks[index]
                field = {'text_delta': 'text', 'thinking_delta': 'thinking', 'signature_delta': 'signature'}.get(delta.get('type'))
                if field:
                    block[field] = block.get(field, '') + delta[field]
                    if field == 'signature':
                        signatures[index] = signatures.get(index, 0) + 1
                elif delta.get('type') == 'input_json_delta':
                    inputs[index] = inputs.get(index, '') + delta['partial_json']
                else:
                    raise Failure('unsupported_native_delta')
            elif kind == 'message_delta':
                reason = event.get('delta', {}).get('stop_reason') or reason
                usage.update({k: v for k, v in event.get('usage', {}).items() if v is not None})
        for index, value in inputs.items():
            # An empty partial_json event is a no-op, not malformed JSON.
            # Preserve the initial input (normally {}); nonempty invalid JSON
            # still fails instead of silently replacing the model's tool args.
            if value:
                blocks[index]['input'] = json.loads(value)
        message.update(content=[blocks[i] for i in sorted(blocks)], stop_reason=reason, usage=usage)
        return message, list(signatures.values())
    except Failure:
        raise
    except (ValueError, KeyError, TypeError, AttributeError, UnicodeError):
        raise Failure('native_sse_invalid') from None


def error_diagnostics(wire):
    """Classify an error in memory; export neither its prose nor its payload."""
    try:
        payload = json.loads(wire)
        error = payload.get('error', {})
        if not isinstance(error, dict):
            return {'error_type': None, 'reason': 'unclassified_provider_error'}
        message = error.get('message', '')
        message = message if isinstance(message, str) else ''
        error_type = error.get('type')
        if error_type not in {'invalid_request_error', 'authentication_error', 'permission_error',
                              'not_found_error', 'request_too_large', 'rate_limit_error', 'api_error', 'overloaded_error'}:
            error_type = None
        # A provider's refusal text is evidence of this request's disposition,
        # not permission to turn on paid usage or impersonate another client.
        if (re.search(r'third[ -]party', message, re.IGNORECASE)
                and re.search(r'\bclaude\b', message, re.IGNORECASE)
                and re.search(r'\bplan\b', message, re.IGNORECASE)
                and re.search(r'extra usage', message, re.IGNORECASE)
                and re.search(r'\b(billed|charged|draw\w*)\b', message, re.IGNORECASE)):
            reason = 'third_party_plan_usage_restriction'
        elif re.search(r'OAuth authentication is currently not supported', message, re.IGNORECASE):
            reason = 'oauth_authentication_not_supported'
        elif re.search(r'credential is only authorized for use with Claude Code', message, re.IGNORECASE):
            reason = 'credential_limited_to_claude_code'
        elif (error.get('details') or {}).get('error_code') == 'claude_code_version_too_old':
            reason = 'client_version_too_old'
        elif re.search(r'(unsupported|invalid).{0,80}\bbeta\b', message, re.IGNORECASE):
            reason = 'invalid_beta_option'
        elif re.search(r'\bthinking\b.{0,100}(invalid|must|cannot|unsupported)', message, re.IGNORECASE):
            reason = 'invalid_thinking_option'
        elif re.search(r'\bmax_tokens\b.{0,100}(invalid|must|exceed)', message, re.IGNORECASE):
            reason = 'invalid_max_tokens'
        else:
            reason = 'unclassified_provider_error'
        return {'error_type': error_type, 'reason': reason}
    except (ValueError, TypeError, AttributeError, UnicodeError):
        return {'error_type': None, 'reason': 'non_json_or_unknown_error_shape'}


class State:
    def __init__(self, fixture, marker, key):
        self.fixture = fixture
        self.marker = marker
        self.key = key
        self.lock = threading.RLock()
        self.phase = 'read'
        self.records = []
        self.failure = None
        self.outgoing = 0
        self.active = False
        self.active_connection = None
        self.blocked_incidental = 0
        self.blocked_model_attempts = 0

    def fail(self, code):
        with self.lock:
            if self.failure is None:
                self.failure = code

    def close_active(self):
        with self.lock:
            connection = self.active_connection
        if connection:
            try:
                if connection.sock:
                    connection.sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            connection.close()

    def reserve(self, body, raw, headers):
        with self.lock:
            try:
                require(self.failure is None, 'stopped_after_failure')
                require(not self.active, 'concurrent_model_attempt')
                require(self.outgoing < REQUEST_LIMIT, 'gateway_request_limit')
                phase_calls = sum(r['phase'] == self.phase for r in self.records)
                require(phase_calls < (3 if self.phase == 'read' else 1), 'phase_request_limit')
                require(body.get('model') == MODEL and body.get('stream') is True
                        and isinstance(body.get('messages'), list), 'unexpected_model_or_protocol')
                require([t.get('name') for t in body.get('tools', [])] == ['read'], 'unexpected_tool_set')
                require(headers.get('x-api-key') == self.key, 'unexpected_gateway_key')
                require(headers.get('authorization') == 'Bearer ' + self.key, 'missing_gateway_bearer')
                require(not any(r['raw'] == raw for r in self.records), 'duplicate_request_attempt')
            except Failure:
                self.blocked_model_attempts += 1
                raise
            record = {'body': body, 'raw': raw, 'phase': self.phase, 'status': None,
                      'wire': b'', 'message': None, 'signature_delta_counts': [], 'response_complete': False,
                      'beta_header_present': bool(headers.get('anthropic-beta')),
                      'native_version_header_present': bool(headers.get('anthropic-version')),
                      'opencode_user_agent_present': 'opencode/' in (headers.get('user-agent') or '').lower(),
                      'gateway_key_present': True, 'request_bytes_forwarded_unchanged': False,
                      'response_bytes_forwarded_unchanged': False}
            self.records.append(record)
            self.outgoing += 1  # Reserve before opening a socket; connection failures count.
            self.active = True
            return record


class Observer(BaseHTTPRequestHandler):
    """Only a byte-preserving client-edge observer, never an API translator."""
    protocol_version = 'HTTP/1.1'

    def log_message(self, *_):
        pass

    def reject(self, status=400):
        self.close_connection = True
        try:
            self.send_response(status)
            self.send_header('Content-Length', '0')
            self.send_header('Connection', 'close')
            self.end_headers()
        except OSError:
            pass

    def incidental(self):
        with self.server.state.lock:
            self.server.state.blocked_incidental += 1
        self.reject(502)

    do_GET = do_CONNECT = do_PUT = do_DELETE = do_PATCH = do_OPTIONS = do_HEAD = incidental

    def do_POST(self):
        state = self.server.state
        connection = None; sent_headers = False; record = None
        try:
            # Incidental registry/telemetry calls are denied locally, not model failures.
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
            target_path = self.server.target_path + (('?' + path.query) if path.query else '')
            connection = http.client.HTTPConnection(self.server.target_host, self.server.target_port, timeout=90)
            with state.lock:
                state.active_connection = connection
            connection.request('POST', target_path, raw, headers)
            record['request_bytes_forwarded_unchanged'] = True
            response = connection.getresponse()
            record['status'] = response.status
            if response.status != 200:
                state.fail('gateway_http_failure')
            self.send_response(response.status)
            for key, value in response.getheaders():
                if key.lower() not in {'connection', 'transfer-encoding', 'content-length', 'server', 'date'}:
                    self.send_header(key, value)
            self.send_header('Connection', 'close')
            self.end_headers(); sent_headers = True; self.close_connection = True
            wire = bytearray()
            while chunk := response.read1(8192):
                wire.extend(chunk)
                require(len(wire) <= WIRE_LIMIT, 'response_size_limit')
                self.wfile.write(chunk); self.wfile.flush()
            record['wire'] = bytes(wire)
            record['response_bytes_forwarded_unchanged'] = True
            if response.status == 200:
                record['message'], record['signature_delta_counts'] = parse_sse(record['wire'])
                record['response_complete'] = True
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
                with state.lock:
                    state.active = False
                    if state.active_connection is connection:
                        state.active_connection = None


def isolated_env(folder, binary, fixture, origin, key):
    env = {k: v for k, v in os.environ.items() if k.upper() in {'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT'}}
    for name in ('home', 'config', 'data', 'cache', 'state', 'tmp', 'appdata', 'localappdata', 'programdata'):
        (folder / name).mkdir()
    system = os.environ.get('SystemRoot', os.environ.get('SYSTEMROOT', 'C:/Windows'))
    env.update(PATH=os.pathsep.join([str(binary.parent), str(Path(system) / 'System32')]),
               USERPROFILE=str(folder / 'home'), HOME=str(folder / 'home'), OPENCODE_TEST_HOME=str(folder / 'home'),
               APPDATA=str(folder / 'appdata'), LOCALAPPDATA=str(folder / 'localappdata'), ProgramData=str(folder / 'programdata'),
               XDG_CONFIG_HOME=str(folder / 'config'), XDG_DATA_HOME=str(folder / 'data'),
               XDG_CACHE_HOME=str(folder / 'cache'), XDG_STATE_HOME=str(folder / 'state'),
               TEMP=str(folder / 'tmp'), TMP=str(folder / 'tmp'), TMPDIR=str(folder / 'tmp'),
               OPENCODE_DB=str(folder / 'state/smoke.sqlite'), OPENCODE_LIVE_GATEWAY_TOKEN=key)
    for name in ('OPENCODE_PURE', 'OPENCODE_DISABLE_PROJECT_CONFIG', 'OPENCODE_DISABLE_DEFAULT_PLUGINS',
                 'OPENCODE_DISABLE_AUTOUPDATE', 'OPENCODE_DISABLE_MODELS_FETCH', 'OPENCODE_DISABLE_PRUNE',
                 'OPENCODE_DISABLE_AUTOCOMPACT', 'OPENCODE_DISABLE_TERMINAL_TITLE', 'OPENCODE_DISABLE_EXTERNAL_SKILLS',
                 'OPENCODE_DISABLE_LSP_DOWNLOAD', 'OPENCODE_DISABLE_CLAUDE_CODE', 'OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER'):
        env[name] = 'true'
    for name in ('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'):
        env[name] = origin
    env['NO_PROXY'] = env['no_proxy'] = '127.0.0.1,localhost'
    env['npm_config_registry'] = origin + '/offline-npm/'
    env['npm_config_userconfig'] = str(folder / 'home/.npmrc')
    # No replacement system prompt or user-agent, and no external plugin/provider install.
    # The bundled Anthropic provider appends /messages; include /v1 exactly once.
    config = {'model': 'anthropic/' + MODEL, 'small_model': 'anthropic/' + MODEL,
              'enabled_providers': ['anthropic'], 'autoupdate': False, 'snapshot': False, 'share': 'disabled',
              'lsp': False, 'plugin': [], 'mcp': {}, 'compaction': {'auto': False, 'prune': False},
              'permission': {'*': 'deny', 'read': {'*': 'deny', 'fixture.txt': 'allow',
                  '**/' + folder.name + '/fixture/fixture.txt': 'allow', fixture.as_posix(): 'allow'}},
              'provider': {'anthropic': {
                  'options': {'apiKey': '{env:OPENCODE_LIVE_GATEWAY_TOKEN}', 'baseURL': origin + '/claude-native/v1'},
                  'models': {MODEL: {'options': {'thinking': {'type': 'enabled', 'budgetTokens': 1024}},
                      'headers': {'Authorization': 'Bearer {env:OPENCODE_LIVE_GATEWAY_TOKEN}'}}}}}}
    env['OPENCODE_CONFIG_CONTENT'] = json.dumps(config)
    env['OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX'] = '4096'
    return env


def stop(child):
    if child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill(); child.wait(timeout=5)


def run_client(command, env, workspace, state, timeout=120):
    child = subprocess.Popen(command, cwd=workspace, env=env, stdin=subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=CREATIONFLAGS)
    captured = [bytearray(), bytearray()]; overflow = threading.Event()
    def reader(stream, index):
        while data := stream.read(8192):
            if len(captured[index]) + len(data) > WIRE_LIMIT:
                overflow.set(); break
            captured[index].extend(data)
    threads = [threading.Thread(target=reader, args=(child.stdout, 0), daemon=True),
               threading.Thread(target=reader, args=(child.stderr, 1), daemon=True)]
    for thread in threads:
        thread.start()
    deadline = time.monotonic() + timeout; timed_out = False; stopped_on_failure = False
    try:
        while child.poll() is None:
            if time.monotonic() >= deadline:
                timed_out = True; break
            if overflow.is_set():
                break
            # Let the unchanged error response reach the client before stopping
            # session-level retries. No retry is ever forwarded after failure.
            if state.failure and not state.active:
                stopped_on_failure = True; break
            time.sleep(.05)
    finally:
        stop(child)
        for thread in threads:
            thread.join(3)
        child.stdout.close(); child.stderr.close()
    return {'exit_code': child.returncode, 'stdout': bytes(captured[0]), 'stderr': bytes(captured[1]),
            'timed_out': timed_out, 'overflow': overflow.is_set(), 'stopped_on_observer_failure': stopped_on_failure}


def exact_fixture_marker(text, marker):
    """Allow presentation changes, but not a mutated/conflicting fixture token."""
    if re.fullmatch(r'OPENCODE_LIVE_[0-9a-f]{32}', marker) is None:
        return False
    tokens = re.findall(r'(?<![A-Za-z0-9_])OPENCODE_LIVE_[A-Za-z0-9_]*(?![A-Za-z0-9_])', text, re.IGNORECASE)
    return bool(tokens) and set(tokens) == {marker}


def client_events(result, marker):
    try:
        events = [json.loads(line) for line in result['stdout'].decode('utf-8').splitlines() if line.strip()]
        session_ids = {event.get('sessionID') for event in events if isinstance(event.get('sessionID'), str)}
        session = next(iter(session_ids)) if len(session_ids) == 1 else None
        finals = [event.get('part', {}) for event in events if event.get('type') == 'step_finish']
        texts = [event.get('part', {}).get('text', '') for event in events if event.get('type') == 'text']
        tools = [event.get('part', {}) for event in events if event.get('type') == 'tool_use']
        client_usage = []
        for part in finals:
            tokens = part.get('tokens', {}); cache = tokens.get('cache', {}) if isinstance(tokens, dict) else {}
            counts = {}
            for out, value in (('input_tokens', tokens.get('input')), ('output_tokens', tokens.get('output')),
                               ('reasoning_tokens', tokens.get('reasoning')), ('cache_read_input_tokens', cache.get('read')),
                               ('cache_creation_input_tokens', cache.get('write'))):
                if isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0:
                    counts[out] = value
            client_usage.append(counts)
        summary = {key: result[key] for key in ('exit_code', 'timed_out', 'overflow', 'stopped_on_observer_failure')}
        summary.update(event_count=len(events), event_parse_ok=True, session_id_observed=session is not None,
                       final_marker_present=exact_fixture_marker('\n'.join(texts), marker),
                       final_step_stop=bool(finals) and finals[-1].get('reason') == 'stop',
                       error_event=any(e.get('type') == 'error' for e in events),
                       read_tool_completions=sum(t.get('tool') == 'read' and t.get('state', {}).get('status') == 'completed' for t in tools),
                       other_tool_events=sum(t.get('tool') != 'read' for t in tools), client_usage=client_usage)
        summary['functional_pass'] = (result['exit_code'] == 0 and not result['timed_out'] and not result['overflow']
                                      and summary['final_marker_present'] and summary['final_step_stop']
                                      and not summary['error_event'] and session is not None)
        return summary, session
    except (ValueError, UnicodeError, TypeError, AttributeError):
        raise Failure('client_event_parse_failure') from None


def observations(state):
    records = state.records
    replays = []; response_reports = []
    for index, record in enumerate(records):
        message = record.get('message') or {}; blocks = content_blocks(message)
        signed = [b for b in blocks if b.get('type') == 'thinking' and b.get('signature')]
        response_reports.append({'phase': record['phase'], 'status': record['status'],
            'complete': record['response_complete'], 'usage': usage_counts(message.get('usage', {})),
            'error_diagnostics': record.get('error_diagnostics'),
            'thinking_blocks': sum(b.get('type') == 'thinking' for b in blocks),
            'signed_thinking_blocks': len(signed),
            'signed_empty_blocks': sum(b.get('thinking') == '' for b in signed),
            'redacted_blocks': sum(b.get('type') == 'redacted_thinking' for b in blocks),
            'tool_use_blocks': sum(b.get('type') == 'tool_use' for b in blocks),
            'signature_delta_counts': record['signature_delta_counts'],
            'beta_header_present': record['beta_header_present'],
            'native_version_header_present': record['native_version_header_present'],
            'opencode_user_agent_present': record['opencode_user_agent_present'],
            'observer_request_bytes_unchanged': record['request_bytes_forwarded_unchanged'],
            'observer_response_bytes_unchanged': record['response_bytes_forwarded_unchanged'],
            'requested_thinking_enabled': record['body'].get('thinking', {}).get('type') == 'enabled',
            'request_cache_markers': count_cache_markers(record['body'])})
        if index == 0:
            continue
        prior = [b for earlier in records[:index] for b in content_blocks(earlier.get('message') or {})]
        replay = history(record['body'], 'assistant')
        expected = without_cache(prior); actual = without_cache(replay)
        state_expected = [b for b in expected if b.get('type') in STATE_TYPES]
        state_actual = [b for b in actual if b.get('type') in STATE_TYPES]
        item = {'phase': record['phase'], 'ordered_assistant_exact': replay == prior,
                'ordered_assistant_exact_without_cache_annotations': actual == expected,
                'ordered_native_state_exact': state_actual == state_expected if state_expected else None}
        for label, predicate in (
            ('thinking', lambda b: b.get('type') == 'thinking'),
            ('signed_thinking', lambda b: b.get('type') == 'thinking' and bool(b.get('signature'))),
            ('signed_empty', lambda b: b.get('type') == 'thinking' and bool(b.get('signature')) and b.get('thinking') == ''),
            ('redacted', lambda b: b.get('type') == 'redacted_thinking'),
            ('tool_use', lambda b: b.get('type') == 'tool_use')):
            emitted = [b for b in expected if predicate(b)]; replayed = [b for b in actual if predicate(b)]
            item[label + '_issued_count'] = len(emitted)
            item[label + '_preserved'] = replayed == emitted if emitted else None
        tools = [b for b in prior if b.get('type') == 'tool_use']
        results = [b for b in history(record['body'], 'user') if b.get('type') == 'tool_result']
        item['tool_result_ids_match_issued_order'] = ([b.get('tool_use_id') for b in results] == [b.get('id') for b in tools]) if tools else None
        item['fixture_read_result_present'] = any(not b.get('is_error') and state.marker in json.dumps(b.get('content')) for b in results)
        replays.append(item)
    signed_checks = [r['signed_thinking_preserved'] for r in replays if r['signed_thinking_preserved'] is not None]
    return {'outgoing_gateway_attempts': state.outgoing, 'client_edge_requests': len(records),
            'blocked_model_attempts': state.blocked_model_attempts, 'blocked_incidental_requests': state.blocked_incidental,
            'responses': response_reports, 'replays': replays,
            'observed_signed_state_pass': all(signed_checks) if signed_checks else None,
            'native_relay_ingress_observed': False, 'deployed_gateway_body_fidelity': None,
            'deployed_gateway_to_relay_headers_exact': None, 'downstream_provider_call_count': None,
            'downstream_retry_count': None, 'gateway_usage_cost_accounting_exact': None}


def count_cache_markers(value):
    if isinstance(value, dict):
        return int(isinstance(value.get('cache_control'), dict)) + sum(count_cache_markers(v) for v in value.values())
    return sum(count_cache_markers(v) for v in value) if isinstance(value, list) else 0


def read_phase_complete(state, records):
    if not records or not all(r['status'] == 200 and r['response_complete'] for r in records):
        return False
    tools = [b for r in records for b in content_blocks(r['message']) if b.get('type') == 'tool_use']
    if not tools or any(t.get('name') != 'read' for t in tools):
        return False
    for tool in tools:
        value = tool.get('input', {}).get('filePath', '')
        path = Path(value)
        path = path if path.is_absolute() else state.fixture.parent / path
        if path.resolve() != state.fixture:
            return False
    results = [b for b in history(records[-1]['body'], 'user') if b.get('type') == 'tool_result']
    return (records[-1]['message'].get('stop_reason') == 'end_turn'
            and [r.get('tool_use_id') for r in results] == [t.get('id') for t in tools]
            and all(not r.get('is_error') and state.marker in json.dumps(r.get('content')) for r in results))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--live', action='store_true', help='Explicitly permit bounded real Haiku calls')
    parser.add_argument('--opencode', type=Path, required=True, help='Existing pinned 1.18.34 executable')
    parser.add_argument('--gateway-base-url', required=True, help='http://192.168.0.7:4000/claude-native (optional /v1)')
    parser.add_argument('--gateway-key-env', required=True, help='Name of environment variable holding the approved test key')
    parser.add_argument('--output', type=Path, required=True, help='New system-temp directory; sanitized report only')
    args = parser.parse_args(argv)
    if not args.live:
        parser.error('--live is required; no live calls made')
    server = None; thread = None; state = None; report = {'functional_pass': False, 'phases': []}
    output = args.output.resolve()
    try:
        host, port, target = gateway_target(args.gateway_base_url)
        require(not output.exists() and Path(tempfile.gettempdir()).resolve() in output.parents
                and ROOT not in output.parents, 'output_must_be_new_system_temp_child')
        binary = args.opencode.resolve(strict=True)
        with binary.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        require(digest == BINARY_SHA256, 'opencode_binary_identity_mismatch')
        require(re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', args.gateway_key_env) is not None, 'invalid_key_environment_name')
        key = os.environ.get(args.gateway_key_env, '')
        require(bool(key) and '\r' not in key and '\n' not in key, 'test_gateway_key_missing')
        output.mkdir(parents=True)
        runtime = Path(tempfile.mkdtemp(prefix='opencode-live-runtime-')).resolve()
        workspace = runtime / 'fixture'; workspace.mkdir()
        fixture = workspace / 'fixture.txt'; marker = 'OPENCODE_LIVE_' + secrets.token_hex(16)
        fixture.write_bytes((marker + '\n').encode('utf-8'))
        state = State(fixture, marker, key)
        server = ThreadingHTTPServer(('127.0.0.1', 0), Observer); server.daemon_threads = True
        server.state = state; server.target_host = host; server.target_port = port; server.target_path = target
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        origin = 'http://127.0.0.1:' + str(server.server_port)
        env = isolated_env(runtime, binary, fixture, origin, key)
        report.update(scope='actual OpenCode -> existing .7 LiteLLM -> configured .64 native Messages -> real Haiku',
                      observation_point='client-facing wire immediately before/after existing .7',
                      opencode_version=VERSION, opencode_sha256=digest, model=MODEL,
                      gateway_endpoint='http://192.168.0.7:4000' + target,
                      local_gateway_started=False, direct_relay_calls=False, maximum_gateway_attempts=REQUEST_LIMIT,
                      retained_runtime_directory=str(runtime), client_source_modified=False,
                      harness_error=None, not_tested=['downstream wire/body fidelity', 'gateway accounting and model ACL',
                          'real provider emitted signed-empty/redacted if absent', 'compaction/cancellation/model switch',
                          'downstream retries', 'OS-enforced filesystem/network sandbox'])
        version = run_client([str(binary), '--version'], env, workspace, state, timeout=20)
        require(version['exit_code'] == 0 and version['stdout'].decode('utf-8').strip() == VERSION,
                'opencode_version_mismatch')
        base = [str(binary), 'run', '--format', 'json', '--model', 'anthropic/' + MODEL,
                '--log-level', 'ERROR', '--title', 'Bounded native gateway read smoke']
        prompt = ('Use only the read tool to read fixture.txt once. Do not use any other tool or network. '
                  'Then answer READ_CONFIRMED: followed by the exact first line from the file, and finish.')
        first = run_client(base + [prompt], env, workspace, state)
        first_summary, session = client_events(first, marker)
        first_summary['phase'] = 'read'
        first_summary['actual_read_roundtrip'] = read_phase_complete(state, state.records)
        report['phases'].append(first_summary)
        require(state.failure is None, state.failure or 'observer_failure')
        require(first_summary['functional_pass'] and first_summary['actual_read_roundtrip'], 'read_phase_incomplete')
        require(isinstance(session, str) and re.fullmatch(r'ses_[A-Za-z0-9]+', session), 'session_id_not_observed')
        before_followup = len(state.records)
        state.phase = 'followup'
        second = run_client(base + ['--session', session,
            'Without using any tool or re-reading the file, answer FOLLOWUP_CONFIRMED: followed by the exact first line you read in this session. Then finish.'],
            env, workspace, state)
        second_summary, resumed_session = client_events(second, marker)
        second_summary.update(phase='followup', same_session_resumed=resumed_session == session)
        second_records = state.records[before_followup:]
        second_summary['one_complete_followup_request'] = (len(second_records) == 1 and second_records[0]['response_complete']
            and second_records[0]['message'].get('stop_reason') == 'end_turn'
            and not any(b.get('type') == 'tool_use' for b in content_blocks(second_records[0]['message'])))
        report['phases'].append(second_summary)
        require(state.failure is None, state.failure or 'observer_failure')
        require(second_summary['functional_pass'] and second_summary['same_session_resumed']
                and second_summary['one_complete_followup_request'], 'followup_phase_incomplete')
        report['fixture_unchanged'] = (fixture.read_bytes() == (marker + '\n').encode('utf-8')
                                      and sorted(p.name for p in workspace.iterdir()) == ['fixture.txt'])
        require(report['fixture_unchanged'], 'fixture_modified')
        report['functional_pass'] = True
    except Failure as error:
        report['harness_error'] = str(error)
    except Exception:
        report['harness_error'] = 'harness_runtime_failure'
    finally:
        if state:
            state.close_active()
        if server:
            server.shutdown(); server.server_close(); thread.join(3)
        if state:
            report['observer_failure'] = state.failure
            report.update(observations(state))
        # Never export errors, stdout/stderr, raw bodies, tokens, signatures or session IDs.
        if output.is_dir() and state is not None:
            (output / 'opencode-live-smoke.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps({'functional_pass': report['functional_pass'], 'harness_error': report.get('harness_error'),
                      'gateway_attempts': report.get('outgoing_gateway_attempts', 0),
                      'report_written': output.is_dir() and state is not None}))
    return 0 if report['functional_pass'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
