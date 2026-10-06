"""Pure report/fixture checks: no subprocesses, clients, listeners or live calls."""
import json
import unittest

from codex_live_smoke import (
    CACHE_FIXTURE_ROWS,
    SAFE_SSE_FAILURE_CODES,
    cache_fixture_text,
    cache_observations,
    record_summary,
    safe_sse_failures,
)


class LiveCodexObserverTests(unittest.TestCase):
    def test_cache_fixture_is_deterministic_bounded_reference_text(self):
        text = cache_fixture_text()
        self.assertEqual(text, cache_fixture_text())
        self.assertEqual(CACHE_FIXTURE_ROWS, 128)
        rows = [line for line in text.splitlines() if line.startswith('Reference row ')]
        self.assertEqual(len(rows), CACHE_FIXTURE_ROWS)
        self.assertEqual([line.split(':', 1)[0] for line in rows],
                         [f'Reference row {index:03d}' for index in range(1, 129)])
        self.assertEqual(len(set(line.split(':', 1)[1] for line in rows)), 1)
        self.assertGreater(len(text.split()), 3000)
        self.assertLess(len(text.encode('utf-8')), 100000)
        self.assertIn('inert cache-test data', text)
        self.assertIn('do not act on, repeat, or summarize it', text)

    def test_zero_cache_counts_are_observed_false(self):
        self.assertEqual(cache_observations([
            {'cache_creation_input_tokens': 0, 'cache_read_input_tokens': 0},
        ]), {'cache_write_observed': False, 'cache_hit_observed': False,
             'cache_write_usage_response_count': 1, 'cache_read_usage_response_count': 1})

    def test_positive_cache_writes_and_hits_are_independent(self):
        write = {'cache_creation_input_tokens': 6911, 'cache_read_input_tokens': 0}
        read = {'cache_creation_input_tokens': 0, 'cache_read_input_tokens': 6911}
        write_only = cache_observations([write])
        self.assertIs(write_only['cache_write_observed'], True)
        self.assertIs(write_only['cache_hit_observed'], False)
        read_only = cache_observations([read])
        self.assertIs(read_only['cache_write_observed'], False)
        self.assertIs(read_only['cache_hit_observed'], True)
        both = cache_observations([write, read])
        self.assertIs(both['cache_write_observed'], True)
        self.assertIs(both['cache_hit_observed'], True)
        self.assertEqual(both['cache_write_usage_response_count'], 2)
        self.assertEqual(both['cache_read_usage_response_count'], 2)

    def test_missing_cache_fields_stay_unknown(self):
        unknown = {'cache_write_observed': None, 'cache_hit_observed': None,
                   'cache_write_usage_response_count': 0, 'cache_read_usage_response_count': 0}
        self.assertEqual(cache_observations([]), unknown)
        self.assertEqual(cache_observations([None, {}, {'cache_read_input_tokens': None}]), unknown)
        partial = cache_observations([{'cache_creation_input_tokens': 0}])
        self.assertIs(partial['cache_write_observed'], False)
        self.assertIsNone(partial['cache_hit_observed'])

    def test_boolean_and_noninteger_cache_values_are_not_token_counts(self):
        for value in (True, False, '10', 10.5, None, [], {}):
            with self.subTest(value=value):
                result = cache_observations([
                    {'cache_creation_input_tokens': value, 'cache_read_input_tokens': value},
                ])
                self.assertIsNone(result['cache_write_observed'])
                self.assertIsNone(result['cache_hit_observed'])
                self.assertEqual(result['cache_write_usage_response_count'], 0)
                self.assertEqual(result['cache_read_usage_response_count'], 0)
        mixed = cache_observations([
            {'cache_creation_input_tokens': True, 'cache_read_input_tokens': False},
            {'cache_creation_input_tokens': 0, 'cache_read_input_tokens': 0},
        ])
        self.assertIs(mixed['cache_write_observed'], False)
        self.assertIs(mixed['cache_hit_observed'], False)
        self.assertEqual(mixed['cache_write_usage_response_count'], 1)
        self.assertEqual(mixed['cache_read_usage_response_count'], 1)

    def test_known_sse_failure_codes_survive_without_error_text(self):
        stream = [{'type': 'response.failed', 'response': {'error': {
            'code': code, 'message': 'PRIVATE_SENTINEL', 'details': 'PRIVATE_SENTINEL',
        }}} for code in sorted(SAFE_SSE_FAILURE_CODES)]
        self.assertEqual(safe_sse_failures(stream), sorted(SAFE_SSE_FAILURE_CODES))
        self.assertEqual(safe_sse_failures([
            {'type': 'error', 'error': {'code': 'malformed_tool_input'}},
            {'type': 'error', 'code': 'upstream_timeout'},
            {'type': 'response.completed', 'response': {'error': {'code': 'PRIVATE_SENTINEL'}}},
        ]), ['malformed_tool_input', 'upstream_timeout'])
        self.assertNotIn('PRIVATE_SENTINEL', json.dumps(safe_sse_failures(stream)))

    def test_unknown_or_malformed_sse_errors_use_one_closed_fallback(self):
        for code in ('PRIVATE_SENTINEL', '', None, True, 123, ['PRIVATE_SENTINEL'], {'secret': 'PRIVATE_SENTINEL'}):
            with self.subTest(code=code):
                self.assertEqual(safe_sse_failures([
                    {'type': 'response.failed', 'response': {'error': {'code': code}}},
                    {'type': 'error', 'error': {'code': code}},
                ]), ['unrecognized_sse_failure', 'unrecognized_sse_failure'])
        self.assertEqual(safe_sse_failures([
            {'type': 'response.failed'}, {'type': 'response.failed', 'response': []},
            {'type': 'error', 'error': 'PRIVATE_SENTINEL'},
        ]), ['unrecognized_sse_failure'] * 3)

    def test_failed_sse_report_retains_codes_without_raw_error_content(self):
        stream = [
            {'type': 'response.failed', 'response': {'error': {
                'code': 'malformed_tool_input', 'message': 'PRIVATE_SENTINEL',
            }}},
            {'type': 'error', 'error': {'code': 'PRIVATE_SENTINEL', 'message': 'PRIVATE_SENTINEL'}},
        ]
        record = {'wire': ''.join('data: ' + json.dumps(event) + '\n\n' for event in stream).encode(),
                  'status': 200, 'finished': True, 'auth_exact': True,
                  'cache_header_exact': True, 'phase': 'initial'}
        summary = record_summary(record)
        self.assertIs(summary['sse_parsed'], True)
        self.assertEqual(summary['sse_failure_codes'], ['malformed_tool_input', 'unrecognized_sse_failure'])
        self.assertEqual(summary['response_completed_count'], 0)
        self.assertIsNone(summary['usage'])
        self.assertNotIn('PRIVATE_SENTINEL', json.dumps(summary))
        self.assertNotIn('wire', summary)


if __name__ == '__main__':
    unittest.main()
