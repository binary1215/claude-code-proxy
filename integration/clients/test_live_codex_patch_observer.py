"""Pure stdlib checks; no Codex process, listeners, credentials or live calls."""
import json
import unittest

from codex_patch_live_smoke import (
    CONTENT, PATCHES, Failure, State, capsules, completed_output, fake_response,
    offered_tools, patch_offer, request_summary, usage_only,
)


def request(namespace=None):
    tool = {'type': 'custom', 'name': 'apply_patch', 'format': {'type': 'grammar', 'syntax': 'lark', 'definition': 'synthetic'}}
    return {'tools': [tool] if namespace is None else [{'type': 'namespace', 'name': namespace, 'tools': [tool]}], 'input': []}


class LivePatchObserverTests(unittest.TestCase):
    def test_offline_custom_calls_use_exact_create_update_patches(self):
        for phase in ('create', 'update'):
            for namespace in (None, 'functions'):
                with self.subTest(phase=phase, namespace=namespace):
                    record = {'wire': fake_response(phase, 0, request(namespace))}
                    output = completed_output(record)
                    self.assertEqual(output[1]['type'], 'custom_tool_call')
                    self.assertEqual(output[1]['input'], PATCHES[phase])
                    self.assertEqual(output[1].get('namespace'), namespace)
                    self.assertEqual(len(capsules(output)), 1)
                    self.assertIn('OFFLINE_SYNTHETIC_OPAQUE_', output[0]['encrypted_content'])
        self.assertEqual(CONTENT['create'], b'SYNTHETIC_PATCH_CREATED\n')
        self.assertEqual(CONTENT['update'], b'SYNTHETIC_PATCH_UPDATED\n')

    def test_offline_final_requires_actual_matching_tool_result_shape(self):
        body = request()
        with self.assertRaises(Failure):
            fake_response('create', 1, body)
        body['input'] = [{'type': 'custom_tool_call_output', 'call_id': 'call_offline_create', 'output': 'synthetic result'}]
        output = completed_output({'wire': fake_response('create', 1, body)})
        self.assertEqual(output[0]['type'], 'message')
        self.assertEqual(output[0]['content'][0]['text'], 'CODEX_LIVE_PATCH_CREATE_OK')

    def test_patch_offer_supports_flat_and_namespaced_tools(self):
        self.assertEqual(len(patch_offer(request())), 1)
        self.assertEqual(patch_offer(request('functions'))[0][1], 'functions')
        self.assertEqual(offered_tools({'tools': []}), [])
        body = request()
        body['tools'][0]['format']['syntax'] = 'unknown'
        self.assertEqual(patch_offer(body), [])

    def test_four_request_cap_and_per_phase_cap_need_no_network(self):
        for offline in (True, False):
            with self.subTest(offline=offline):
                state = State(offline, 'synthetic-only')
                for phase in ('create', 'update'):
                    state.phase = phase
                    state.reserve(b'{}', {})
                    state.reserve(b'{}', {})
                    with self.assertRaises(Failure):
                        state.reserve(b'{}', {})
                self.assertEqual(len(state.records), 4)
                self.assertEqual(state.outgoing_attempts, 0 if offline else 4)

    def test_previous_failure_prevents_new_reservation(self):
        state = State(False, 'synthetic-only')
        state.fail('http_response_failed')
        with self.assertRaises(Failure):
            state.reserve(b'{}', {})
        self.assertEqual(state.outgoing_attempts, 0)

    def test_exact_opaque_done_completed_and_replay_are_observations(self):
        body = request()
        record = {'phase': 'create', 'request': body, 'wire': fake_response('create', 0, body), 'status': 200, 'finished': True}
        first = request_summary(record, [])
        self.assertTrue(first['reasoning_done_completed_exact'])
        self.assertIsNone(first['prior_reasoning_replay_exact'])
        issued = capsules(completed_output(record))
        body['input'] = [completed_output(record)[0], {'type': 'custom_tool_call_output', 'call_id': 'call_offline_create', 'output': 'synthetic'}]
        following = {**record, 'wire': fake_response('create', 1, body)}
        second = request_summary(following, issued)
        self.assertTrue(second['prior_reasoning_replay_exact'])
        self.assertIsNone(second['reasoning_done_completed_exact'])
        self.assertTrue(second['marker_present'])
        body['input'][0]['encrypted_content'] = 'changed'
        self.assertFalse(request_summary(following, issued)['prior_reasoning_replay_exact'])

    def test_failure_projection_never_exports_free_form_error(self):
        event = {'type': 'response.failed', 'response': {'error': {'code': 'PRIVATE_SENTINEL', 'message': 'PRIVATE_SENTINEL'}}}
        record = {'phase': 'create', 'request': {}, 'wire': ('data: ' + json.dumps(event) + '\n\n').encode(), 'status': 200, 'finished': True}
        summary = request_summary(record, [])
        self.assertEqual(summary['failure_codes'], ['unrecognized_sse_failure'])
        self.assertNotIn('PRIVATE_SENTINEL', json.dumps(summary))

    def test_usage_unknown_and_bool_are_not_fabricated_zero_counts(self):
        self.assertTrue(all(value is None for value in usage_only({}).values()))
        summary = usage_only({'anthropic_usage': {'input_tokens': True, 'cache_read_input_tokens': 7},
                              'usage': {'input_tokens': 10, 'output_tokens': False}})
        self.assertIsNone(summary['native_input_tokens'])
        self.assertEqual(summary['cache_read_input_tokens'], 7)
        self.assertEqual(summary['input_tokens'], 10)
        self.assertIsNone(summary['output_tokens'])


if __name__ == '__main__':
    unittest.main()
