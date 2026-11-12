#!/usr/bin/env python3
"""Opt-in Responses compact round trip through an existing gateway.

No request runs without --live. Keys, history and opaque state stay in memory;
only fixed diagnostics, counts and numeric usage are printed or saved. This is
an API contract probe, not a claim that Codex selects /responses/compact.

Example (supply the key through the environment or the first stdin line):
  python3 responses_compact_live.py --live --key-stdin \
      --base-url http://gateway:4000/v1 --model claude-opus-5-5-responses-han \
      --pause-after-second-compact --report /private/compact-report.json

When the second compact finishes, the optional pause emits a safe readiness
record. The operator may restart the proxy and then write `continue` on stdin.
The harness does not restart services or claim a restart it did not observe.
"""
from __future__ import annotations

import argparse
import http.client
import json
import os
from pathlib import Path
import secrets
import sys
import time
from urllib.parse import urlsplit

DEFAULT_MODEL = 'claude-opus-5-5-responses-han'
ENV_KEY = 'CLAUDE_PROXY_GATEWAY_KEY'
MAX_RESPONSE_BYTES = 8 * 1024 * 1024
INSTRUCTIONS = (
    'You are checking a small project ledger. Use read_ledger once when asked. '
    'Preserve exact project facts and tool evidence for later questions. '
    'Only use the supplied tool; take no external action. '
    'When asked for JSON, return a JSON object without Markdown fences.'
)
TOOLS = [{'type': 'function', 'name': 'read_ledger',
          'description': 'Read the authoritative project ledger fixture.',
          'parameters': {'type': 'object', 'properties': {}, 'additionalProperties': False}}]


class Failure(Exception):
    """Fixed, non-sensitive diagnostic codes only."""


def endpoint(base: str) -> tuple[str, str, int, str]:
    parsed = urlsplit(base)
    if (parsed.scheme not in {'http', 'https'} or not parsed.hostname
            or parsed.username is not None or parsed.password is not None
            or parsed.query or parsed.fragment or any(ord(c) < 33 for c in base)
            or not parsed.path.rstrip('/').endswith('/v1')):
        raise Failure('invalid_v1_base_url')
    return parsed.scheme, parsed.hostname, parsed.port or (443 if parsed.scheme == 'https' else 80), parsed.path.rstrip('/')


