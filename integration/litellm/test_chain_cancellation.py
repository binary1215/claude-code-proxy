"""Measure disconnect propagation through pristine LiteLLM and the built proxy.

Only loopback synthetic inference is used. A failed chain observation is reported
as a failure, not treated as an expected-pass assertion or gateway patch request.
"""
from __future__ import annotations

import argparse
import ast
from contextlib import contextmanager
from datetime import datetime, timezone
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
import select
import socket
import subprocess
import sys
import tempfile
import threading
import time

import yaml

BASE = Path(__file__).resolve().parent
REPO = BASE.parent.parent
DEADLINE_MS = 8000
PROMPT_MS = 2000
MODEL = 'synthetic-cancellation-model'
ALLOWED_ENV = {'PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'PATHEXT'}


def source_identities():
    """Reuse the existing independent pinned-tag identities without importing its runner."""
    tree = ast.parse((BASE / 'test_stock_gateway.py').read_text(encoding='utf-8'))
    expected = next(ast.literal_eval(node.value) for node in tree.body if isinstance(node, ast.Assign)
                    and any(isinstance(target, ast.Name) and target.id == 'EXPECTED' for target in node.targets))
    package = Path(importlib.util.find_spec('litellm').origin).resolve().parent.parent
    result = {}
    for relative, wanted in expected.items():
        content = (package / relative).read_bytes().replace(b'\r\n', b'\n')
        actual = hashlib.sha1(b'blob ' + str(len(content)).encode() + b'\0' + content).hexdigest()
        result[relative] = {'actual': actual, 'expected': wanted, 'matches_tag': actual == wanted}
    return result


def event(kind, body):
    return ('event: ' + kind + '\ndata: ' + json.dumps(body) + '\n\n').encode()


class Fake(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['content-length'])))
        record = {'started': time.perf_counter(), 'closed': None, 'path': self.path,
                  'model_matches': body.get('model') == MODEL, 'stream': body.get('stream') is True}
        with self.server.lock:
            self.server.records.append(record)
        self.send_response(200)
        self.send_header('content-type', 'text/event-stream')
        self.send_header('cache-control', 'no-store')
        self.send_header('connection', 'close')
        self.end_headers()
        initial = event('message_start', {'type': 'message_start', 'message': {
            'id': 'msg_local_cancellation', 'type': 'message', 'role': 'assistant', 'model': MODEL,
            'content': [], 'stop_reason': None, 'stop_sequence': None,
            'usage': {'input_tokens': 1, 'output_tokens': 0}}})
        initial += event('content_block_start', {'type': 'content_block_start', 'index': 0,
                                                'content_block': {'type': 'text', 'text': ''}})
        initial += event('content_block_delta', {'type': 'content_block_delta', 'index': 0,
                                                'delta': {'type': 'text_delta', 'text': 'Started'}})
        try:
            self.wfile.write(initial)
            self.wfile.flush()
            # Keep producing nothing: closure must come from the consumer or its
            # deadline, not fixture completion. Observe TCP EOF/reset directly.
            while not self.server.stopping.is_set():
                readable, _, _ = select.select([self.connection], [], [], 0.05)
                if readable:
                    incoming = self.connection.recv(1, socket.MSG_PEEK)
                    if not incoming:
                        record['closed'] = time.perf_counter()
                        return
                    raise RuntimeError('UNEXPECTED_UPSTREAM_BYTES_AFTER_REQUEST')
        except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError):
            record['closed'] = time.perf_counter()
        finally:
            self.close_connection = True


