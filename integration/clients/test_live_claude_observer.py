"""Offline regressions for the live observer; no client, network or credentials.

Run: python -S -B -m unittest discover -s integration/clients -p test_live_claude_observer.py
"""
import copy
import json
from pathlib import Path
from types import SimpleNamespace
import unittest

import claude_code_live_smoke as observer


MARKER = 'CLAUDE_LIVE_FIXTURE_0123456789abcdef01234567'


def input_stream(partial_json):
    events = [
        {'type': 'message_start', 'message': {'usage': {'input_tokens': 7, 'cache_read_input_tokens': 11}}},
        {'type': 'content_block_start', 'index': 0, 'content_block': {
            'type': 'tool_use', 'id': 'synthetic-tool', 'name': 'Read', 'input': {'initial': 'keep'}}},
        {'type': 'content_block_delta', 'index': 0,
         'delta': {'type': 'input_json_delta', 'partial_json': partial_json}},
        {'type': 'message_delta', 'delta': {'stop_reason': 'tool_use'},
         'usage': {'input_tokens': None, 'cache_read_input_tokens': None, 'output_tokens': 5}},
        {'type': 'message_stop'},
    ]
    return ''.join('data: ' + json.dumps(event) + '\r\n\r\n' for event in events).encode()


def partial_replay_state():
    # This path is only a synthetic value; tests never read or write it.
    state = observer.CallState(Path('synthetic-fixture.txt'), MARKER, deployed_gateway=True)
    first = [
        {'type': 'thinking', 'thinking': 'synthetic thought', 'signature': 'synthetic signature'},
        {'type': 'tool_use', 'id': 'synthetic-tool', 'name': 'Read', 'input': {'file_path': 'synthetic-fixture.txt'}},
    ]
    replay = {'messages': [
        {'role': 'assistant', 'content': copy.deepcopy(first)},
        {'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': 'synthetic-tool', 'content': MARKER}]},
    ]}
    state.client = [
        {'message': {'content': first}, 'body': {'messages': []}, 'status': 200},
        {'message': {'content': [{'type': 'text', 'text': 'READ_CONFIRMED: ' + MARKER}]},
         'body': replay, 'status': 200},
    ]
    state.outgoing_calls = 2
    return state


class LiveClaudeObserverTests(unittest.TestCase):
    def test_marker_accepts_whitespace_and_formatting_in_client_result(self):
        for text in (MARKER, 'READ_CONFIRMED: ' + MARKER, 'FOLLOWUP_CONFIRMED:\n' + MARKER,
                     'The marker is `' + MARKER + '`.', '**' + MARKER + '**'):
            with self.subTest(text=text):
                self.assertTrue(observer.marker_retrieved(text, MARKER))
                result = SimpleNamespace(returncode=0, stdout=json.dumps({
                    'type': 'result', 'subtype': 'success', 'is_error': False, 'result': text}))
                self.assertTrue(observer.client_result(result, MARKER)['successful_final'])

    def test_marker_rejects_missing_wrong_case_extended_and_conflicting_values(self):
        for text in (None, '', 'missing', MARKER.lower(), MARKER + 'x', 'x' + MARKER,
                     'CLAUDE_LIVE_FIXTURE_wrong', MARKER + ' CLAUDE_LIVE_FIXTURE_wrong'):
            with self.subTest(text=text):
                self.assertFalse(observer.marker_retrieved(text, MARKER))

    def test_empty_input_delta_preserves_input_and_null_usage_preserves_counts(self):
        message = observer.parse_sse(input_stream(''))
        self.assertEqual(message['content'][0]['input'], {'initial': 'keep'})
        self.assertEqual(observer.usage_counts(message['usage']), {
            'input_tokens': 7, 'cache_read_input_tokens': 11, 'output_tokens': 5})
        self.assertEqual(observer.parse_sse(input_stream('{}'))['content'][0]['input'], {})

    def test_nonempty_malformed_input_delta_is_rejected(self):
        for partial in (' ', '{', '{"unterminated":'):
            with self.subTest(partial=partial):
                with self.assertRaisesRegex(observer.Failure, '^native_sse_invalid$'):
                    observer.parse_sse(input_stream(partial))

    def test_shape_projection_explains_caller_removal_without_exposing_values(self):
        returned = [
            {'type': 'thinking', 'thinking': 'private-test-thought', 'signature': 'private-test-signature'},
            {'type': 'tool_use', 'id': 'private-test-id', 'name': 'Read',
             'input': {'private-test-input-key': 'private-test-input'}, 'caller': {'type': 'direct'}},
            {'type': 'text', 'text': 'private-test-text'},
        ]
        replayed = copy.deepcopy(returned)
        del replayed[1]['caller']
        shape = observer.replay_shape(returned, replayed)
        self.assertEqual(shape['returned_types'], ['thinking', 'tool_use', 'text'])
        self.assertEqual(shape['returned_types'], shape['replayed_types'])
        self.assertEqual(len(shape['block_differences']), 1)
        self.assertEqual(shape['block_differences'][0]['known_fields_removed'], ['caller'])
        self.assertEqual(shape['block_differences'][0]['known_fields_changed'], [])
        self.assertTrue(shape['tool_id_name_input_exact'])
        self.assertTrue(shape['concatenated_text_exact'])
        self.assertNotIn('private-test-', json.dumps(shape))
        regrouped = observer.replay_shape(
            [{'type': 'text', 'text': 'a'}, {'type': 'text', 'text': 'b'}], [{'type': 'text', 'text': 'ab'}])
        self.assertTrue(regrouped['concatenated_text_exact'])

    def test_partial_signature_success_does_not_claim_missing_followup(self):
        report = observer.observations(partial_replay_state())
        self.assertTrue(report['observed_signed_state_pass'])
        self.assertIsNone(report['signed_state_pass'])
        self.assertEqual(report['signed_state_status'], 'preserved_partial')
        self.assertEqual(report['replay_coverage'], {'Read': 'observed', 'user_followup': 'unobserved'})
        self.assertTrue(report['replays'][0]['signed_blocks_preserved'])
        self.assertFalse(report['native_ingress_observed'])
        self.assertIsNone(report['gateway_comparisons'])

    def test_observed_signature_change_is_failure_even_with_partial_coverage(self):
        state = partial_replay_state()
        state.client[1]['body']['messages'][0]['content'][0]['signature'] = 'changed synthetic signature'
        report = observer.observations(state)
        self.assertFalse(report['observed_signed_state_pass'])
        self.assertFalse(report['signed_state_pass'])
        self.assertEqual(report['signed_state_status'], 'changed')
        self.assertEqual(report['replay_coverage']['user_followup'], 'unobserved')


if __name__ == '__main__':
    unittest.main()
