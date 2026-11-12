"""Pure report/fixture checks: no subprocesses, clients, listeners or live calls."""
import json
import argparse
import unittest

from codex_live_smoke import (
    CACHE_FIXTURE_ROWS,
    SAFE_SSE_FAILURE_CODES,
    MODEL,
    PHASE_LIMITS,
    State,
    cache_fixture_text,
    cache_observations,
    record_summary,
    safe_sse_failures,
    gateway_target,
    native_model,
    gateway_route_evidence,
    reasoning_replay_evidence,
    REASONING_FIXTURE_EXPECTED,
    turn_prompt,
    reasoning_fixture_answer_correct,
    signed_replay_qualification,
)


def reasoning_record(done, completed):
    stream = [{'type': 'response.output_item.done', 'item': item} for item in done]
    stream.append({'type': 'response.completed', 'response': {'output': completed}})
    return {'wire': ''.join('data: ' + json.dumps(event) + '\n\n' for event in stream).encode()}


class LiveCodexObserverTests(unittest.TestCase):
    def test_selected_native_model_is_used_without_changing_default_or_phase_bounds(self):
        self.assertEqual(MODEL, 'claude-haiku-4-5-20251001')
        self.assertEqual(PHASE_LIMITS, {'initial': 2, 'compact': 1, 'followup': 1, 'followup_second': 1})
        self.assertEqual(sum(PHASE_LIMITS.values()), 5)
        for model in ('claude-haiku-5-5', 'claude-opus-5-5', 'claude-opus-5-5-responses-han', MODEL):
            with self.subTest(model=model):
                self.assertEqual(native_model(model), model)
                self.assertEqual(State('synthetic-fixture-key', model=model).model, model)
        self.assertEqual(State('synthetic-fixture-key').model, MODEL)
        for model in ('', 'not-claude', 'claude-\nsecret', 'claude-/path'):
            with self.subTest(invalid=model), self.assertRaises(argparse.ArgumentTypeError):
                native_model(model)

    def test_explicit_validation_relay_and_existing_gateway_keep_the_selected_paths(self):
        self.assertEqual(gateway_target('http://192.168.0.64:13459/v1'),
                         ('http', '192.168.0.64', 13459, '/v1/responses'))
        self.assertEqual(gateway_target('http://192.168.0.7:4000/claude-responses/v1/'),
                         ('http', '192.168.0.7', 4000, '/claude-responses/v1/responses'))
        self.assertEqual(gateway_target('http://192.168.0.7:4000/v1'),
                         ('http', '192.168.0.7', 4000, '/v1/responses'))
        for url in ('http://user:secret@192.168.0.64:13459/v1',
                    'http://192.168.0.64:13459/v1?secret=not-allowed',
                    'http://192.168.0.64:13459/v1#fragment',
                    'http://192.168.0.64:13459/incorrect'):
            with self.subTest(url=url), self.assertRaises(ValueError):
                gateway_target(url)

    def test_standard_gateway_path_does_not_prove_chat_conversion_or_native_configuration(self):
        target = gateway_target('http://192.168.0.7:4000/v1')
        native = gateway_route_evidence(target, 5, 'native-responses')
        self.assertTrue(native['actual_dot7_gateway_tested'])
        self.assertTrue(native['gateway_standard_responses_endpoint_tested'])
        self.assertFalse(native['gateway_passthrough_endpoint_tested'])
        self.assertEqual(native['gateway_route_kind_declared'], 'native-responses')
        self.assertFalse(native['gateway_route_configuration_observed'])
        self.assertIsNone(native['gateway_managed_conversion_tested'])
        self.assertIsNone(gateway_route_evidence(target, 5)['gateway_managed_conversion_tested'])
        self.assertTrue(gateway_route_evidence(target, 5, 'chat-conversion')['gateway_managed_conversion_tested'])
        self.assertFalse(gateway_route_evidence(target, 0, 'native-responses')['actual_dot7_gateway_tested'])
        legacy = gateway_route_evidence(gateway_target('http://192.168.0.7:4000/claude-responses/v1'), 5, 'pass-through')
        self.assertTrue(legacy['gateway_passthrough_endpoint_tested'])
        self.assertFalse(legacy['gateway_standard_responses_endpoint_tested'])

    def test_reasoning_replay_matches_done_completed_and_actual_next_input_without_exporting_state(self):
        items = [{'id': 'rs_first', 'type': 'reasoning', 'encrypted_content': 'PRIVATE_STATE_FIRST'},
                 {'id': 'rs_second', 'type': 'reasoning', 'encrypted_content': 'PRIVATE_STATE_SECOND'}]
        evidence = reasoning_replay_evidence([reasoning_record(items, items)], {'request': {'input': items}})
        self.assertTrue(all(evidence.values()))
        self.assertNotIn('PRIVATE_STATE', json.dumps(evidence))
        self.assertNotIn('rs_first', json.dumps(evidence))
        reversed_state = reasoning_replay_evidence([reasoning_record(items, items)], {'request': {'input': items[::-1]}})
        self.assertFalse(reversed_state['done_replay_exact'])
        self.assertFalse(reversed_state['replay_state_exact'])

    def test_matching_missing_done_state_is_not_successful_state_replay(self):
        item = {'id': 'rs_first', 'type': 'reasoning'}
        final = {**item, 'encrypted_content': 'PRIVATE_FINAL_STATE'}
        evidence = reasoning_replay_evidence([reasoning_record([item], [final])], {'request': {'input': [item]}})
        self.assertFalse(evidence['done_replay_exact'])
        self.assertFalse(evidence['completed_replay_exact'])
        self.assertTrue(evidence['replay_ids_exact'])
        self.assertFalse(evidence['replay_state_exact'])
        final_replay = reasoning_replay_evidence([reasoning_record([item], [final])], {'request': {'input': [final]}})
        self.assertFalse(final_replay['done_replay_exact'])
        self.assertTrue(final_replay['completed_replay_exact'])
        self.assertNotIn('PRIVATE_FINAL_STATE', json.dumps(final_replay))

    def test_replayed_reasoning_state_and_identity_are_reported_separately(self):
        item = {'id': 'rs_original', 'type': 'reasoning', 'encrypted_content': 'PRIVATE_SAME_STATE'}
        different_id = {**item, 'id': 'rs_replaced'}
        evidence = reasoning_replay_evidence([reasoning_record([item], [item])], {'request': {'input': [different_id]}})
        self.assertFalse(evidence['done_replay_exact'])
        self.assertFalse(evidence['completed_replay_exact'])
        self.assertFalse(evidence['replay_ids_exact'])
        self.assertTrue(evidence['replay_state_exact'])
        text_only = {'type': 'message', 'role': 'assistant', 'content': [{'type': 'output_text', 'text': 'ok'}]}
        self.assertTrue(all(value is None for value in reasoning_replay_evidence(
            [reasoning_record([text_only], [text_only])], {'request': {'input': [text_only]}}).values()))

    def test_unexpected_replayed_state_after_text_only_output_is_not_unobserved(self):
        text_only = {'type': 'message', 'role': 'assistant', 'content': [{'type': 'output_text', 'text': 'ok'}]}
        unexpected = {'id': 'rs_foreign', 'type': 'reasoning', 'encrypted_content': 'PRIVATE_UNEXPECTED_STATE'}
        evidence = reasoning_replay_evidence([reasoning_record([text_only], [text_only])],
                                           {'request': {'input': [text_only, unexpected]}})
        self.assertTrue(all(value is False for value in evidence.values()))
        self.assertNotIn('PRIVATE_UNEXPECTED_STATE', json.dumps(evidence))

    def test_reasoning_fixture_preserves_default_prompts_and_has_unique_verified_answer(self):
        self.assertEqual(turn_prompt('initial', True), turn_prompt('initial'))
        for phase in ('initial', 'followup', 'followup_second'):
            prefix = ('Call the built-in no-I/O get_goal tool exactly once with {}. After its result, do not call further tools. '
                      if phase == 'initial' else 'Continue this same conversation without using any tools. ')
            marker = {'initial': 'CODEX_LIVE_INITIAL_OK', 'followup': 'CODEX_LIVE_FOLLOWUP_OK',
                      'followup_second': 'CODEX_LIVE_SECOND_FOLLOWUP_OK'}[phase]
            self.assertEqual(turn_prompt(phase), prefix + 'Never access files, commands, network, search or agents. Reply with exactly ' + marker + '.')
        constraints = [(17, 4), (19, 17), (23, 18), (29, 3)]
        solutions = [number for number in range(215441) if all(number % modulus == remainder for modulus, remainder in constraints)]
        self.assertEqual(solutions, [173829])
        self.assertEqual((37 * solutions[0] + 11) % 100000, 31684)
        self.assertIn('Solve and verify all four congruences', turn_prompt('followup', True))
        self.assertIn('immediately preceding answer', turn_prompt('followup_second', True))
        self.assertEqual(sum(PHASE_LIMITS.values()), 5)

    def test_reasoning_fixture_answers_are_observed_without_changing_markers(self):
        for phase, answer in REASONING_FIXTURE_EXPECTED.items():
            item = {'type': 'message', 'role': 'assistant', 'content': [{'type': 'output_text', 'text': answer}]}
            record = reasoning_record([item], [item])
            self.assertTrue(reasoning_fixture_answer_correct([record], phase))
            wrong = {**item, 'content': [{'type': 'output_text', 'text': answer.split(':')[0] + ':0'}]}
            self.assertFalse(reasoning_fixture_answer_correct([reasoning_record([wrong], [wrong])], phase))
        self.assertFalse(reasoning_fixture_answer_correct([], 'followup'))

    def test_signed_replay_qualification_requires_an_actual_successful_replay(self):
        compact_only = {'compact': {'reasoning_done_completed_exact': True}}
        self.assertFalse(signed_replay_qualification(True, True, compact_only))
        replayed = {**compact_only, 'followup_second': {'post_compaction_reasoning_replay_exact': True,
                                                      'post_compaction_reasoning_done_replay_exact': True}}
        self.assertTrue(signed_replay_qualification(True, True, replayed))
        self.assertFalse(signed_replay_qualification(False, True, replayed))
        self.assertFalse(signed_replay_qualification(True, False, replayed))
        self.assertFalse(signed_replay_qualification(True, None, replayed))
        broken = {**replayed, 'initial': {'initial_reasoning_done_replay_exact': False}}
        self.assertFalse(signed_replay_qualification(True, True, broken))

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

    def test_managed_responses_cache_counters_are_observed_without_native_extensions(self):
        result = cache_observations([{'cached_tokens': 12705, 'cache_write_tokens': 129},
                                     {'cached_tokens': 0, 'cache_write_tokens': 11046}])
        self.assertEqual(result, {'cache_write_observed': True, 'cache_hit_observed': True,
                                 'cache_write_usage_response_count': 2, 'cache_read_usage_response_count': 2})

    def test_native_and_standard_cache_aliases_are_not_double_counted(self):
        result = cache_observations([{'cache_read_input_tokens': 0, 'cached_tokens': 12,
                                     'cache_creation_input_tokens': 7, 'cache_write_tokens': 7}])
        self.assertFalse(result['cache_hit_observed'])
        self.assertTrue(result['cache_write_observed'])
        self.assertEqual(result['cache_read_usage_response_count'], 1)
        self.assertEqual(result['cache_write_usage_response_count'], 1)
        self.assertIsNone(cache_observations([{'cached_tokens': -1}])['cache_hit_observed'])

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

    def test_reasoning_done_without_state_does_not_claim_completed_snapshot_lacks_state(self):
        item = {'id': 'rs_fixture', 'type': 'reasoning', 'summary': []}
        stream = [{'type': 'response.output_item.done', 'item': item},
                  {'type': 'response.completed', 'response': {'output': [
                      {**item, 'encrypted_content': 'PRIVATE_SIGNED_STATE_SENTINEL'}]}}]
        record = {'wire': ''.join('data: ' + json.dumps(event) + '\n\n' for event in stream).encode(),
                  'status': 200, 'finished': True, 'auth_exact': True,
                  'cache_header_exact': True, 'phase': 'compact'}
        summary = record_summary(record)
        self.assertFalse(summary['encrypted_content_present'])
        self.assertFalse(summary['reasoning_done_encrypted_content_present'])
        self.assertTrue(summary['reasoning_completed_encrypted_content_present'])
        self.assertFalse(summary['reasoning_done_completed_exact'])
        self.assertNotIn('PRIVATE_SIGNED_STATE_SENTINEL', json.dumps(summary))

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
        self.assertIsNone(summary['reasoning_completed_encrypted_content_present'])
        self.assertIsNone(summary['usage'])
        self.assertNotIn('PRIVATE_SENTINEL', json.dumps(summary))
        self.assertNotIn('wire', summary)


if __name__ == '__main__':
    unittest.main()