def start_process(command, cwd, environment):
    process = subprocess.Popen(command, cwd=cwd, env=environment, stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, text=True, encoding='utf-8', errors='replace',
                               creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    lines = queue.Queue()
    def read():
        for line in process.stdout:
            lines.put(line)
    thread = threading.Thread(target=read, daemon=True)
    thread.start()
    return process, lines, thread


def await_line(process, lines, parse, timeout=60):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            line = lines.get(timeout=0.2)
        except queue.Empty:
            if process.poll() is not None:
                raise RuntimeError('LOCAL_CHILD_EXITED_BEFORE_READY')
            continue
        value = parse(line)
        if value is not None:
            return value
    raise RuntimeError('LOCAL_CHILD_START_TIMEOUT')


def stop_processes(processes):
    while processes:
        process, reader = processes.pop()
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        reader.join(2)
        process.stdout.close()


@contextmanager
def local_runtime(processes):
    # Windows retains a child's current working directory until it exits.
    # Stop owned children before TemporaryDirectory removes their runtime.
    with tempfile.TemporaryDirectory(prefix='claude-proxy-chain-cancel-') as runtime:
        try:
            yield runtime
        finally:
            stop_processes(processes)


def history(port, key):
    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=2)
    try:
        connection.request('GET', '/history', headers={'authorization': 'Bearer ' + key})
        response = connection.getresponse()
        if response.status != 200:
            raise RuntimeError('LOCAL_HISTORY_PROBE_FAILED')
        return json.loads(response.read())['rows']
    finally:
        connection.close()


