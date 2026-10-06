"""Pure offline OpenCode-observer regressions; no client/network/runtime reads.

Run: python -S -B -m unittest discover -s integration/clients -p test_live_opencode_observer.py
All messages, markers, signatures and error prose below are synthetic fixtures.
"""
import copy
import json
import unittest

import opencode_live_smoke as observer


MARKER = 'OPENCODE_LIVE_0123456789abcdef0123456789abcdef'
OTHER_MARKER = 'OPENCODE_LIVE_fedcba9876543210fedcba9876543210'


def sse(events):
    return ''.join('data: ' + json.dumps(event, ensure_ascii=False) + '\r\n\r\n'
                   for event in events).encode('utf-8')


def input_stream(fragments, initial=None):
    block = {'type': 'tool_use', 'id': 'synthetic-read', 'name': 'read',
             'input': {} if initial is None else copy.deepcopy(initial)}
    events = [
        {'type': 'message_start', 'message': {'content': [], 'usage': {
            'input_tokens': 7, 'cache_read_input_tokens': 11, 'cache_creation_input_tokens': 13}}},
        {'type': 'content_block_start', 'index': 0, 'content_block': block},
    ]
    events += [{'type': 'content_block_delta', 'index': 0,
                'delta': {'type': 'input_json_delta', 'partial_json': fragment}}
               for fragment in fragments]
    events += [
        {'type': 'content_block_stop', 'index': 0},
        {'type': 'message_delta', 'delta': {'stop_reason': 'tool_use'}, 'usage': {
            'input_tokens': None, 'cache_read_input_tokens': None,
            'cache_creation_input_tokens': None, 'output_tokens': 5}},
        {'type': 'message_stop'},
    ]
    return sse(events)


def cli_result(texts):
    events = [{'type': 'text', 'sessionID': 'ses_synthetic', 'part': {'text': text}} for text in texts]
    events.append({'type': 'step_finish', 'sessionID': 'ses_synthetic', 'part': {
        'reason': 'stop', 'tokens': {'input': 7, 'output': 5, 'cache': {'read': 11, 'write': 13}}}})
    return {'exit_code': 0, 'timed_out': False, 'overflow': False, 'stopped_on_observer_failure': False,
            'stdout': ('\n'.join(json.dumps(event) for event in events) + '\n').encode('utf-8'),
            'stderr': b''}


def error_body(message, error_type='invalid_request_error', details=None):
    return json.dumps({'error': {'type': error_type, 'message': message, 'details': details}}).encode('utf-8')


class MarkerTests(unittest.TestCase):
    def test_accepts_whitespace_prose_and_markdown(self):
        for text in (MARKER, 'READ_CONFIRMED: ' + MARKER, 'FOLLOWUP_CONFIRMED:\n\n' + MARKER,
                     'The synthetic marker is `' + MARKER + '`.', '**' + MARKER + '**',
                     '  ' + MARKER + '\t\n', MARKER + '\n' + MARKER):
            with self.subTest(text=text):
                self.assertTrue(observer.exact_fixture_marker(text, MARKER))
                summary, session = observer.client_events(cli_result([text]), MARKER)
                self.assertTrue(summary['functional_pass'])
                self.assertEqual(session, 'ses_synthetic')

    def test_rejects_missing_modified_or_embedded_tokens(self):
        for text in ('', 'No marker here.', MARKER[:-1], MARKER.lower(), MARKER + '0',
                     MARKER + 'x', MARKER + '_suffix', 'prefix_' + MARKER,
                     'x' + MARKER, OTHER_MARKER, 'OPENCODE_LIVE_'):
            with self.subTest(text=text):
                self.assertFalse(observer.exact_fixture_marker(text, MARKER))
                summary, _ = observer.client_events(cli_result([text]), MARKER)
                self.assertFalse(summary['functional_pass'])

    def test_rejects_conflicting_marker_even_with_correct_one(self):
        for conflicting in (OTHER_MARKER, MARKER[:-1], MARKER.lower(), 'OPENCODE_LIVE_wrong'):
            with self.subTest(conflicting=conflicting):
                self.assertFalse(observer.exact_fixture_marker(MARKER + ' / ' + conflicting, MARKER))
                summary, _ = observer.client_events(cli_result([MARKER, conflicting]), MARKER)
                self.assertFalse(summary['final_marker_present'])

    def test_marker_can_be_before_a_later_explanation_event(self):
        summary, _ = observer.client_events(cli_result(['READ_CONFIRMED: **' + MARKER + '**', 'Done.']), MARKER)
        self.assertTrue(summary['functional_pass'])
        serialized = json.dumps(summary)
        self.assertNotIn(MARKER, serialized)
        self.assertNotIn('ses_synthetic', serialized)

    def test_rejects_invalid_expected_marker(self):
        for expected in ('READ_CONFIRMED:' + MARKER, 'OPENCODE_LIVE_short', MARKER.upper()):
            with self.subTest(expected=expected):
                self.assertFalse(observer.exact_fixture_marker(expected, expected))


