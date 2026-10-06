"""Pure offline observer tests; no client processes, network or credential reads."""
import copy
import json
from pathlib import Path
import tempfile
import unittest

import opencode_responses_live_smoke as observer


MARKER = 'OPENCODE_LIVE_0123456789abcdef0123456789abcdef'
KEY = 'synthetic-key-only'


def request():
    return {'model': observer.MODEL, 'stream': True, 'store': False,
            'input': [{'role': 'user', 'content': 'Synthetic read fixture.'}],
            'include': ['reasoning.encrypted_content'],
            'tools': [{'type': 'function', 'name': 'read', 'parameters': {'type': 'object'}}]}


def headers():
    return {'authorization': 'Bearer ' + KEY, 'user-agent': 'opencode/1.18.34 synthetic-test'}


def new_state(offline=True):
    return observer.State(Path(tempfile.gettempdir()) / 'synthetic-fixture.txt', MARKER, KEY, offline)


def reserve(state, body=None):
    value = request() if body is None else body
    return state.reserve(value, json.dumps(value).encode(), headers())


def sse(values):
    return ''.join('event: ' + v['type'] + '\r\ndata: ' + json.dumps(v) + '\r\n\r\n' for v in values).encode()


def completed(items):
    response = {'id': 'resp_synthetic', 'status': 'completed', 'output': items,
                'usage': {'input_tokens': 15, 'output_tokens': 4, 'total_tokens': 19,
                          'input_tokens_details': {'cached_tokens': 3, 'cache_write_tokens': 2}},
                'anthropic_usage': {'input_tokens': 10, 'output_tokens': 4,
                                    'cache_read_input_tokens': 3, 'cache_creation_input_tokens': 2}}
    return sse([{'type': 'response.output_item.done', 'item': item} for item in items]
               + [{'type': 'response.completed', 'response': response}])