def measure(label, protocol, port, route, key, fake, probe_port, probe_key):
    before = history(probe_port, probe_key)
    expected_id = before[-1]['id'] + 1 if before else 1
    first_index = len(fake.records)
    body = ({'model': MODEL, 'max_tokens': 2048, 'stream': True,
             'messages': [{'role': 'user', 'content': 'Slow synthetic response'}]} if protocol == 'messages'
            else {'model': MODEL, 'store': False, 'stream': True, 'input': 'Slow synthetic response'})
    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
    disconnected = None
    try:
        connection.request('POST', route, body=json.dumps(body), headers={
            'content-type': 'application/json', 'authorization': 'Bearer ' + key,
            'anthropic-version': '2023-06-01', 'accept': 'text/event-stream'})
        response = connection.getresponse()
        status = response.status
        initial = response.read1(512)
        if status != 200 or not initial:
            raise RuntimeError('LOCAL_STREAM_NOT_STARTED')
        pending_row = next((row for row in history(probe_port, probe_key) if row['id'] == expected_id), None)
        current_socket = connection.sock or response.fp.raw._sock
        disconnected = time.perf_counter()
        current_socket.shutdown(socket.SHUT_RDWR)
        response.close()
    finally:
        connection.close()
    first_terminal = None
    final_row = None
    prompt_snapshot = None
    end = disconnected + DEADLINE_MS / 1000 + 3
    while time.perf_counter() < end:
        rows = history(probe_port, probe_key)
        final_row = next((row for row in rows if row['id'] == expected_id), None)
        record = fake.records[first_index] if len(fake.records) > first_index else None
        if final_row and final_row['status'] != 'pending' and first_terminal is None:
            first_terminal = time.perf_counter()
        elapsed = (time.perf_counter() - disconnected) * 1000
        if elapsed >= PROMPT_MS and prompt_snapshot is None:
            prompt_snapshot = {'history_status': final_row['status'] if final_row else None,
                               'upstream_socket_closed': bool(record and record['closed'])}
        if record and record['closed'] is not None and first_terminal is not None:
            break
        time.sleep(0.025)
    records = fake.records[first_index:]
    record = records[0] if records else None
    close_ms = round((record['closed'] - disconnected) * 1000, 2) if record and record['closed'] else None
    terminal_ms = round((first_terminal - disconnected) * 1000, 2) if first_terminal else None
    passed = (len(records) == 1 and record['path'] == '/v1/messages' and record['model_matches'] and record['stream']
              and pending_row and pending_row['status'] == 'pending'
              and close_ms is not None and 0 <= close_ms <= PROMPT_MS
              and terminal_ms is not None and terminal_ms <= PROMPT_MS
              and final_row and final_row['status'] == 'cancelled'
              and final_row['upstream_diagnostic'] == 'cancelled')
    return {'label': label, 'protocol': protocol, 'http_status': status, 'received_sse_bytes': len(initial),
            'client_socket_shutdown': True, 'fake_request_count': len(records),
            'upstream_path': record['path'] if record else None,
            'upstream_model_matches': record['model_matches'] if record else False,
            'upstream_stream_requested': record['stream'] if record else False,
            'history_status_before_disconnect': pending_row['status'] if pending_row else None,
            'upstream_socket_close_after_disconnect_ms': close_ms,
            'history_finalized_after_disconnect_ms': terminal_ms,
            'observation_at_prompt_bound': prompt_snapshot,
            'final_history': final_row, 'prompt_cancellation_pass': bool(passed)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--node', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    report_path = args.output / 'chain-cancellation.json'
    if report_path.exists():
        raise SystemExit('Refusing to overwrite an existing observation')
    before = source_identities()
    if importlib.metadata.version('litellm') != '1.103.1' or not all(v['matches_tag'] for v in before.values()):
        raise SystemExit('Not pristine pinned LiteLLM 1.103.1')
    report = {'schema_version': 1, 'scope': 'loopback synthetic inference through stock LiteLLM and built proxy',
              'observed_at_utc': datetime.now(timezone.utc).isoformat(),
              'litellm_version': importlib.metadata.version('litellm'), 'before': before, 'cases': [],
              'proxy_deadline_ms': DEADLINE_MS, 'prompt_cancellation_bound_ms': PROMPT_MS,
              'runtime': {name: importlib.metadata.version(name) for name in ('fastapi', 'starlette', 'uvicorn', 'httpx', 'prisma')},
              'real_provider_calls': 0, 'gateway_source_patched': False, 'proxy_source_patched_by_harness': False,
              'harness_sha256': {name: hashlib.sha256((BASE / name).read_bytes()).hexdigest()
                                 for name in ('test_chain_cancellation.py', 'boot_cancellation_relay.mjs', 'boot_gateway.py')},
              'built_proxy_sha256': {name: hashlib.sha256((REPO / name).read_bytes()).hexdigest()
                                     for name in ('dist/app.js', 'dist/services/nativeRelay.js',
                                                  'dist/services/responsesRelay.js', 'dist/services/responsesState.js',
                                                  'dist/services/responsesRequest.js')},
              'limitations': ['Synthetic server is not Anthropic generation or billing.',
                              'Windows loopback runtime and current dependency versions; not deployed Linux container.',
                              'A pass establishes observed socket closure and local cancellation, not provider billing cessation.']}
    fake = ThreadingHTTPServer(('127.0.0.1', 0), Fake)
    fake.records = []
    fake.lock = threading.Lock()
    fake.stopping = threading.Event()
    fake_thread = threading.Thread(target=fake.serve_forever, daemon=True)
    fake_thread.start()
    processes = []
    local_key = None
    try:
        with local_runtime(processes) as runtime:
            env = {k: v for k, v in os.environ.items() if k.upper() in ALLOWED_ENV}
            relay, lines, reader = start_process([str(args.node.resolve()), str(BASE / 'boot_cancellation_relay.mjs'),
                                                  'http://127.0.0.1:' + str(fake.server_port), str(DEADLINE_MS)], REPO, env)
            processes.append((relay, reader))
            def relay_ready(line):
                try:
                    item = json.loads(line)
                    return item if isinstance(item, dict) and 'relay_port' in item else None
                except ValueError:
                    return None
            info = await_line(relay, lines, relay_ready)
            local_key = info['local_key']
            gateway_key = 'sk-' + secrets.token_hex(32)
            proxy_base = 'http://127.0.0.1:' + str(info['relay_port'])
            config = {'model_list': [], 'litellm_settings': {'telemetry': False, 'num_retries': 0, 'callbacks': []},
                      'router_settings': {'num_retries': 0}, 'general_settings': {
                          'master_key': 'os.environ/LOCAL_GATEWAY_KEY', 'pass_through_endpoints': [
                              {'path': '/claude-' + label + '/v1/' + protocol,
                               'target': proxy_base + '/v1/' + protocol, 'auth': True, 'methods': ['POST'],
                               'forward_headers': True, 'include_subpath': False,
                               'headers': {'Authorization': 'os.environ/LOCAL_RELAY_AUTHORIZATION', 'x-api-key': '',
                                           'anthropic-version': '2023-06-01'}}
                              for label, protocol in [('native', 'messages'), ('responses', 'responses')]]}}
            config_path = Path(runtime) / 'gateway.yaml'
            config_path.write_text(yaml.safe_dump(config, sort_keys=False), encoding='utf-8')
            gateway_env = {**env, 'CONFIG_FILE_PATH': str(config_path), 'LOCAL_GATEWAY_KEY': gateway_key,
                           'LOCAL_RELAY_AUTHORIZATION': 'Bearer ' + local_key, 'LITELLM_LOCAL_MODEL_COST_MAP': 'True',
                           'PYTHONDONTWRITEBYTECODE': '1'}
            gateway, gateway_lines, gateway_reader = start_process([sys.executable, str(BASE / 'boot_gateway.py')], runtime, gateway_env)
            processes.append((gateway, gateway_reader))
            gateway_port = await_line(gateway, gateway_lines, lambda line: int(line.split('=', 1)[1]) if line.startswith('LOCAL_GATEWAY_PORT=') else None)
            # Listener ownership precedes ASGI startup; probe readiness without invoking a model.
            deadline = time.monotonic() + 60
            while True:
                connection = http.client.HTTPConnection('127.0.0.1', gateway_port, timeout=1)
                try:
                    connection.request('GET', '/health/liveliness')
                    response = connection.getresponse()
                    response.read()
                    if response.status == 200:
                        break
                except (OSError, http.client.HTTPException):
                    pass
                finally:
                    connection.close()
                if time.monotonic() >= deadline or gateway.poll() is not None:
                    raise RuntimeError('LOCAL_GATEWAY_READINESS_FAILED')
                time.sleep(0.1)
            for protocol in ('messages', 'responses'):
                report['cases'].append(measure('direct-proxy-control', protocol, info['relay_port'], '/v1/' + protocol,
                                                local_key, fake, info['history_port'], local_key))
                label = 'native' if protocol == 'messages' else 'responses'
                report['cases'].append(measure('stock-litellm-chain', protocol, gateway_port,
                                                '/claude-' + label + '/v1/' + protocol, gateway_key,
                                                fake, info['history_port'], local_key))
                print(json.dumps(report['cases'][-2:]), flush=True)
            report['direct_controls_pass'] = all(c['prompt_cancellation_pass'] for c in report['cases'] if c['label'] == 'direct-proxy-control')
            report['chain_cancellation_pass'] = all(c['prompt_cancellation_pass'] for c in report['cases'] if c['label'] == 'stock-litellm-chain')
    except Exception as error:
        # Keep exception text out of reports: startup logs can include generated credentials.
        report['execution_error_type'] = type(error).__name__
        report['chain_cancellation_pass'] = False
    finally:
        stop_processes(processes)
        fake.stopping.set()
        fake.shutdown()
        fake.server_close()
        fake_thread.join(2)
        report['after'] = source_identities()
        report['source_unchanged'] = report['before'] == report['after']
        report['fake_request_count'] = len(fake.records)
        report['status'] = ('pass' if len(report['cases']) == 4 and report.get('direct_controls_pass') and report.get('chain_cancellation_pass')
                            and report['source_unchanged'] else 'failed')
        report_path.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print('Report: ' + str(report_path), flush=True)
    return 0 if report['status'] == 'pass' else 1


if __name__ == '__main__':
    raise SystemExit(main())
