"""Actual stock Claude Code coding loop through stock LiteLLM and the native relay.

Only synthetic credentials, loopback services, and a newly created temp project.
This tests real local tools, not real-provider reasoning, entitlement or billing.
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
import shlex
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

from codex_patch_smoke import Fake as StreamFixture, MODEL, ROOT, clean_env, identities, start, stop

MARKER = 'CLAUDE_CODING_WORKFLOW_OK'
INITIAL = {
    'math.cjs': 'exports.add = (a, b) => a - b;\n',
    'label.cjs': "exports.label = (value) => 'wrong=' + value;\n",
    'test.cjs': """const assert = require('node:assert/strict');
const { add } = require('./math.cjs');
const { label } = require('./label.cjs');
try {
  assert.equal(add(2, 3), 5);
  assert.equal(label(add(2, 3)), 'total=5');
  console.log('WORKFLOW_TEST_PASS');
} catch (error) {
  console.error('WORKFLOW_TEST_FAIL');
  throw error;
}
""",
}
EXPECTED = {**INITIAL, 'math.cjs': 'exports.add = (a, b) => a + b;\n',
            'label.cjs': "exports.label = (value) => 'total=' + value;\n"}


def actions(workspace, command):
    return [
        ('Read', {'file_path': str(workspace / 'math.cjs')}),
        ('Read', {'file_path': str(workspace / 'label.cjs')}),
        ('Bash', {'command': command, 'description': 'Run the isolated fixture tests before repair'}),
        ('Edit', {'file_path': str(workspace / 'math.cjs'), 'old_string': INITIAL['math.cjs'].strip(),
                  'new_string': EXPECTED['math.cjs'].strip()}),
        ('Edit', {'file_path': str(workspace / 'label.cjs'), 'old_string': INITIAL['label.cjs'].strip(),
                  'new_string': EXPECTED['label.cjs'].strip()}),
        ('Bash', {'command': command, 'description': 'Rerun the isolated fixture tests after repair'}),
    ]


def text_content(content):
    if isinstance(content, str):
        return content
    return '\n'.join(block.get('text', '') for block in content or [] if isinstance(block, dict))


def inspect_result(result, index):
    """A successful process exit/final message alone cannot pass this test."""
    if result.get('tool_use_id') != f'toolu_coding_{index}':
        return False
    text = text_content(result.get('content'))
    if index == 2:
        return result.get('is_error') is True and 'WORKFLOW_TEST_FAIL' in text
    if index == 5:
        return not result.get('is_error') and 'WORKFLOW_TEST_PASS' in text
    if index in (0, 1):
        return not result.get('is_error') and INITIAL['math.cjs' if index == 0 else 'label.cjs'].strip() in text
    return not result.get('is_error')


def blocks(body, role, kind=None):
    return [block for message in body.get('messages', []) if message.get('role') == role
            and isinstance(message.get('content'), list) for block in message['content']
            if isinstance(block, dict) and (kind is None or block.get('type') == kind)]


def exact_replay(body, issued):
    # Claude may append cache_control to history; it is not signed content.
    actual = [{k: v for k, v in block.items() if k != 'cache_control'}
              for block in blocks(body, 'assistant') if block.get('type') != 'text']
    return actual == issued


def replay_compatibility(body, issued):
    """Separate signed-state fidelity from the observed stock Edit default.

    Claude Code 2.1.289 adds replace_all:false to Edit input when omitted. Only
    that exact addition is accepted; changed explicit values/other fields fail.
    Non-text equality (excluding cache_control) remains a separate observation.
    """
    actual = [{k: v for k, v in block.items() if k != 'cache_control'}
              for block in blocks(body, 'assistant') if block.get('type') != 'text']
    reasoning = lambda values: [block for block in values if block.get('type') in ('thinking', 'redacted_thinking')]
    normalized = copy.deepcopy(actual)
    if len(normalized) == len(issued):
        for received, expected in zip(normalized, issued):
            if (expected.get('type') == 'tool_use' and expected.get('name') == 'Edit'
                    and 'replace_all' not in expected.get('input', {})
                    and received.get('input', {}).get('replace_all') is False):
                del received['input']['replace_all']
    return {'reasoning_exact': reasoning(actual) == reasoning(issued),
            'tool_replay_compatible': normalized == issued, 'non_text_exact': actual == issued}


class Fake(StreamFixture):
    def do_POST(self):
        size = int(self.headers.get('content-length', '0'))
        if self.path.split('?')[0] != '/v1/messages' or not 0 < size < 2 * 1024 * 1024:
            self.send_error(400); return
        raw = self.rfile.read(size)
        body = json.loads(raw)
        index = len(self.server.requests)
        self.server.requests.append(body)
        self.server.auth.append(self.headers.get('x-api-key') == 'sk-ant-local-fake-only'
                                and not self.headers.get('authorization'))
        self.server.leaks.append(any(key and (key.encode() in raw or key in self.path
                                 or any(key in value for value in self.headers.values()))
                                 for key in self.server.local_keys))
        if index > len(self.server.actions) or body.get('model') != MODEL or body.get('stream') is not True:
            self.server.failure = 'unexpected_request'; self.send_error(400); return
        names = {tool.get('name') for tool in body.get('tools', [])}
        if not {'Read', 'Edit', 'Bash'} <= names:
            self.server.failure = 'ordinary_coding_tools_missing'; self.send_error(400); return
        if index:
            results = blocks(body, 'user', 'tool_result')
            matching = [value for value in results if value.get('tool_use_id') == f'toolu_coding_{index - 1}']
            result_ok = len(matching) == 1 and inspect_result(matching[0], index - 1)
            self.server.result_checks.append(result_ok)
            replay = replay_compatibility(body, self.server.issued)
            self.server.non_text_replay_checks.append(replay['non_text_exact'])
            self.server.reasoning_checks.append(replay['reasoning_exact'])
            self.server.replay_checks.append(replay['tool_replay_compatible'])
            if not result_ok:
                self.server.failure = f'tool_result_failed_at_{index - 1}'
                self.send_error(400); return
        if index == len(self.server.actions):
            self.stream([{'type': 'text', 'text': MARKER}], 'end_turn'); return
        name, arguments = self.server.actions[index]
        content = [
            {'type': 'thinking', 'thinking': f'Synthetic coding step {index}.', 'signature': f'fixture-signature-{index}+/='},
            {'type': 'thinking', 'thinking': '', 'signature': f'fixture-empty-{index}+/='},
            {'type': 'redacted_thinking', 'data': f'fixture-redacted-{index}+/='},
            {'type': 'tool_use', 'id': f'toolu_coding_{index}', 'name': name, 'input': arguments},
        ]
        self.server.issued.extend(copy.deepcopy(content))
        self.stream(content, 'tool_use')


class Observer(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_CONNECT(self):
        self.send_error(403)

    def do_GET(self):
        self.send_error(404)

    def do_POST(self):
        size = int(self.headers.get('content-length', '0'))
        if self.path.split('?')[0] != '/claude-native/v1/messages' or not 0 < size < 2 * 1024 * 1024:
            self.send_error(400); return
        raw = self.rfile.read(size)
        record = {'request': json.loads(raw)}
        self.server.records.append(record)
        connection = http.client.HTTPConnection('127.0.0.1', self.server.target_port, timeout=30)
        try:
            headers = {k: v for k, v in self.headers.items()
                       if k.lower() not in {'host', 'connection', 'accept-encoding', 'transfer-encoding'}}
            headers['accept-encoding'] = 'identity'
            connection.request('POST', self.path, raw, headers)
            response = connection.getresponse()
            record['status'] = response.status
            self.send_response(response.status)
            for name, value in response.getheaders():
                if name.lower() not in {'server', 'date', 'content-length', 'connection', 'transfer-encoding'}:
                    self.send_header(name, value)
            self.send_header('connection', 'close'); self.end_headers()
            while chunk := response.read1(8192):
                self.wfile.write(chunk); self.wfile.flush()
        finally:
            connection.close()


def qualify(report):
    return (report.get('exit_code') == 0 and report.get('final_exact') is True
            and report.get('files_exact') is True and report.get('independent_test_pass') is True
            and report.get('upstream_requests') == 7 and report.get('gateway_requests') == 7
            and report.get('result_checks') == [True] * 6 and report.get('replay_checks') == [True] * 6
            and report.get('reasoning_checks') == [True] * 6 and report.get('native_messages_exact') is True
            and report.get('http_statuses') == [200] * 7 and report.get('source_unchanged') is True
            and report.get('synthetic_upstream_auth') is True and report.get('credential_leak') is False
            and report.get('fixture_failure') is None)


def files_match(workspace):
    try:
        return all((workspace / name).read_bytes() == value.encode() for name, value in EXPECTED.items())
    except OSError:
        return False


def source_matches(before):
    try:
        return identities() == before
    except Exception:
        return False


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--claude', type=Path, required=True)
    parser.add_argument('--node', type=Path, required=True)
    parser.add_argument('--bash', type=Path, help='Existing Git Bash on Windows; no installation or permission changes')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    if output.exists() or Path(tempfile.gettempdir()).resolve() not in output.parents or ROOT in output.parents:
        raise SystemExit('Use a NEW directory under system temp, outside the repository')
    node = args.node.resolve(strict=True); claude = args.claude.resolve(strict=True)
    bash = args.bash.resolve(strict=True) if args.bash else None
    before = identities()
    if importlib.metadata.version('litellm') != '1.103.1':
        raise SystemExit('Use the existing pristine LiteLLM 1.103.1 Python environment')
    output.mkdir(parents=True)
    workspace = output / 'workspace'; workspace.mkdir()
    state = output / 'claude-state'; state.mkdir()
    for name, contents in INITIAL.items():
        (workspace / name).write_text(contents, encoding='utf-8', newline='\n')
    command = shlex.quote(node.as_posix()) + ' test.cjs'
    gateway_key = 'sk-local-workflow-' + secrets.token_hex(24)
    relay_key = None
    report = {'scope': 'actual Claude Code -> stock LiteLLM -> native relay -> synthetic provider',
              'litellm_version': '1.103.1', 'not_tested': ['real provider acceptance', 'billing or real cache reuse',
              'automatic compaction', 'session resume', 'OS-enforced network isolation'], 'before': before}
    children = []; servers = []

    def redact(value):
        for key in [gateway_key, relay_key]:
            if key:
                value = value.replace(key, '[LOCAL_FIXTURE_KEY]')
        return value

    def serve(handler):
        server = ThreadingHTTPServer(('127.0.0.1', 0), handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start(); servers.append((server, thread)); return server

    fake = serve(Fake)
    fake.requests = []; fake.auth = []; fake.issued = []; fake.replay_checks = []; fake.result_checks = []
    fake.non_text_replay_checks = []; fake.reasoning_checks = []
    fake.leaks = []; fake.local_keys = [gateway_key]
    fake.failure = None; fake.actions = actions(workspace, command)
    observer = None
    try:
        def relay_ready(line):
            try:
                result = json.loads(line)
                if result.get('local_relay_port') and result.get('local_relay_key'):
                    return result
            except ValueError:
                pass
        child, thread, logs, ready = start([str(node), str(ROOT / 'integration/clients/boot_responses_relay.mjs'),
            f'http://127.0.0.1:{fake.server_port}'], clean_env(output), output, relay_ready, 20)
        children.append((child, thread, logs, 'relay.log')); relay_key = ready['local_relay_key']
        fake.local_keys.append(relay_key)
        import yaml
        config = {'litellm_settings': {'telemetry': False, 'num_retries': 0, 'callbacks': []},
                  'general_settings': {'master_key': 'os.environ/LOCAL_GATEWAY_KEY', 'pass_through_endpoints': [{
                      'path': '/claude-native/v1/messages', 'target': f"http://127.0.0.1:{ready['local_relay_port']}/v1/messages",
                      'auth': True, 'methods': ['POST'], 'forward_headers': True,
                      'headers': {'Authorization': 'os.environ/LOCAL_RELAY_AUTHORIZATION', 'x-api-key': ''}}]}}
        config_path = output / 'gateway.yaml'; config_path.write_text(yaml.safe_dump(config), encoding='utf-8')
        env = clean_env(output)
        env.update(CONFIG_FILE_PATH=str(config_path), LOCAL_GATEWAY_KEY=gateway_key,
                   LOCAL_RELAY_AUTHORIZATION='Bearer ' + relay_key, LITELLM_LOCAL_MODEL_COST_MAP='True')
        child, thread, logs, port = start([sys.executable, str(ROOT / 'integration/litellm/boot_gateway.py')],
            env, output, lambda line: int(line.strip().split('=')[1]) if line.startswith('LOCAL_GATEWAY_PORT=') else None, 45)
        children.append((child, thread, logs, 'gateway.log'))
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({})); deadline = time.monotonic() + 30
        while True:
            try:
                opener.open(f'http://127.0.0.1:{port}/health/liveliness', timeout=.5).close(); break
            except Exception:
                if time.monotonic() > deadline:
                    raise RuntimeError('gateway_start_timeout')
                time.sleep(.2)
        observer = serve(Observer); observer.target_port = port; observer.records = []
        url = f'http://127.0.0.1:{observer.server_port}'
        settings = output / 'settings.json'
        settings.write_text(json.dumps({'permissions': {'allow': ['Read(./**)', 'Edit(./**)', f'Bash({command})']},
                                       'hooks': {}, 'autoMemoryEnabled': False}), encoding='utf-8')
        env = clean_env(output)
        env.update(CLAUDE_CONFIG_DIR=str(state), ANTHROPIC_BASE_URL=url + '/claude-native', ANTHROPIC_API_KEY=gateway_key,
                   ANTHROPIC_MODEL=MODEL, ANTHROPIC_DEFAULT_HAIKU_MODEL=MODEL, ANTHROPIC_DEFAULT_SONNET_MODEL=MODEL,
                   HTTP_PROXY=url, HTTPS_PROXY=url, ALL_PROXY=url, NO_PROXY='127.0.0.1,localhost',
                   CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1', CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL='1',
                   CLAUDE_CODE_DISABLE_CLAUDE_MDS='1', CLAUDE_CODE_DISABLE_POLICY_SKILLS='1', CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS='1',
                   CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK='1', CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING='1',
                   CLAUDE_CODE_DISABLE_CRON='1', CLAUDE_CODE_MAX_RETRIES='0', ENABLE_TOOL_SEARCH='false',
                   DISABLE_AUTOUPDATER='1', DISABLE_TELEMETRY='1', DISABLE_ERROR_REPORTING='1', MAX_THINKING_TOKENS='1024')
        if bash:
            env['CLAUDE_CODE_GIT_BASH_PATH'] = str(bash)
        version = subprocess.check_output([str(claude), '--version'], env=env, cwd=workspace, text=True, timeout=15).strip()
        report['claude_version'] = version
        if not version.startswith('2.1.289 '):
            raise RuntimeError('pinned_Claude_Code_2.1.289_required')
        with claude.open('rb') as file:
            report['claude_sha256'] = hashlib.file_digest(file, 'sha256').hexdigest()
        cmd = [str(claude), '-p', 'Read the two source files, run test.cjs, fix both bugs, rerun the tests and finish with ' + MARKER,
               '--model', MODEL, '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
               '--allowedTools', 'Read(./**)', 'Edit(./**)', f'Bash({command})', '--permission-mode', 'dontAsk',
               '--settings', str(settings), '--setting-sources', '', '--no-session-persistence', '--strict-mcp-config',
               '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands', '--max-turns', '10']
        result = subprocess.run(cmd, cwd=workspace, env=env, capture_output=True, text=True, encoding='utf-8',
                                errors='replace', timeout=120, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        (output / 'client-events.jsonl').write_text(redact(result.stdout), encoding='utf-8')
        (output / 'client-stderr.log').write_text(redact(result.stderr), encoding='utf-8')
        events = [json.loads(line) for line in result.stdout.splitlines() if line.startswith('{')]
        finals = [event for event in events if event.get('type') == 'result']
        report.update(exit_code=result.returncode, final_exact=len(finals) == 1 and not finals[0].get('is_error')
                      and finals[0].get('subtype') == 'success' and finals[0].get('result') == MARKER)
        independent = subprocess.run([str(node), 'test.cjs'], cwd=workspace, env=clean_env(output),
                                     capture_output=True, text=True, timeout=10)
        report['independent_test_pass'] = independent.returncode == 0 and independent.stdout.strip() == 'WORKFLOW_TEST_PASS'
    except Exception as error:
        report['harness_error'] = type(error).__name__  # Do not print startup logs/credentials.
    finally:
        for child, thread, logs, name in reversed(children):
            stop(child); thread.join(3); child.stdout.close()
            (output / name).write_text(redact(''.join(logs)), encoding='utf-8')
        for server, thread in reversed(servers):
            server.shutdown(); server.server_close(); thread.join(3)
        report.update(files_exact=files_match(workspace),
                      upstream_requests=len(fake.requests), gateway_requests=len(observer.records) if observer else 0,
                      result_checks=fake.result_checks, replay_checks=fake.replay_checks, fixture_failure=fake.failure,
                      non_text_replay_checks=fake.non_text_replay_checks, reasoning_checks=fake.reasoning_checks,
                      observed_client_normalization='Edit adds replace_all:false when omitted; cache_control placement may change',
                      native_messages_exact=bool(observer) and len(observer.records) == len(fake.requests)
                      and all(record['request'].get('messages') == body.get('messages')
                              for record, body in zip(observer.records, fake.requests)),
                      synthetic_upstream_auth=bool(fake.auth) and all(fake.auth),
                      credential_leak=any(fake.leaks),
                      http_statuses=[record.get('status') for record in observer.records] if observer else [],
                      source_unchanged=source_matches(before))
        report['pass'] = qualify(report)
        (output / 'native-requests.json').write_text(redact(json.dumps(fake.requests, ensure_ascii=False, indent=2)), encoding='utf-8')
        (output / 'claude-coding-workflow.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps(report, indent=2))
    return 0 if report['pass'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