def json_bytes(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8')


def usage_only(value: object) -> dict:
    if not isinstance(value, dict):
        return {}
    result = {}
    for name in ('input_tokens', 'output_tokens', 'total_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'):
        if type(value.get(name)) is int:
            result[name] = value[name]
    for name in ('input_tokens_details', 'output_tokens_details'):
        if isinstance(value.get(name), dict):
            result[name] = {key: number for key, number in value[name].items()
                            if key in {'cached_tokens', 'reasoning_tokens', 'cache_creation_tokens', 'cache_write_tokens'} and type(number) is int}
    return result


def item_counts(items: list) -> dict:
    # Do not include arbitrary provider-supplied strings in reports.
    names = ('message', 'reasoning', 'function_call', 'function_call_output', 'compaction')
    return {name: sum(isinstance(item, dict) and item.get('type') == name for item in items)
            for name in names}


def reasoning_capsules(items: list) -> int:
    return sum(isinstance(item, dict) and item.get('type') == 'reasoning'
               and isinstance(item.get('encrypted_content'), str) and bool(item['encrypted_content']) for item in items)


def output_items(response: dict, *, compact: bool = False) -> list:
    expected = 'response.compaction' if compact else 'response'
    if response.get('object') != expected:
        raise Failure('unexpected_response_object')
    output = response.get('output')
    if not isinstance(output, list) or not output or not all(isinstance(item, dict) for item in output):
        raise Failure('missing_output_items')
    if compact:
        capsules = [item for item in output if item.get('type') == 'compaction']
        if not capsules or any(not isinstance(item.get('encrypted_content'), str) or not item['encrypted_content'] for item in capsules):
            raise Failure('missing_compaction_capsule')
    elif response.get('status') != 'completed':
        raise Failure('response_not_completed')
    return output


def answer_object(items: list) -> dict:
    pieces = []
    for item in items:
        if item.get('type') == 'message' and item.get('role') == 'assistant':
            for part in item.get('content', []):
                if isinstance(part, dict) and part.get('type') == 'output_text' and isinstance(part.get('text'), str):
                    pieces.append(part['text'])
    text = '\n'.join(pieces).strip()
    if text.startswith('```') and text.endswith('```'):
        text = '\n'.join(text.splitlines()[1:-1]).strip()
    try:
        value = json.loads(text)
    except (TypeError, ValueError):
        raise Failure('recall_not_json') from None
    if not isinstance(value, dict):
        raise Failure('recall_not_object')
    return value


class Gateway:
    def __init__(self, base: str, key: str, timeout: int, report: dict):
        self.scheme, self.host, self.port, self.prefix = endpoint(base)
        self.key, self.timeout, self.report = key, timeout, report

    def post(self, suffix: str, body: dict, phase: str) -> dict:
        if len(self.report['requests']) >= 6:
            raise Failure('request_budget_exhausted')
        row = {'phase': phase, 'path': self.prefix + suffix,
               'input_items': len(body['input']), 'input_counts': item_counts(body['input']),
               'replayed_reasoning_capsules': reasoning_capsules(body['input']), 'http_status': None}
        self.report['requests'].append(row)
        conn_type = http.client.HTTPSConnection if self.scheme == 'https' else http.client.HTTPConnection
        conn = conn_type(self.host, self.port, timeout=self.timeout)
        started = time.monotonic()
        try:
            conn.request('POST', self.prefix + suffix, json_bytes(body),
                         {'Authorization': 'Bearer ' + self.key, 'Content-Type': 'application/json'})
            response = conn.getresponse()
            row['http_status'] = response.status
            raw = response.read(MAX_RESPONSE_BYTES + 1)
            if len(raw) > MAX_RESPONSE_BYTES:
                raise Failure('response_size_limit')
            if response.status != 200:
                raise Failure('gateway_http_error')
            try:
                value = json.loads(raw)
            except (UnicodeDecodeError, ValueError):
                raise Failure('gateway_invalid_json') from None
            if not isinstance(value, dict):
                raise Failure('gateway_invalid_object')
            output = output_items(value, compact=suffix.endswith('/compact'))
            row.update(output_items=len(output), output_counts=item_counts(output),
                       returned_reasoning_capsules=reasoning_capsules(output), usage=usage_only(value.get('usage')),
                       input_window_bytes=len(json_bytes(body['input'])), output_window_bytes=len(json_bytes(output)))
            print(json.dumps({'event': 'request_complete', **row}), flush=True)
            return value
        except (OSError, http.client.HTTPException):
            raise Failure('gateway_transport_error') from None
        finally:
            row['elapsed_seconds'] = round(time.monotonic() - started, 3)
            conn.close()


def response_body(model: str, history: list) -> dict:
    return {'model': model, 'instructions': INSTRUCTIONS, 'input': history, 'tools': TOOLS,
            'stream': False, 'store': False, 'max_output_tokens': 4096,
            'include': ['reasoning.encrypted_content'], 'reasoning': {'effort': 'medium'}}


def compact_body(model: str, history: list) -> dict:
    # The public standalone compact contract has no required tools declaration.
    return {'model': model, 'instructions': INSTRUCTIONS, 'input': history}


def user(text: str) -> dict:
    return {'role': 'user', 'content': text}


def run(args: argparse.Namespace, key: str, report: dict) -> None:
    gateway = Gateway(args.base_url, key, args.timeout, report)
    suffix = secrets.token_hex(6)
    facts = {'project': 'project-' + suffix, 'ledger_checksum': 'ledger-' + secrets.token_hex(8),
             'open_items': 17}
    filler = ('Archived fixture note: only the exact project and authoritative ledger facts matter.\n'
              * ((args.padding_chars // 86) + 1))[:args.padding_chars]
    history = [user(f"Project identifier: {facts['project']}. Read the ledger now using read_ledger once. "
                    'After the result, acknowledge that you recorded it; do not repeat the facts.\n' + filler)]
    first = output_items(gateway.post('/responses', response_body(args.model, history), 'tool_request'))
    calls = [item for item in first if item.get('type') == 'function_call']
    if len(calls) != 1 or calls[0].get('name') != 'read_ledger' or not isinstance(calls[0].get('call_id'), str):
        raise Failure('expected_single_ledger_call')
    history += first
    history.append({'type': 'function_call_output', 'call_id': calls[0]['call_id'],
                    'output': json.dumps({key: facts[key] for key in ('ledger_checksum', 'open_items')})})
    second = output_items(gateway.post('/responses', response_body(args.model, history), 'tool_result'))
    if any(item.get('type') == 'function_call' for item in second):
        raise Failure('unexpected_repeat_tool_call')
    history += second
    report['checks']['tool_pair_completed'] = True
    report['checks']['signed_reasoning_observed'] = bool(reasoning_capsules(first + second))
    report['checks']['signed_reasoning_replayed'] = bool(reasoning_capsules(first))

    first_compact = output_items(gateway.post('/responses/compact', compact_body(args.model, history), 'compact_first'), compact=True)
    report['checks']['first_compaction_returned'] = True
    report['checks']['first_window_smaller'] = len(json_bytes(first_compact)) < len(json_bytes(history))
    # Deliberately discard the old window. Only canonical output is carried on.
    history = list(first_compact)
    history.append(user('Without calling any tool, return the recorded project, ledger_checksum and open_items '
                        'as one JSON object with exactly those three keys.'))
    recalled = output_items(gateway.post('/responses', response_body(args.model, history), 'replay_first'))
    report['checks']['first_recall_exact'] = answer_object(recalled) == facts
    if not report['checks']['first_recall_exact']:
        raise Failure('first_recall_mismatch')
    history += recalled

    second_compact = output_items(gateway.post('/responses/compact', compact_body(args.model, history), 'compact_second'), compact=True)
    report['checks']['second_compaction_returned'] = True
    history = list(second_compact)
    if args.pause_after_second_compact:
        print(json.dumps({'event': 'ready_for_operator_restart', 'state_in_memory_only': True,
                          'next_input': 'continue'}), flush=True)
        if sys.stdin.readline().strip() != 'continue':
            raise Failure('operator_continuation_not_received')
        report['operator_pause_completed'] = True
    history.append(user('Again, without a tool, return the original project, ledger_checksum and open_items '
                        'as one JSON object with exactly those three keys.'))
    final = output_items(gateway.post('/responses', response_body(args.model, history), 'replay_second'))
    report['checks']['second_recall_exact'] = answer_object(final) == facts
    if not report['checks']['second_recall_exact']:
        raise Failure('second_recall_mismatch')
    report['functional_pass'] = True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--live', action='store_true')
    parser.add_argument('--base-url', default='http://192.168.0.7:4000/v1')
    parser.add_argument('--model', default=DEFAULT_MODEL)
    parser.add_argument('--key-stdin', action='store_true')
    parser.add_argument('--pause-after-second-compact', action='store_true')
    parser.add_argument('--timeout', type=int, default=180)
    parser.add_argument('--padding-chars', type=int, default=12000)
    parser.add_argument('--report', type=Path)
    args = parser.parse_args(argv)
    if not args.live:
        print(json.dumps({'live': False, 'planned_requests': 6,
                          'phases': ['tool_request', 'tool_result', 'compact_first', 'replay_first', 'compact_second', 'replay_second'],
                          'standalone_api_probe': True, 'key_required_for_live': True}))
        return 0
    report = {'schema_version': 1, 'functional_pass': False, 'standalone_api_probe': True,
              'raw_history_saved': False, 'restart_independently_verified': False,
              'operator_pause_completed': False, 'requests': [], 'checks': {}}
    try:
        if not 1 <= args.timeout <= 600 or not 0 <= args.padding_chars <= 100000:
            raise Failure('invalid_test_bound')
        key = sys.stdin.readline().strip() if args.key_stdin else os.environ.get(ENV_KEY, '').strip()
        if not key or any(ord(c) < 33 for c in key):
            raise Failure('missing_or_invalid_gateway_key')
        run(args, key, report)
    except Failure as exc:
        report['error'] = str(exc)
    except Exception:
        report['error'] = 'unexpected_harness_error'
    print(json.dumps({'event': 'result', **report}), flush=True)
    if args.report:
        args.report.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    return 0 if report['functional_pass'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