class ConfigTests(unittest.TestCase):
    def test_exact_existing_route_only(self):
        for base in ('http://192.168.0.7:4000/claude-responses', 'http://192.168.0.7:4000/claude-responses/v1/'):
            self.assertEqual(observer.gateway_target(base), ('192.168.0.7', 4000, '/claude-responses/v1/responses'))
        for base in ('http://192.168.0.64:13457/v1', 'http://192.168.0.7:4000/v1',
                     'http://192.168.0.7:4000/claude-native', 'http://user@192.168.0.7:4000/claude-responses',
                     'http://192.168.0.7:4000/claude-responses?key=synthetic'):
            with self.subTest(base=base), self.assertRaises(observer.Failure):
                observer.gateway_target(base)

    def test_bundled_responses_provider_preserves_native_model_and_prompt(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            env = observer.isolated_env(folder, folder / 'opencode.exe', folder / 'fixture.txt',
                                        'http://127.0.0.1:12345', KEY)
            config = json.loads(env['OPENCODE_CONFIG_CONTENT'])
            self.assertEqual(config['model'], 'openai/' + observer.MODEL)
            self.assertEqual(config['enabled_providers'], ['openai'])
            self.assertEqual(set(config['provider']), {'openai'})
            provider = config['provider']['openai']
            self.assertNotIn('npm', provider)
            self.assertEqual(provider['options']['baseURL'], 'http://127.0.0.1:12345/claude-responses/v1')
            self.assertEqual(provider['options']['apiKey'], '{env:OPENCODE_LIVE_GATEWAY_TOKEN}')
            model = provider['models'][observer.MODEL]
            self.assertEqual(model['options'], {'store': False, 'include': ['reasoning.encrypted_content']})
            self.assertNotIn('headers', model)
            self.assertNotIn('system', config)
            self.assertNotIn('agent', config)
            self.assertNotIn(KEY, env['OPENCODE_CONFIG_CONTENT'])
            self.assertEqual(config['permission']['*'], 'deny')
            self.assertEqual(env['OPENCODE_DISABLE_AUTOUPDATE'], 'true')
            self.assertEqual(env['npm_config_registry'], 'http://127.0.0.1:12345/offline-npm/')


class StateTests(unittest.TestCase):
    def test_live_attempt_reserved_before_any_connection(self):
        state = new_state(False); record = reserve(state)
        self.assertEqual(state.outgoing, 1)
        self.assertTrue(state.active)
        self.assertIsNone(record['status'])

    def test_offline_never_counts_real_gateway_attempts(self):
        state = new_state(); reserve(state)
        self.assertEqual(state.outgoing, 0)

    def test_stops_after_http_sse_or_transport_error(self):
        for error in ('gateway_http_failure', 'responses_sse_error', 'observer_transport_failure'):
            state = new_state(False); reserve(state); state.active = False; state.fail(error)
            with self.subTest(error=error), self.assertRaisesRegex(observer.Failure, 'stopped_after_failure'):
                reserve(state)
            self.assertEqual(state.outgoing, 1)
            self.assertEqual(state.blocked_model_attempts, 1)

    def test_model_protocol_store_tool_and_auth_guards(self):
        changes = [{'model': 'not-approved'}, {'stream': False}, {'store': True}, {'input': 'not-list'},
                   {'tools': [{'type': 'function', 'name': 'bash'}]}, {'tools': [{'type': 'custom', 'name': 'read'}]}]
        for change in changes:
            body = request(); body.update(change)
            with self.subTest(change=change), self.assertRaises(observer.Failure):
                reserve(new_state(), body)
        with self.assertRaisesRegex(observer.Failure, 'unexpected_gateway_key'):
            new_state().reserve(request(), b'{}', {'authorization': 'Bearer unrelated-synthetic-key'})

    def test_duplicate_and_concurrent_attempts_rejected(self):
        state = new_state(False); reserve(state)
        with self.assertRaisesRegex(observer.Failure, 'concurrent_model_attempt'):
            reserve(state)
        state.active = False
        with self.assertRaisesRegex(observer.Failure, 'duplicate_request_attempt'):
            reserve(state)
        self.assertEqual(state.outgoing, 1)

    def test_read_three_followup_one_total_four(self):
        state = new_state(False)
        for index in range(3):
            body = request(); body['input'][0]['content'] += str(index)
            reserve(state, body); state.active = False
        with self.assertRaisesRegex(observer.Failure, 'phase_request_limit'):
            reserve(state)
        state.phase = 'followup'
        body = request(); body['input'][0]['content'] += 'followup'; reserve(state, body); state.active = False
        with self.assertRaisesRegex(observer.Failure, 'gateway_request_limit'):
            reserve(state)
        self.assertEqual(state.outgoing, 4)

    def test_unknown_fields_forwarded_unchanged_and_inventoried(self):
        state = new_state(); body = request(); body['synthetic_unknown'] = {'private': 'synthetic-value'}
        record = reserve(state, body)
        self.assertEqual(record['body'], body)
        report = observer.observations(state)
        self.assertEqual(report['responses'][0]['unknown_inventory_fields'], ['synthetic_unknown'])
        self.assertNotIn('synthetic-value', json.dumps(report))

    def test_first_request_probe_never_reserves_second_gateway_call(self):
        state = observer.State(Path(tempfile.gettempdir()) / 'fixture.txt', MARKER, KEY, False, True)
        reserve(state); state.active = False
        body = request(); body['input'][0]['content'] += 'attempt-two'
        with self.assertRaisesRegex(observer.Failure, 'gateway_request_limit'):
            reserve(state, body)
        self.assertEqual(state.outgoing, 1)

    def test_accepted_probe_never_claims_functional_or_multiturn_pass(self):
        state = new_state(False); record = reserve(state)
        record.update(status=200, response_complete=True, response_bytes_forwarded_unchanged=True)
        state.fail('first_request_probe_complete')
        first = {'exit_code': 1, 'timed_out': False, 'overflow': False, 'stopped_on_observer_failure': True}
        report = observer.first_request_evidence(state, first)
        self.assertTrue(report['first_request_accepted'])
        self.assertTrue(report['first_request_probe_complete'])
        self.assertTrue(report['expected_probe_stop'])
        self.assertFalse(report['functional_pass'])
        self.assertFalse(report['multi_turn_tested'])
        self.assertIsNone(report['harness_error'])

    def test_failed_probe_keeps_error_and_does_not_call_incomplete_sse_accepted(self):
        first = {'exit_code': 1, 'timed_out': False, 'overflow': False, 'stopped_on_observer_failure': True}
        for status in (400, 403, 200):
            state = new_state(False); record = reserve(state)
            record.update(status=status, response_complete=False, response_bytes_forwarded_unchanged=True)
            state.fail('responses_sse_error' if status == 200 else 'gateway_http_failure')
            report = observer.first_request_evidence(state, first)
            self.assertFalse(report['first_request_accepted'])
            self.assertFalse(report['functional_pass'])
            self.assertIsNotNone(report['harness_error'])


class ResponseTests(unittest.TestCase):
    def test_stream_completed_done_and_usage(self):
        items = [{'type': 'reasoning', 'id': 'rs_synthetic', 'encrypted_content': 'synthetic-opaque', 'summary': []}]
        response, done = observer.parse_response(completed(items))
        self.assertEqual(done, items)
        self.assertEqual(response['output'], items)
        usage = observer.usages(response)
        self.assertEqual(usage['input_tokens'], 15)
        self.assertEqual(usage['anthropic_usage']['input_tokens'], 10)
        self.assertEqual(usage['anthropic_usage']['cache_read_input_tokens'], 3)

    def test_incomplete_error_and_invalid_streams_rejected(self):
        for wire, code in ((b'', 'responses_sse_incomplete'),
                           (sse([{'type': 'response.failed', 'response': {'error': {'code': 'upstream_error'}}}]), 'responses_sse_error'),
                           (b'data: not-json\n\n', 'responses_sse_invalid')):
            with self.subTest(code=code), self.assertRaisesRegex(observer.Failure, code):
                observer.parse_response(wire)

    def test_id_omission_is_distinguished_from_ciphertext_loss(self):
        state = new_state(); first = reserve(state); state.active = False
        item = {'type': 'reasoning', 'id': 'rs_synthetic', 'encrypted_content': 'SYNTHETIC_PRIVATE_OPAQUE', 'summary': []}
        first['response'], first['done'] = observer.parse_response(completed([item]))
        body = request(); replay = copy.deepcopy(item); replay.pop('id'); body['input'].append(replay)
        reserve(state, body)
        report = observer.observations(state); check = report['replays'][0]
        self.assertFalse(check['opaque_reasoning_exact'])
        self.assertFalse(check['reasoning_ids_exact'])
        self.assertTrue(check['reasoning_ciphertexts_exact'])
        self.assertEqual(check['reasoning_id_present'], [False])
        for private in ('SYNTHETIC_PRIVATE_OPAQUE', 'rs_synthetic', KEY, MARKER):
            self.assertNotIn(private, json.dumps(report))

    def test_json_tool_arguments_semantics_separate_from_serialization(self):
        first = [{'call_id': 'call_synthetic', 'name': 'read', 'arguments': '{"filePath": "fixture.txt"}'}]
        second = [{'call_id': 'call_synthetic', 'name': 'read', 'arguments': '{"filePath":"fixture.txt"}'}]
        self.assertNotEqual(observer.function_identity(first), observer.function_identity(second))
        self.assertEqual(observer.function_identity(first, True), observer.function_identity(second, True))

    def test_closed_error_codes_and_provider_reason_no_private_text(self):
        wire = json.dumps({'error': {'type': 'invalid_request_error', 'code': 'invalid_reasoning_state',
                                    'message': 'SYNTHETIC_PRIVATE_DETAIL'}}).encode()
        result = observer.error_diagnostics(wire)
        self.assertEqual(result['adapter_error_code'], 'invalid_reasoning_state')
        self.assertNotIn('SYNTHETIC_PRIVATE_DETAIL', json.dumps(result))
        wire = json.dumps({'error': {'type': 'invalid_request_error', 'code': 'SYNTHETIC_PRIVATE_CODE',
            'message': 'Synthetic third-party Claude plan use draws from extra usage.'}}).encode()
        result = observer.error_diagnostics(wire)
        self.assertEqual(result['reason'], 'third_party_plan_usage_restriction')
        self.assertIsNone(result['adapter_error_code'])
        self.assertNotIn('SYNTHETIC_PRIVATE_CODE', json.dumps(result))

    def test_fake_native_uses_real_parser_and_all_opaque_types(self):
        wire, expected = observer.fake_native_events(new_state(), 0)
        message, counts = observer.native.parse_sse(wire)
        self.assertEqual(message['content'], expected)
        self.assertEqual(counts, [1, 1])
        self.assertEqual([b['type'] for b in expected], ['thinking', 'thinking', 'redacted_thinking', 'tool_use'])
        self.assertEqual(expected[1]['thinking'], '')


if __name__ == '__main__':
    unittest.main()
