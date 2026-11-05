import copy
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from claude_coding_workflow import actions, exact_replay, inspect_result, qualify, replay_compatibility, files_match, source_matches


class CodingWorkflowTests(unittest.TestCase):
    def test_actions_keep_shell_and_two_file_edits(self):
        sequence = actions(Path('/fixture'), 'node test.cjs')
        self.assertEqual([name for name, _ in sequence], ['Read', 'Read', 'Bash', 'Edit', 'Edit', 'Bash'])
        self.assertNotEqual(sequence[3][1]['file_path'], sequence[4][1]['file_path'])

    def test_failed_test_must_really_fail_then_pass(self):
        self.assertTrue(inspect_result({'tool_use_id': 'toolu_coding_2', 'is_error': True,
                                       'content': 'WORKFLOW_TEST_FAIL'}, 2))
        self.assertFalse(inspect_result({'tool_use_id': 'toolu_coding_2', 'content': 'WORKFLOW_TEST_FAIL'}, 2))
        self.assertFalse(inspect_result({'tool_use_id': 'toolu_coding_5', 'is_error': True,
                                        'content': 'WORKFLOW_TEST_PASS'}, 5))

    def test_replay_preserves_order_and_signatures(self):
        issued = [{'type': 'thinking', 'thinking': '', 'signature': 'exact'},
                  {'type': 'tool_use', 'id': 'toolu_coding_0', 'name': 'Read', 'input': {}}]
        body = {'messages': [{'role': 'assistant', 'content': copy.deepcopy(issued)}]}
        body['messages'][0]['content'][1]['cache_control'] = {'type': 'ephemeral'}
        self.assertTrue(exact_replay(body, issued))
        body['messages'][0]['content'][0]['signature'] = 'changed'
        self.assertFalse(exact_replay(body, issued))

    def test_final_marker_does_not_prove_coding_success(self):
        report = {'exit_code': 0, 'final_exact': True, 'files_exact': True, 'independent_test_pass': True,
                  'upstream_requests': 7, 'gateway_requests': 7, 'result_checks': [True] * 6,
                  'replay_checks': [True] * 6, 'reasoning_checks': [True] * 6, 'native_messages_exact': True,
                  'http_statuses': [200] * 7, 'source_unchanged': True,
                  'synthetic_upstream_auth': True, 'credential_leak': False, 'fixture_failure': None}
        self.assertTrue(qualify(report))
        for key in ('files_exact', 'independent_test_pass', 'source_unchanged'):
            self.assertFalse(qualify({**report, key: False}))
        self.assertFalse(qualify({**report, 'replay_checks': [True] * 5}))
        self.assertFalse(qualify({**report, 'result_checks': [True, True, False, True, True, True]}))

    def test_only_observed_edit_default_addition_is_compatible(self):
        issued = [{'type': 'thinking', 'thinking': '', 'signature': 'exact'},
                  {'type': 'tool_use', 'id': 'toolu_edit', 'name': 'Edit', 'input': {'old_string': 'before'}}]
        body = {'messages': [{'role': 'assistant', 'content': copy.deepcopy(issued)}]}
        body['messages'][0]['content'][1]['input']['replace_all'] = False
        self.assertEqual(replay_compatibility(body, issued), {
            'reasoning_exact': True, 'tool_replay_compatible': True, 'non_text_exact': False})
        body['messages'][0]['content'][1]['input']['replace_all'] = True
        self.assertFalse(replay_compatibility(body, issued)['tool_replay_compatible'])
        body['messages'][0]['content'][1]['input']['replace_all'] = False
        body['messages'][0]['content'][1]['input']['unrecognized'] = 1
        self.assertFalse(replay_compatibility(body, issued)['tool_replay_compatible'])

    def test_failed_files_or_identity_still_produce_negative_evidence(self):
        with tempfile.TemporaryDirectory() as folder:
            self.assertFalse(files_match(Path(folder)))
        with patch('claude_coding_workflow.identities', side_effect=RuntimeError('changed source')):
            self.assertFalse(source_matches({}))


if __name__ == '__main__':
    unittest.main()
