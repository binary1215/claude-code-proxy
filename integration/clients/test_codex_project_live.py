"""Local fixture/evidence tests only: no Codex, listeners, credentials or models."""
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from codex_project_live import (
    FILES, FOLLOWUP_TEST, MARKERS, MAX_REQUESTS, MODEL, NATIVE_OPTIONS, PHASE_LIMITS,
    Failure, State, automatic_compaction_evidence, build_catalog, endpoint,
    execution_evidence, phase_evidence, protected_tests_exact, run_tests,
    source_snapshot, test_command as is_test_command, turn_prompt, wire_evidence,
)

FIXED = {
    'billing.py': '# PROJECT_BILLING_SOURCE\ndef total_cents(items):\n    return sum(item["unit_cents"] * item["quantity"] for item in items)\n',
    'display.py': '# PROJECT_DISPLAY_SOURCE\ndef format_total(cents):\n    return f"${cents / 100:.2f}"\n',
}
EXTENDED = {
    'billing.py': '# PROJECT_BILLING_SOURCE\ndef total_cents(items, discount_cents=0):\n    return max(0, sum(item["unit_cents"] * item["quantity"] for item in items) - discount_cents)\n',
    'display.py': '# PROJECT_DISPLAY_SOURCE\ndef format_total(cents, symbol="$"):\n    return f"{symbol}{cents / 100:.2f}"\n',
}


def notification(item, method='item/completed'):
    return {'method': method, 'params': {'item': item}}


def command(exit_code, output, text='python3 -B -m unittest -v'):
    return notification({'type': 'commandExecution', 'command': text, 'exitCode': exit_code, 'aggregatedOutput': output})


def executed_fixture():
    return [command(1, 'PROJECT_BILLING_SOURCE\nPROJECT_DISPLAY_SOURCE\nRan 3 tests\nFAILED (failures=2)\n',
                    'cat billing.py display.py; python3 -B -m unittest -v'),
            notification({'type': 'fileChange', 'status': 'completed'}),
            command(0, 'Ran 3 tests\nOK\n')]


def record(phase, output=None, input_items=None):
    output = output if output is not None else [{'type': 'message', 'role': 'assistant', 'content': [
        {'type': 'output_text', 'text': MARKERS[phase]}]}]
    values = [{'type': 'response.output_item.done', 'item': item} for item in output]
    values.append({'type': 'response.completed', 'response': {'output': output, 'usage': {
        'input_tokens': 120, 'output_tokens': 20, 'input_tokens_details': {'cached_tokens': 100, 'cache_write_tokens': 5}}}})
    return {'phase': phase, 'status': 200, 'finished': True,
            'request': {'input': input_items or [], 'tools': [{'type': 'function', 'name': 'exec_command'},
                {'type': 'custom', 'name': 'apply_patch'}]},
            'wire': ''.join('data: ' + json.dumps(value) + '\n\n' for value in values).encode()}