class NativeParserTests(unittest.TestCase):
    def test_empty_json_delta_preserves_initial_empty_object(self):
        for fragments in ([], [''], ['', '']):
            with self.subTest(fragments=fragments):
                message, signatures = observer.parse_sse(input_stream(fragments))
                self.assertEqual(message['content'][0]['input'], {})
                self.assertEqual(signatures, [])

    def test_empty_json_delta_does_not_erase_existing_initial_input(self):
        initial = {'filePath': 'synthetic-fixture.txt', 'offset': 1}
        message, _ = observer.parse_sse(input_stream(['', ''], initial=initial))
        self.assertEqual(message['content'][0]['input'], initial)

    def test_nonempty_json_is_assembled_including_interleaved_empty_deltas(self):
        message, _ = observer.parse_sse(input_stream(['', '{"filePath":', '', '"synthetic-fixture.txt"}', '']))
        self.assertEqual(message['content'][0]['input'], {'filePath': 'synthetic-fixture.txt'})

    def test_nonempty_malformed_json_is_not_replaced_with_empty_object(self):
        for fragments in ([' '], ['{'], ['{"filePath":'], ['{bad}'], ['{}', 'trailing']):
            with self.subTest(fragments=fragments):
                with self.assertRaisesRegex(observer.Failure, '^native_sse_invalid$'):
                    observer.parse_sse(input_stream(fragments))

    def test_null_usage_updates_preserve_prior_counts(self):
        message, _ = observer.parse_sse(input_stream(['']))
        self.assertEqual(observer.usage_counts(message['usage']), {
            'input_tokens': 7, 'output_tokens': 5, 'cache_read_input_tokens': 11,
            'cache_creation_input_tokens': 13})

    def test_split_signatures_signed_empty_and_redacted_order(self):
        events = [{'type': 'message_start', 'message': {'content': [], 'usage': {}}}]
        for index, text, pieces in ((0, 'Synthetic 생각 🧪', ['synthetic-', 'first-signature']),
                                    (1, '', ['synthetic-empty-', 'signature'])):
            events.append({'type': 'content_block_start', 'index': index,
                           'content_block': {'type': 'thinking', 'thinking': ''}})
            events.append({'type': 'content_block_delta', 'index': index,
                           'delta': {'type': 'thinking_delta', 'thinking': text}})
            for piece in pieces:
                events.append({'type': 'content_block_delta', 'index': index,
                               'delta': {'type': 'signature_delta', 'signature': piece}})
            events.append({'type': 'content_block_stop', 'index': index})
        events += [
            {'type': 'content_block_start', 'index': 2,
             'content_block': {'type': 'redacted_thinking', 'data': 'synthetic-opaque-data'}},
            {'type': 'content_block_stop', 'index': 2},
            {'type': 'message_delta', 'delta': {'stop_reason': 'end_turn'}, 'usage': {'output_tokens': 3}},
            {'type': 'message_stop'},
        ]
        message, counts = observer.parse_sse(sse(events))
        self.assertEqual(counts, [2, 2])
        self.assertEqual(message['content'], [
            {'type': 'thinking', 'thinking': 'Synthetic 생각 🧪', 'signature': 'synthetic-first-signature'},
            {'type': 'thinking', 'thinking': '', 'signature': 'synthetic-empty-signature'},
            {'type': 'redacted_thinking', 'data': 'synthetic-opaque-data'},
        ])


class ErrorDiagnosticTests(unittest.TestCase):
    def test_synthetic_third_party_usage_restriction(self):
        message = ('Synthetic fixture: third-party work draws from extra usage; '
                   'a Claude plan is not the selected allowance.')
        self.assertEqual(observer.error_diagnostics(error_body(message)), {
            'error_type': 'invalid_request_error', 'reason': 'third_party_plan_usage_restriction'})

    def test_known_reason_enums_use_synthetic_error_prose(self):
        cases = [
            ('Synthetic fixture: OAuth authentication is currently not supported here.', 'oauth_authentication_not_supported'),
            ('Synthetic fixture: this credential is only authorized for use with Claude Code.', 'credential_limited_to_claude_code'),
            ('Synthetic fixture: invalid beta option selected.', 'invalid_beta_option'),
            ('Synthetic fixture: thinking budget must be a supported test value.', 'invalid_thinking_option'),
            ('Synthetic fixture: max_tokens must exceed the test minimum.', 'invalid_max_tokens'),
        ]
        for message, reason in cases:
            with self.subTest(reason=reason):
                self.assertEqual(observer.error_diagnostics(error_body(message)), {
                    'error_type': 'invalid_request_error', 'reason': reason})

    def test_version_reason_uses_closed_error_code(self):
        result = observer.error_diagnostics(error_body('Synthetic version mismatch.', details={
            'error_code': 'claude_code_version_too_old'}))
        self.assertEqual(result, {'error_type': 'invalid_request_error', 'reason': 'client_version_too_old'})

    def test_unknown_error_does_not_export_message_type_or_canary(self):
        canary = 'SYNTHETIC_DO_NOT_EXPORT_012345'
        result = observer.error_diagnostics(error_body('Synthetic unknown failure: ' + canary, error_type=canary))
        self.assertEqual(result, {'error_type': None, 'reason': 'unclassified_provider_error'})
        self.assertNotIn(canary, json.dumps(result))
        self.assertEqual(set(result), {'error_type', 'reason'})

    def test_unknown_shapes_and_non_json_are_safely_classified(self):
        for wire in (b'<html>synthetic-private-error</html>', b'[]', b'{"error":{"details":17}}'):
            with self.subTest(wire=wire):
                self.assertEqual(observer.error_diagnostics(wire), {
                    'error_type': None, 'reason': 'non_json_or_unknown_error_shape'})
        self.assertEqual(observer.error_diagnostics(b'{"error":"synthetic-private-error"}'), {
            'error_type': None, 'reason': 'unclassified_provider_error'})

    def test_unrelated_extra_usage_phrase_does_not_claim_restriction(self):
        result = observer.error_diagnostics(error_body('Synthetic fixture: extra usage counter unavailable.'))
        self.assertEqual(result['reason'], 'unclassified_provider_error')


if __name__ == '__main__':
    unittest.main()
