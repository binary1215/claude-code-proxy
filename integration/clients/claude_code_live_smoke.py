"""Explicit live Claude Code Read/resume test through an existing or stock gateway.

No live call is made without --live. Only a named environment variable supplies
the gateway or relay key. Raw requests, responses and process output remain in memory;
Claude Code itself retains its synthetic session in a new temporary runtime.
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
import re
import secrets
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[2]
MODEL = 'claude-haiku-4-5-20251001'
CLIENT_SHA256 = 'bcc6d9117aec30ad9414490302a25414359c871f5647e32e49b055c92bf84e0b'
CLIENT_PATH = '/claude-live/v1/messages'
RELAY_PATH = '/v1/messages'
REQUEST_LIMIT = 4
WIRE_LIMIT = 8 * 1024 * 1024
CREATIONFLAGS = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
USAGE_FIELDS = ('input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens')


class Failure(Exception):
    """Only fixed, harness-authored codes are eligible for the report."""


def require(condition, code):
    if not condition:
        raise Failure(code)


def isolated_env(folder):
    allowed = {'PATH', 'SYSTEMROOT', 'WINDIR', 'PATHEXT', 'COMSPEC'}
    env = {name: value for name, value in os.environ.items() if name.upper() in allowed}
    for name in ('TEMP', 'TMP', 'TMPDIR', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOME',
                 'ProgramData', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'):
        env[name] = str(folder)
    env['PYTHONDONTWRITEBYTECODE'] = '1'
    env['PYTHONUTF8'] = '1'
    return env


def content_blocks(message):
    content = message.get('content', [])
    return content if isinstance(content, list) else [{'type': 'text', 'text': content}]


def state_content(blocks):
    # Cache hints are request annotations, not model-authored native state.
    return [{key: value for key, value in block.items() if key != 'cache_control'} for block in blocks]


def replay_shape(returned, replayed):
    """Bounded field/type differences; never values, signatures or input keys."""
    known = {'type', 'id', 'name', 'input', 'caller', 'toolset_id', 'text', 'citations',
             'thinking', 'signature', 'data', 'cache_control'}
    kinds = {'thinking', 'redacted_thinking', 'text', 'tool_use'}

    def kind(block):
        return block.get('type') if block.get('type') in kinds else 'other'

    differences = []
    for index, (before, after) in enumerate(zip(returned[:16], replayed[:16])):
        if before == after:
            continue
        before_keys, after_keys = set(before), set(after)
        changed = {key for key in before_keys & after_keys if before[key] != after[key]}
        differences.append({'index': index, 'returned_type': kind(before), 'replayed_type': kind(after),
                            'known_fields_removed': sorted((before_keys - after_keys) & known),
                            'known_fields_added': sorted((after_keys - before_keys) & known),
                            'known_fields_changed': sorted(changed & known),
                            'unknown_field_differences': len(((before_keys ^ after_keys) | changed) - known)})

    def tool_core(blocks):
        return [(block.get('id'), block.get('name'), block.get('input'))
                for block in blocks if block.get('type') == 'tool_use']

    return {'returned_block_count': len(returned), 'replayed_block_count': len(replayed),
            'returned_types': [kind(block) for block in returned[:16]],
            'replayed_types': [kind(block) for block in replayed[:16]],
            'diagnostic_truncated': len(returned) > 16 or len(replayed) > 16,
            'block_differences': differences,
            'concatenated_text_exact': ''.join(block.get('text', '') for block in returned if block.get('type') == 'text')
            == ''.join(block.get('text', '') for block in replayed if block.get('type') == 'text'),
            'tool_id_name_input_exact': tool_core(returned) == tool_core(replayed)}


def assistant_history(body):
    return [block for message in body.get('messages', []) if message.get('role') == 'assistant'
            for block in content_blocks(message) if isinstance(block, dict)]


def tool_results(body):
    return [block for message in body.get('messages', []) if message.get('role') == 'user'
            for block in content_blocks(message) if isinstance(block, dict) and block.get('type') == 'tool_result']


def usage_counts(value):
    return {name: value[name] for name in USAGE_FIELDS
            if isinstance(value.get(name), int) and not isinstance(value[name], bool) and value[name] >= 0}


def marker_retrieved(text, marker):
    """Check retrieval, accepting prose/formatting but never a changed marker."""
    if not isinstance(text, str):
        return False
    tokens = re.findall(r'(?<![A-Za-z0-9_])CLAUDE_LIVE_FIXTURE_[A-Za-z0-9_-]+', text, re.IGNORECASE)
    return bool(tokens) and all(token == marker for token in tokens)


def parse_sse(wire):
    """Assemble native content using all deltas, without persisting opaque data."""
    try:
        text = wire.decode('utf-8').replace('\r\n', '\n')
        events = []
        for frame in text.split('\n\n'):
            data = '\n'.join(line[5:].lstrip(' ') for line in frame.split('\n') if line.startswith('data:'))
            if data and data != '[DONE]':
                events.append(json.loads(data))
        require(events and not any(event.get('type') == 'error' for event in events), 'native_sse_error')
        starts = [event for event in events if event.get('type') == 'message_start']
        require(len(starts) == 1 and any(event.get('type') == 'message_stop' for event in events), 'native_sse_incomplete')
        message = copy.deepcopy(starts[0]['message'])
        blocks = {}; inputs = {}; usage = dict(message.get('usage', {})); reason = message.get('stop_reason')
        for event in events:
            kind = event.get('type')
            if kind == 'content_block_start':
                blocks[event['index']] = copy.deepcopy(event['content_block'])
            elif kind == 'content_block_delta':
                index = event['index']; delta = event['delta']; block = blocks[index]
                field = {'text_delta': 'text', 'thinking_delta': 'thinking', 'signature_delta': 'signature'}.get(delta.get('type'))
                if field:
                    block[field] = block.get(field, '') + delta[field]
                elif delta.get('type') == 'input_json_delta':
                    inputs[index] = inputs.get(index, '') + delta['partial_json']
                else:
                    raise Failure('unsupported_native_delta')
            elif kind == 'message_delta':
                reason = event.get('delta', {}).get('stop_reason', reason)
                # Native deltas may repeat input/cache fields as null. Those
                # are absent updates, not instructions to erase start counts.
                usage.update({key: value for key, value in event.get('usage', {}).items() if value is not None})
        for index, value in inputs.items():
            # Match native SDK assembly: an exactly empty delta buffer carries
            # no replacement input. Nonempty malformed JSON still fails.
            if value != '':
                blocks[index]['input'] = json.loads(value)
        message.update(content=[blocks[index] for index in sorted(blocks)], stop_reason=reason, usage=usage)
        return message
    except Failure:
        raise
    except (ValueError, KeyError, TypeError, UnicodeError):
        raise Failure('native_sse_invalid') from None


def request_shape(body):
    return (body.get('model') == MODEL and body.get('stream') is True
            and isinstance(body.get('messages'), list)
            and [tool.get('name') for tool in body.get('tools', [])] == ['Read'])


class CallState:
    def __init__(self, fixture, marker, deployed_gateway=False):
        self.fixture = fixture
        self.marker = marker
        self.lock = threading.Lock()
        self.failure = None
        self.outgoing_calls = 0
        self.phase = 'read'
        self.native = []
        self.client = []
        self.blocked_requests = 0
        self.deployed_gateway = deployed_gateway

    @property
    def responses(self):
        # Existing-gateway mode observes only the client-facing Messages wire.
        # The relay's native ingress is deliberately not inferred from it.
        return self.client if self.deployed_gateway else self.native

    def fail(self, code):
        with self.lock:
            if self.failure is None:
                self.failure = code

    def reserve(self, body):
        with self.lock:
            require(self.failure is None, 'stopped_after_failure')
            require(self.outgoing_calls < REQUEST_LIMIT, 'outgoing_request_limit')
            require(request_shape(body), 'unexpected_native_request')
            require(self.outgoing_calls < 2 if self.phase == 'read' else self.outgoing_calls == 2,
                    'unexpected_turn_request_count')
            if self.outgoing_calls:
                # Let the real provider judge the client's replay. Equality is
                # an independently reported observation, never a call gate.
                results = tool_results(body)
                first_tools = [block for block in self.responses[0]['message']['content'] if block.get('type') == 'tool_use']
                require(len(results) == 1 and len(first_tools) == 1
                        and results[0].get('tool_use_id') == first_tools[0]['id']
                        and not results[0].get('is_error', False)
                        and self.marker in json.dumps(results[0].get('content')), 'read_tool_result_missing')
            self.outgoing_calls += 1

    def accept_response(self, record):
        message = parse_sse(record['wire'])
        record['message'] = message
        index = self.responses.index(record)
        tools = [block for block in message['content'] if block.get('type') == 'tool_use']
        if index == 0:
            require(message.get('stop_reason') == 'tool_use' and len(tools) == 1 and tools[0].get('name') == 'Read',
                    'first_response_not_one_Read')
            path = tools[0].get('input', {}).get('file_path', '')
            resolved = Path(path) if Path(path).is_absolute() else self.fixture.parent / path
            require(resolved.resolve() == self.fixture, 'Read_target_not_fixture')
        else:
            require(message.get('stop_reason') == 'end_turn' and not tools, 'unexpected_extra_tool_or_incomplete_turn')
            final = ''.join(block.get('text', '') for block in message['content'] if block.get('type') == 'text')
            record['marker_retrieved'] = marker_retrieved(final, self.marker)
            require(record['marker_retrieved'], 'native_final_marker_mismatch')


class Observer(BaseHTTPRequestHandler):
    """Unchanged bytes at the client edge; a second edge exists in stock mode."""
    protocol_version = 'HTTP/1.1'

    def log_message(self, *_):
        pass

    def reject(self, status=502):
        self.close_connection = True
        try:
            self.send_response(status)
            self.send_header('Content-Length', '0')
            self.send_header('Connection', 'close')
            self.end_headers()
        except OSError:
            pass

    def do_CONNECT(self):
        self.server.state.blocked_requests += 1
        self.reject()

    def do_GET(self):
        self.server.state.blocked_requests += 1
        self.reject()

    def do_POST(self):
        state = self.server.state
        connection = None
        sent_headers = False
        record = None
        try:
            size = int(self.headers.get('content-length', '0'))
            require(urllib.parse.urlsplit(self.path).path == self.server.allowed_path
                    and 0 < size <= WIRE_LIMIT, 'unexpected_observer_request')
            require(state.failure is None, 'stopped_after_failure')
            raw = self.rfile.read(size)
            body = json.loads(raw)
            require(request_shape(body), 'unexpected_client_request')
            if self.server.edge in ('native', 'gateway'):
                state.reserve(body)
            else:
                require(len(state.client) < REQUEST_LIMIT, 'client_request_limit')
            record = {'body': body, 'raw': raw, 'wire': b'', 'status': None,
                      'beta': self.headers.get('anthropic-beta'), 'user_agent': self.headers.get('user-agent')}
            (state.native if self.server.edge == 'native' else state.client).append(record)
            cls = http.client.HTTPSConnection if self.server.scheme == 'https' else http.client.HTTPConnection
            connection = cls(self.server.target_host, self.server.target_port, timeout=90)
            headers = {key: value for key, value in self.headers.items()
                       if key.lower() not in {'host', 'connection', 'transfer-encoding', 'accept-encoding'}}
            headers['accept-encoding'] = 'identity'
            # Preserve body, beta and official user agent. The selected base
            # path and transport framing are the observer's only rewrites.
            query = urllib.parse.urlsplit(self.path).query
            path = self.server.target_path + (('?' + query) if query else '')
            connection.request('POST', path, raw, headers)
            response = connection.getresponse()
            record['status'] = response.status
            if response.status != 200:
                state.fail('native_http_failure' if self.server.edge == 'native' else 'gateway_http_failure')
            self.send_response(response.status)
            for name, value in response.getheaders():
                if name.lower() not in {'connection', 'transfer-encoding', 'content-length', 'server', 'date'}:
                    self.send_header(name, value)
            self.send_header('Connection', 'close')
            self.end_headers(); sent_headers = True; self.close_connection = True
            wire = bytearray()
            while chunk := response.read1(8192):
                wire.extend(chunk)
                require(len(wire) <= WIRE_LIMIT, 'response_limit')
                self.wfile.write(chunk); self.wfile.flush()
            record['wire'] = bytes(wire)
            if response.status == 200 and self.server.edge in ('native', 'gateway'):
                state.accept_response(record)
        except Failure as error:
            state.fail(str(error))
            if not sent_headers:
                self.reject()
        except Exception:
            state.fail('observer_transport_failure')
            if not sent_headers:
                self.reject()
        finally:
            if connection:
                connection.close()


def observer(state, edge, host, port, scheme='http', target_path=None):
    server = ThreadingHTTPServer(('127.0.0.1', 0), Observer)
    server.daemon_threads = True
    server.state = state; server.edge = edge; server.target_host = host; server.target_port = port; server.scheme = scheme
    server.allowed_path = RELAY_PATH if edge == 'native' else CLIENT_PATH
    server.target_path = target_path or server.allowed_path
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread


def client_result(result, marker):
    try:
        events = [json.loads(line) for line in result.stdout.splitlines() if line.strip()]
        finals = [event for event in events if event.get('type') == 'result']
        final = finals[0] if len(finals) == 1 else {}
        return {'exit_code': result.returncode, 'event_count': len(events), 'result_count': len(finals),
                'marker_retrieved': marker_retrieved(final.get('result', ''), marker),
                'successful_final': result.returncode == 0 and len(finals) == 1 and final.get('subtype') == 'success'
                and final.get('is_error') is False and marker_retrieved(final.get('result', ''), marker),
                'usage': usage_counts(final.get('usage', {}))}
    except (ValueError, TypeError, AttributeError):
        raise Failure('client_output_invalid') from None


def observations(state):
    records = state.responses
    complete = len(records) == 3 and all('message' in record for record in records)
    messages = [record.get('message', {}) for record in records]
    issued = [block for message in messages[:2] for block in message.get('content', [])]
    signed = [block for block in issued if block.get('type') == 'thinking' and block.get('signature')]
    first_signed = [block for block in (messages[0].get('content', []) if messages else [])
                    if block.get('type') == 'thinking' and block.get('signature')]
    replays = []
    for index in range(1, len(records)):
        prior = [block for message in messages[:index] for block in message.get('content', [])]
        results = tool_results(records[index]['body'])
        prior_signed = [block for block in prior if block.get('type') in ('thinking', 'redacted_thinking')]
        replayed = assistant_history(records[index]['body'])
        replay_signed = [block for block in state_content(replayed)
                         if block.get('type') in ('thinking', 'redacted_thinking')]
        replays.append({'after': 'Read' if index == 1 else 'user_followup',
                        'one_tool_result_replayed': len(results) == 1,
                        'fixture_marker_in_tool_result': len(results) == 1 and not results[0].get('is_error', False)
                        and state.marker in json.dumps(results[0].get('content')),
                        'ordered_content_exact': replayed == prior,
                        'content_exact_without_cache_control': state_content(replayed) == state_content(prior),
                        'shape_diagnostics': replay_shape(prior, replayed),
                        'returned_thinking_or_redacted_count': len(prior_signed),
                        'signed_blocks_preserved': replay_signed == state_content(prior_signed) if prior_signed else None})
    pairs = [] if state.deployed_gateway else list(zip(state.client, state.native))
    comparisons = []
    for sent, received in pairs:
        comparisons.append({'request_bytes_exact': sent['raw'] == received['raw'],
                            'request_objects_exact': sent['body'] == received['body'],
                            'client_metadata_present': 'metadata' in sent['body'],
                            'native_metadata_present': 'metadata' in received['body'],
                            'only_top_level_metadata_removed': 'metadata' in sent['body'] and 'metadata' not in received['body']
                            and {k: v for k, v in sent['body'].items() if k != 'metadata'} == received['body'],
                            'sse_bytes_exact': sent['wire'] == received['wire'],
                            'beta_header_exact': sent['beta'] == received['beta'],
                            'user_agent_exact': sent['user_agent'] == received['user_agent']})
    transport = complete and len(pairs) == 3 and all(item['sse_bytes_exact'] and item['beta_header_exact'] and item['user_agent_exact']
                                and (item['request_objects_exact'] or item['only_top_level_metadata_removed']) for item in comparisons)
    signed_checks = [item['signed_blocks_preserved'] for item in replays if item['signed_blocks_preserved'] is not None]
    observed_signed_pass = all(signed_checks) if signed_checks else None
    signed_pass = observed_signed_pass if complete or observed_signed_pass is False else None
    replay_content = all(item['content_exact_without_cache_control'] for item in replays) if replays else None
    if observed_signed_pass is False:
        signed_status = 'changed'
    elif observed_signed_pass is True:
        signed_status = 'preserved' if complete else 'preserved_partial'
    else:
        signed_status = 'not_observed' if any(block.get('type') in ('thinking', 'redacted_thinking') for block in issued) else 'not_emitted'
    return {'outgoing_remote_requests': state.outgoing_calls,
            'outgoing_gateway_requests': state.outgoing_calls if state.deployed_gateway else None,
            'outgoing_relay_requests': None if state.deployed_gateway else state.outgoing_calls,
            'client_requests': len(state.client),
            'blocked_incidental_requests': state.blocked_requests,
            'http_statuses': [record['status'] for record in records],
            'observation_point': 'client_to_deployed_gateway' if state.deployed_gateway else 'both_sides_of_temporary_stock_gateway',
            'native_ingress_observed': not state.deployed_gateway,
            'deployed_gateway_to_relay_fidelity': 'unknown' if state.deployed_gateway else 'not_applicable',
            'native_usage': [usage_counts(message.get('usage', {})) for message in messages],
            'signed_thinking_blocks_before_Read_result': len(first_signed),
            'signed_thinking_blocks_before_followup': len(signed),
            'redacted_thinking_blocks_before_followup': sum(block.get('type') == 'redacted_thinking' for block in issued),
            'replays': replays, 'gateway_comparisons': None if state.deployed_gateway else comparisons,
            'replay_coverage': {'Read': 'observed' if len(replays) >= 1 else 'unobserved',
                                'user_followup': 'observed' if len(replays) >= 2 else 'unobserved'},
            'replay_coverage_complete': len(replays) == 2,
            'whole_body_semantic_exact': None if state.deployed_gateway else complete and len(pairs) == 3 and all(item['request_objects_exact'] for item in comparisons),
            'observed_replay_content_exact': replay_content,
            'native_transport_state_pass': None if state.deployed_gateway else transport and replay_content,
            'observed_signed_state_pass': observed_signed_pass,
            'signed_state_pass': signed_pass,
            'signed_state_status': signed_status}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--live', action='store_true', help='Explicitly permit real provider calls')
    parser.add_argument('--claude', type=Path, required=True, help='Existing pinned Claude Code 2.1.289 native binary')
    route = parser.add_mutually_exclusive_group(required=True)
    route.add_argument('--gateway-base-url', help='Existing .7 native gateway base, e.g. http://192.168.0.7:4000/claude-native')
    route.add_argument('--relay-base-url', help='Local-stock diagnostic mode: .64 relay origin, e.g. http://HOST:13457')
    parser.add_argument('--gateway-key-env', default='CLAUDE_LIVE_GATEWAY_KEY', help='Existing gateway key environment variable NAME')
    parser.add_argument('--relay-key-env', default='CLAUDE_LIVE_RELAY_KEY', help='Environment variable NAME; never the key value')
    parser.add_argument('--output', type=Path, required=True, help='NEW system-temp evidence directory; sanitized JSON report only')
    args = parser.parse_args(argv)
    if not args.live:
        parser.error('--live is required; no provider request was made')
    deployed = args.gateway_base_url is not None
    parsed = urllib.parse.urlsplit(args.gateway_base_url if deployed else args.relay_base_url)
    if (parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password
            or (not deployed and parsed.path not in ('', '/')) or parsed.query or parsed.fragment):
        parser.error('Use a gateway base path or relay origin without credentials, query or fragment')
    key_env = args.gateway_key_env if deployed else args.relay_key_env
    if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', key_env):
        parser.error('The selected key option must name an environment variable')
    output = args.output.resolve(); temp_root = Path(tempfile.gettempdir()).resolve()
    if output.exists() or temp_root not in output.parents or ROOT in output.parents:
        parser.error('--output must be a NEW directory inside system temp and outside the repository')
    output.mkdir(parents=True)
    report_path = output / 'claude-code-live-smoke.json'
    report = {'scope': ('actual Claude Code -> local observer -> existing .7 gateway -> configured .64 relay -> real Haiku'
                        if deployed else 'actual Claude Code -> temporary unmodified stock LiteLLM -> existing .64 native relay -> real Haiku'),
              'mode': 'deployed_gateway' if deployed else 'local_stock_diagnostic',
              'model': MODEL, 'live_provider_calls_possible': True, 'production_dot7_gateway_tested': False,
              'outgoing_remote_request_limit': REQUEST_LIMIT, 'client_retries': 0, 'observer_retries': 0,
              'gateway_retries': None if deployed else 0, 'deployed_gateway_or_relay_internal_attempts': 'unobserved',
              'temporary_gateway_started': False,
              'client_fallback_enabled': False, 'functional_pass': False, 'pass': False, 'turns': [],
              'not_tested': (['.7-to-.64 request/SSE/header equality', 'deployed gateway source identity'] if deployed
                             else ['actual .7 gateway configuration or acceptance']) + ['long sessions or compaction',
                             'billing or subscription entitlement', 'OS-enforced network isolation'],
              'retention': 'Only this sanitized report is written to the evidence directory. The separate temporary runtime is retained; Claude Code naturally saves the synthetic session, including native signed content. Harness wire captures and process output are memory-only.'}
    runtime = None; state = None; servers = []; gateway = None; gateway_reader = None
    try:
        selected_key = os.environ.get(key_env)
        require(isinstance(selected_key, str) and selected_key and len(selected_key) <= 4096
                and all(33 <= ord(char) <= 126 for char in selected_key), 'selected_key_environment_missing_or_invalid')
        claude = args.claude.resolve(strict=True)
        with claude.open('rb') as executable:
            report['claude_sha256'] = hashlib.file_digest(executable, 'sha256').hexdigest()
        require(report['claude_sha256'] == CLIENT_SHA256, 'pinned_client_identity_mismatch')
        if not deployed:
            import yaml
            from codex_patch_smoke import identities, start, stop
            report['litellm_version'] = importlib.metadata.version('litellm')
            require(report['litellm_version'] == '1.103.1', 'pinned_stock_litellm_required')
            report['stock_before'] = identities()
        runtime = Path(tempfile.mkdtemp(prefix='claude-code-live-runtime-')).resolve()
        report['retained_runtime_directory'] = str(runtime)
        workspace = runtime / 'workspace'; workspace.mkdir()
        client_home = runtime / 'client-home'; client_home.mkdir()
        client_state = client_home / 'claude-state'; client_state.mkdir()
        fixture = workspace / 'fixture.txt'
        marker = 'CLAUDE_LIVE_FIXTURE_' + secrets.token_hex(12)
        fixture.write_text(marker + '\n', encoding='utf-8')
        settings = runtime / 'settings.json'
        settings.write_text(json.dumps({'permissions': {'allow': ['Read(./fixture.txt)'],
            'deny': ['Bash', 'Edit', 'Write', 'WebFetch', 'WebSearch', 'Agent', 'Task', 'Skill']},
            'hooks': {}, 'autoMemoryEnabled': False}), encoding='utf-8')
        state = CallState(fixture, marker, deployed_gateway=deployed)
        if deployed:
            gateway_key = selected_key
            client, thread = observer(state, 'gateway', parsed.hostname,
                parsed.port or (443 if parsed.scheme == 'https' else 80), parsed.scheme,
                target_path=parsed.path.rstrip('/') + RELAY_PATH)
        else:
            gateway_home = runtime / 'gateway-home'; gateway_home.mkdir()
            native, thread = observer(state, 'native', parsed.hostname, parsed.port or (443 if parsed.scheme == 'https' else 80), parsed.scheme)
            servers.append((native, thread))
            gateway_key = 'sk-local-claude-live-' + secrets.token_hex(24)
            config = {'litellm_settings': {'telemetry': False, 'num_retries': 0, 'callbacks': []},
                      'router_settings': {'num_retries': 0},
                      'general_settings': {'master_key': 'os.environ/LOCAL_GATEWAY_KEY', 'pass_through_endpoints': [{
                          'path': CLIENT_PATH, 'target': 'http://127.0.0.1:' + str(native.server_port) + RELAY_PATH,
                          'auth': True, 'methods': ['POST'], 'forward_headers': True,
                          'headers': {'Authorization': 'os.environ/LOCAL_RELAY_AUTHORIZATION', 'x-api-key': ''}}]}}
            config_path = runtime / 'gateway.yaml'
            config_path.write_text(yaml.safe_dump(config), encoding='utf-8')
            env = isolated_env(gateway_home)
            env.update(CONFIG_FILE_PATH=str(config_path), LOCAL_GATEWAY_KEY=gateway_key,
                       LOCAL_RELAY_AUTHORIZATION='Bearer ' + selected_key, LITELLM_LOCAL_MODEL_COST_MAP='True')
            gateway, gateway_reader, gateway_logs, port = start([sys.executable, str(ROOT / 'integration/litellm/boot_gateway.py')],
                env, gateway_home, lambda line: int(line.strip().split('=')[1]) if line.startswith('LOCAL_GATEWAY_PORT=') else None, 45)
            env.clear()
            report['temporary_gateway_started'] = True
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            deadline = time.monotonic() + 30
            while True:
                try:
                    opener.open('http://127.0.0.1:' + str(port) + '/health/liveliness', timeout=.5).close()
                    break
                except Exception:
                    require(time.monotonic() < deadline and gateway.poll() is None, 'gateway_not_ready')
                    time.sleep(.2)
            client, thread = observer(state, 'client', '127.0.0.1', port)
        selected_key = None
        servers.append((client, thread))
        proxy = 'http://127.0.0.1:' + str(client.server_port)
        env = isolated_env(client_home)
        env.update({'CLAUDE_CONFIG_DIR': str(client_state), 'ANTHROPIC_BASE_URL': proxy + '/claude-live',
            'ANTHROPIC_API_KEY': gateway_key, 'ANTHROPIC_MODEL': MODEL, 'ANTHROPIC_DEFAULT_HAIKU_MODEL': MODEL,
            'ANTHROPIC_DEFAULT_SONNET_MODEL': MODEL, 'ANTHROPIC_DEFAULT_OPUS_MODEL': MODEL,
            'HTTP_PROXY': proxy, 'HTTPS_PROXY': proxy, 'ALL_PROXY': proxy, 'NO_PROXY': '127.0.0.1,localhost',
            'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1', 'CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL': '1',
            'CLAUDE_CODE_DISABLE_CLAUDE_MDS': '1', 'CLAUDE_CODE_DISABLE_POLICY_SKILLS': '1',
            'CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS': '1', 'CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK': '1',
            'CLAUDE_CODE_DISABLE_TERMINAL_TITLE': '1', 'CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING': '1',
            'CLAUDE_CODE_DISABLE_CRON': '1', 'CLAUDE_CODE_MAX_RETRIES': '0',
            'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY': '0', 'ENABLE_TOOL_SEARCH': 'false',
            'DISABLE_AUTOUPDATER': '1', 'DISABLE_TELEMETRY': '1', 'DISABLE_ERROR_REPORTING': '1',
            'DISABLE_COMPACT': '1', 'MAX_THINKING_TOKENS': '1024', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS': '4096'})
        version = subprocess.run([str(claude), '--version'], cwd=workspace, env=env, capture_output=True,
                                 text=True, encoding='utf-8', errors='replace', timeout=15, creationflags=CREATIONFLAGS)
        require(version.returncode == 0 and version.stdout.strip().startswith('2.1.289 '), 'pinned_client_version_mismatch')
        report['claude_version'] = '2.1.289'
        session_id = str(uuid.uuid4())
        base = [str(claude), '-p', '--model', MODEL, '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
                '--tools', 'Read', '--allowedTools', 'Read(./fixture.txt)', '--permission-mode', 'dontAsk',
                '--settings', str(settings), '--setting-sources', '', '--strict-mcp-config',
                '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands', '--max-turns', '3']
        prompts = [
            'Use Read exactly once to read fixture.txt. Remember its single-line marker for a later question. '
            'Reply with exactly READ_CONFIRMED: immediately followed by that marker, without any other text.',
            'Without using any tool or reading any file again, recall the exact fixture marker from our earlier exchange. '
            'Reply with exactly FOLLOWUP_CONFIRMED: immediately followed by that marker, without any other text.']
        for index, prompt in enumerate(prompts):
            require(state.failure is None, state.failure or 'stopped_after_failure')
            state.phase = 'read' if index == 0 else 'followup'
            command = base + (['--session-id', session_id] if index == 0 else ['--resume', session_id]) + [prompt]
            result = subprocess.run(command, cwd=workspace, env=env, stdin=subprocess.DEVNULL, capture_output=True,
                                    text=True, encoding='utf-8', errors='replace', timeout=180, creationflags=CREATIONFLAGS)
            require(len(result.stdout) + len(result.stderr) <= WIRE_LIMIT, 'client_output_limit')
            item = client_result(result, marker)
            item['turn'] = 'Read' if index == 0 else 'resumed_user_followup'
            report['turns'].append(item)
            require(state.failure is None, state.failure or 'stopped_after_failure')
            require(item['successful_final'], 'client_turn_failed')
            require(state.outgoing_calls == (2 if index == 0 else 3), 'unexpected_turn_request_count')
        report['workspace_fixture_unchanged'] = fixture.read_text(encoding='utf-8') == marker + '\n'
        report['workspace_only_fixture'] = sorted(path.name for path in workspace.iterdir()) == ['fixture.txt']
        report['functional_pass'] = (len(report['turns']) == 2 and all(item['successful_final'] for item in report['turns'])
                                     and report['workspace_fixture_unchanged'] and report['workspace_only_fixture'])
    except Failure as error:
        report['failure'] = str(error)
    except subprocess.TimeoutExpired:
        report['failure'] = 'bounded_process_timeout'
    except Exception:
        # Native errors, process logs and exception text may contain secrets or
        # signed content. Never include them in a report or stdout traceback.
        report['failure'] = 'local_harness_operation_failed'
    finally:
        if state:
            # Closing the call latch before cleanup also covers a timed-out CLI.
            state.fail(state.failure or ('test_finished' if report['functional_pass'] else 'test_stopped'))
        if gateway:
            stop(gateway)
            gateway_reader.join(3)
            gateway.stdout.close()
        for server, thread in reversed(servers):
            server.shutdown(); server.server_close(); thread.join(3)
        if state:
            report.update(observations(state))
            report['production_dot7_gateway_tested'] = deployed and state.outgoing_calls > 0
            if state.failure not in ('test_finished', 'test_stopped'):
                report['failure'] = state.failure
        if not deployed and 'stock_before' in report:
            try:
                report['stock_after'] = identities()
                report['stock_source_unchanged'] = report['stock_before'] == report['stock_after']
            except Exception:
                report['stock_source_unchanged'] = False
        # Functional completion answers whether the real client can Read and
        # resume. Fidelity and missing reasoning coverage remain separate facts.
        report['pass'] = bool(report['functional_pass'] and 'failure' not in report
                              and report.get('stock_source_unchanged') is not False)
        report_path.write_text(json.dumps(report, indent=2), encoding='utf-8')
    print('Report:', report_path)
    print('Functional pass:', report['functional_pass'])
    print('Signed state:', report.get('signed_state_status', 'not_observed'))
    print('Pass:', report['pass'])
    return 0 if report['pass'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