class ProjectLiveTests(unittest.TestCase):
    def make_project(self, path):
        for name, text in FILES.items():
            (path / name).write_text(text, encoding='utf-8')

    def write_sources(self, path, source):
        for name, text in source.items():
            (path / name).write_text(text, encoding='utf-8')

    def test_actual_fixture_fails_then_two_file_repair_and_followup_work(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)
            self.make_project(path)
            self.assertNotEqual(run_tests(path)['exit_code'], 0)
            before = source_snapshot(path)
            self.write_sources(path, FIXED)
            self.assertEqual(sum(before[name] != digest for name, digest in source_snapshot(path).items()), 2)
            self.assertTrue(run_tests(path)['passed'])
            self.assertTrue(protected_tests_exact(path, 'initial'))
            (path / 'test_followup.py').write_text(FOLLOWUP_TEST, encoding='utf-8')
            self.assertNotEqual(run_tests(path)['exit_code'], 0)
            self.write_sources(path, EXTENDED)
            self.assertTrue(run_tests(path)['passed'])
            self.assertTrue(protected_tests_exact(path, 'followup'))

    def test_actual_effects_and_real_command_observations_qualify_initial_phase(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)
            self.make_project(path)
            before = source_snapshot(path)
            self.write_sources(path, FIXED)
            state = State('synthetic-test-key', endpoint('http://192.168.0.7:4000/v1'), MODEL)
            state.records = [record('initial')]
            terminal = {'params': {'turn': {'status': 'completed'}}}
            evidence = phase_evidence(state, 'initial', path, before, executed_fixture(), terminal)
            self.assertTrue(evidence['functional_pass'])
            self.assertTrue(evidence['failed_test_before_file_change'])
            self.assertTrue(evidence['passed_test_after_file_change'])
            self.assertTrue(evidence['independent_test']['passed'])
            self.assertEqual(evidence['changed_source_file_count'], 2)

    def test_final_marker_without_actual_command_execution_cannot_qualify(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)
            self.make_project(path)
            before = source_snapshot(path)
            self.write_sources(path, FIXED)
            state = State('synthetic-test-key', endpoint('http://192.168.0.7:4000/v1'), MODEL)
            state.records = [record('initial')]
            evidence = phase_evidence(state, 'initial', path, before, [], {'params': {'turn': {'status': 'completed'}}})
            self.assertTrue(evidence['marker_present'])
            self.assertTrue(evidence['independent_test']['passed'])
            self.assertFalse(evidence['functional_pass'])

    def test_modified_supplied_tests_do_not_pass_independent_acceptance(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)
            self.make_project(path)
            before = source_snapshot(path)
            self.write_sources(path, FIXED)
            (path / 'test_project.py').write_text(FILES['test_project.py'] + '\n# changed by model\n', encoding='utf-8')
            state = State('synthetic-test-key', endpoint('http://192.168.0.7:4000/v1'), MODEL)
            state.records = [record('initial')]
            evidence = phase_evidence(state, 'initial', path, before, executed_fixture(), {'params': {'turn': {'status': 'completed'}}})
            self.assertTrue(evidence['independent_test']['passed'])
            self.assertFalse(evidence['supplied_tests_unchanged'])
            self.assertFalse(evidence['functional_pass'])

    def test_command_proof_accepts_combined_read_failure_but_not_cat_or_exit_only(self):
        evidence = execution_evidence(executed_fixture())
        self.assertTrue(evidence['source_read_observed'])
        self.assertTrue(evidence['model_test_failure_observed'])
        self.assertTrue(evidence['model_test_success_observed'])
        self.assertFalse(is_test_command({'command': 'cat test_project.py'}))
        no_tests = execution_evidence([command(0, 'just a marker'), command(1, 'just another marker')])
        self.assertFalse(no_tests['model_test_success_observed'])
        self.assertFalse(no_tests['model_test_failure_observed'])
        zero_tests = execution_evidence([command(0, 'Ran 0 tests\nOK\n')])
        self.assertFalse(zero_tests['model_test_success_observed'])

    def test_auto_compaction_needs_lifecycle_and_later_actual_successful_tests(self):
        values = [notification({'type': 'contextCompaction'}, 'item/started'),
                  notification({'type': 'contextCompaction'}), command(0, 'Ran 5 tests\nOK\n')]
        evidence = automatic_compaction_evidence(values)
        self.assertEqual(evidence['automatic_compaction_started_count'], 1)
        self.assertEqual(evidence['automatic_compaction_completed_count'], 1)
        self.assertTrue(evidence['successful_test_after_automatic_compaction'])
        reversed_order = automatic_compaction_evidence(values[2:] + values[:2])
        self.assertFalse(reversed_order['successful_test_after_automatic_compaction'])
        self.assertFalse(automatic_compaction_evidence([])['successful_test_after_automatic_compaction'])

    def test_combined_shell_zero_exit_preserves_actual_failed_tests_then_later_success(self):
        masked_failure = command(0, 'PROJECT_BILLING_SOURCE\nPROJECT_DISPLAY_SOURCE\n'
                                 'Ran 3 tests in 0.001s\n\nFAILED (failures=2)\n',
                                 'cat billing.py display.py; python3 -B -m unittest -v; pwd')
        failure_only = execution_evidence([masked_failure])
        self.assertTrue(failure_only['model_test_failure_observed'])
        self.assertFalse(failure_only['model_test_success_observed'])
        values = [masked_failure, notification({'type': 'fileChange', 'status': 'completed'}),
                  command(0, 'Ran 3 tests in 0.002s\n\nOK\n')]
        evidence = execution_evidence(values)
        self.assertTrue(evidence['model_test_failure_observed'])
        self.assertTrue(evidence['model_test_success_observed'])
        self.assertTrue(evidence['failed_test_before_file_change'])
        self.assertTrue(evidence['passed_test_after_file_change'])
        compacted = [notification({'type': 'contextCompaction'})]
        self.assertFalse(automatic_compaction_evidence(compacted + [masked_failure])['successful_test_after_automatic_compaction'])
        self.assertTrue(automatic_compaction_evidence(compacted + values)['successful_test_after_automatic_compaction'])

    def test_unittest_summaries_require_positive_counts_and_final_success(self):
        for output in ['Ran 3 tests\n', 'FAILED (failures=2)\n', 'Ran 0 tests\nFAILED (errors=1)\n',
                       'quoted Ran 3 tests\nOK\n', 'Ran 3 tests\nnot a unittest summary\nFAILED (failures=2)\n']:
            evidence = execution_evidence([command(0, output)])
            self.assertFalse(evidence['model_test_failure_observed'])
            self.assertFalse(evidence['model_test_success_observed'])
        good = 'Ran 3 tests\nOK\n'
        bad = 'Ran 3 tests\nFAILED (errors=1)\n'
        for output, success in [(bad + good, True), (good + bad, False)]:
            evidence = execution_evidence([command(0, output)])
            self.assertTrue(evidence['model_test_failure_observed'])
            self.assertEqual(evidence['model_test_success_observed'], success)
        self.assertFalse(execution_evidence([command(1, good)])['model_test_success_observed'])
        self.assertFalse(execution_evidence([command(False, good)])['model_test_success_observed'])

    def test_visible_budget_consumes_uncertain_attempts_and_stops_at18(self):
        state = State('synthetic-test-key', endpoint('http://192.168.0.7:4000/v1'), MODEL)
        for phase, limit in PHASE_LIMITS.items():
            state.phase = phase
            for _ in range(limit):
                state.reserve({'model': MODEL})
            with self.assertRaises(Failure):
                state.reserve({'model': MODEL})
        self.assertEqual(state.attempts, MAX_REQUESTS)
        self.assertEqual(len(state.records), 18)
        self.assertTrue(all(not row['finished'] for row in state.records))

    def test_wire_report_keeps_state_in_memory_and_distinguishes_replay(self):
        thought = {'type': 'reasoning', 'id': 'rs_private', 'encrypted_content': 'PRIVATE_STATE_SENTINEL'}
        values = [record('initial', [thought]), record('initial', input_items=[thought])]
        evidence = wire_evidence(values)
        self.assertTrue(evidence[0]['reasoning_done_completed_exact'])
        self.assertTrue(evidence[1]['replayed_reasoning_known_exact'])
        self.assertNotIn('PRIVATE_STATE_SENTINEL', json.dumps(evidence))
        self.assertNotIn('rs_private', json.dumps(evidence))
        unrelated = copy.deepcopy(thought); unrelated['id'] = 'rs_foreign'
        self.assertFalse(wire_evidence([record('initial', input_items=[unrelated])])[0]['replayed_reasoning_known_exact'])

    def test_catalog_requires_pinned_stock_prompt_and_ordinary_coding_tools(self):
        text = 'Synthetic pin-only unit fixture\n'
        digest = hashlib.sha256(text.encode()).hexdigest()
        with patch('codex_project_live.PROMPT_SHA256', digest):
            entry = build_catalog(MODEL, text)['models'][0]
            self.assertEqual(entry['model_messages']['instructions_template'], text)
            self.assertEqual(entry['shell_type'], 'unified_exec')
            self.assertEqual(entry['apply_patch_tool_type'], 'freeform')
            self.assertIsNone(entry['upgrade'])
        with self.assertRaises(ValueError):
            build_catalog(MODEL, text)
        self.assertEqual(endpoint('http://192.168.0.7:4000/v1'), ('http', '192.168.0.7', 4000, '/v1/responses'))
        with self.assertRaises(ValueError):
            endpoint('http://user:secret@192.168.0.7:4000/v1')

    def test_prompts_request_real_project_effects_and_same_project_followup(self):
        self.assertIn('observe the existing failures first', turn_prompt('initial'))
        self.assertIn('both source files', turn_prompt('initial'))
        self.assertIn('test_followup.py', turn_prompt('followup'))
        self.assertIn('discount_cents', turn_prompt('followup'))
        self.assertIn(MARKERS['followup'], turn_prompt('followup'))
        self.assertIn('cache_control', NATIVE_OPTIONS)


if __name__ == '__main__':
    unittest.main()
