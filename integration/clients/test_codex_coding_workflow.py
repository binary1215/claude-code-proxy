"""Pure combined-workflow evidence tests; no clients, listeners or model calls."""
import copy
import io
import json
from types import SimpleNamespace
import unittest

from codex_coding_workflow import (
    EXPECTED_FILES, FAIL_MARKER, FILES, FOLLOWUP_MARKER, INITIAL_MARKER, MODEL, Fake,
    PASS_MARKER, PATCH, READ_MARKER, catalog_entry, catalog_list_evidence, fixture_commands, native_name,
    offered_tools, projected_tool_results, workflow_evidence,
)


def fixture():
    records, upstream, prior, assistant = [], [], [], []
    ids = ['toolu_workflow_read', 'toolu_workflow_fail', 'toolu_workflow_patch',
           'toolu_workflow_pass', 'toolu_workflow_recheck']
    seen_ids = []
    for index in range(7):
        done = []
        input_items = copy.deepcopy(prior)
        input_items.extend({'type': 'custom_tool_call_output' if call_id.endswith('patch') else 'function_call_output',
                            'call_id': call_id, 'output': 'result'} for call_id in seen_ids)
        native = [{'role': 'assistant', 'content': copy.deepcopy(assistant)},
                  {'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': call_id, 'content': 'result'} for call_id in seen_ids]}]
        if index in (4, 6):
            text = INITIAL_MARKER if index == 4 else FOLLOWUP_MARKER
            done = [{'type': 'message', 'content': [{'type': 'output_text', 'text': text}]}]
            issued = [{'type': 'text', 'text': text}]
        else:
            stage = {0: 'read', 1: 'fail', 2: 'patch', 3: 'pass', 5: 'recheck'}[index]
            reasoning = [{'type': 'reasoning', 'id': f'{stage}-{n}', 'encrypted_content': f'ccpr2.{stage}-{n}'} for n in range(3)]
            call = {'type': 'custom_tool_call' if stage == 'patch' else 'function_call',
                    'name': 'apply_patch' if stage == 'patch' else 'exec_command', 'call_id': 'toolu_workflow_' + stage}
            call['input' if stage == 'patch' else 'arguments'] = PATCH if stage == 'patch' else '{}'
            done = reasoning + [call]
            prior.extend(copy.deepcopy(reasoning))
            issued = [{'type': 'thinking', 'thinking': stage, 'signature': 'signed'},
                      {'type': 'thinking', 'thinking': '', 'signature': 'signed-empty'},
                      {'type': 'redacted_thinking', 'data': 'redacted'},
                      {'type': 'tool_use', 'id': call['call_id'], 'name': call['name'], 'input': {'input': PATCH} if stage == 'patch' else {}}]
            seen_ids.append(call['call_id'])
        wire = ''.join('data: ' + json.dumps({'type': 'response.output_item.done', 'item': item}) + '\n\n' for item in done)
        wire += 'data: ' + json.dumps({'type': 'response.completed', 'response': {'output': done}}) + '\n\n'
        records.append({'status': 200, 'response_sse': wire, 'request': {'input': input_items, 'tools': [
            {'type': 'function', 'name': 'exec_command'}, {'type': 'custom', 'name': 'apply_patch'}]}})
        upstream.append({'body': {'messages': native}, 'expected_assistant': copy.deepcopy(assistant),
                         'upstream_auth_exact': True, 'credential_leak': False})
        assistant.extend(issued)
    notifications = [{'type': 'commandExecution', 'exitCode': 0, 'aggregatedOutput': READ_MARKER},
        {'type': 'commandExecution', 'exitCode': 3, 'aggregatedOutput': FAIL_MARKER},
        {'type': 'fileChange', 'status': 'completed'},
        {'type': 'commandExecution', 'exitCode': 0, 'aggregatedOutput': PASS_MARKER},
        {'type': 'agentMessage', 'text': INITIAL_MARKER},
        {'type': 'commandExecution', 'exitCode': 0, 'aggregatedOutput': PASS_MARKER},
        {'type': 'agentMessage', 'text': FOLLOWUP_MARKER}]
    events = [{'method': 'item/completed', 'params': {'item': item}} for item in notifications]
    return records, upstream, events, copy.deepcopy(EXPECTED_FILES), ['completed', 'completed']


class CodingWorkflowEvidenceTests(unittest.TestCase):
    def test_real_effect_oracle_accepts_complete_synthetic_observation(self):
        report = workflow_evidence(*fixture())
        self.assertTrue(report['transport_state_pass'])
        self.assertTrue(report['functional_pass'])
        self.assertEqual(report['command_exit_codes'], [0, 3, 0, 0])

    def test_final_marker_and_exit_zero_do_not_hide_denied_patch(self):
        data = fixture()
        data[2][2]['params']['item']['status'] = 'failed'
        data[3].update(FILES)
        report = workflow_evidence(*data)
        self.assertTrue(report['transport_state_pass'])
        self.assertTrue(report['final_markers_exact'])
        self.assertFalse(report['functional_pass'])

    def test_expected_failure_requires_actual_exit_and_marker(self):
        for missing in ('exitCode', 'aggregatedOutput'):
            data = fixture()
            data[2][1]['params']['item'].pop(missing)
            report = workflow_evidence(*data)
            self.assertFalse(report['initial_test_really_failed'])
            self.assertFalse(report['functional_pass'])

    def test_pass_marker_alone_without_zero_exit_is_not_test_success(self):
        data = fixture()
        data[2][3]['params']['item']['exitCode'] = 1
        self.assertFalse(workflow_evidence(*data)['repaired_test_really_passed'])
        self.assertFalse(workflow_evidence(*data)['functional_pass'])

    def test_followup_result_id_must_match_and_preserve_all_prior_tools(self):
        data = fixture()
        data[1][-1]['body']['messages'][-1]['content'][-1]['tool_use_id'] = 'wrong-call'
        self.assertFalse(workflow_evidence(*data)['tool_result_ids_exact'])
        self.assertFalse(workflow_evidence(*data)['transport_state_pass'])

    def test_tool_result_text_loss_is_a_transport_failure(self):
        data = fixture()
        data[1][-1]['body']['messages'][-1]['content'][-1]['content'] = ''
        report = workflow_evidence(*data)
        self.assertFalse(report['transport_state_pass'])
        self.assertTrue(report['tool_result_ids_exact'])

    def test_tool_result_projection_preserves_error_text_and_cache(self):
        item = {'type': 'function_call_output', 'call_id': 'id', 'output': 'failed test',
                'is_error': True, 'cache_control': {'type': 'ephemeral'}}
        self.assertEqual(projected_tool_results({'input': [item]}), [{'type': 'tool_result',
            'tool_use_id': 'id', 'content': 'failed test', 'is_error': True, 'cache_control': {'type': 'ephemeral'}}])
        item['output'] = [{'type': 'input_image', 'image_url': 'https://invalid.example'}]
        with self.assertRaises(ValueError):
            projected_tool_results({'input': [item]})

    def test_capsule_loss_fails_even_with_exact_file_content(self):
        data = fixture()
        data[0][-1]['request']['input'].pop()
        report = workflow_evidence(*data)
        self.assertFalse(report['transport_state_pass'])
        self.assertTrue(report['workspace_files_exact'])
        self.assertFalse(report['functional_pass'])

    def test_native_signed_empty_and_order_are_not_optional(self):
        data = fixture()
        data[1][-1]['body']['messages'][0]['content'].reverse()
        self.assertFalse(workflow_evidence(*data)['transport_state_pass'])

    def test_no_hidden_request_or_extra_file_is_accepted(self):
        data = fixture()
        data[0].append(copy.deepcopy(data[0][-1]))
        self.assertFalse(workflow_evidence(*data)['functional_pass'])
        data = fixture()
        data[3]['unexpected.txt'] = 'extra'
        self.assertFalse(workflow_evidence(*data)['functional_pass'])

    def test_followup_must_complete_not_just_issue_marker(self):
        data = fixture()
        data[4][-1] = 'failed'
        self.assertFalse(workflow_evidence(*data)['functional_pass'])

    def test_both_core_tools_required_and_namespace_identity_preserved(self):
        data = fixture()
        data[0][0]['request']['tools'].pop(0)
        self.assertFalse(workflow_evidence(*data)['shell_and_patch_offered'])
        request = {'tools': [{'type': 'namespace', 'name': 'functions', 'tools': [{'type': 'function', 'name': 'exec_command'}]}]}
        self.assertEqual(offered_tools(request)[0][1], 'functions')
        self.assertEqual(native_name('exec_command', None), 'exec_command')
        self.assertNotEqual(native_name('exec_command', 'functions'), native_name('exec_command', 'other'))

    def test_catalog_rejects_disabled_shell_and_replacement_missing_prompt(self):
        entry = {'slug': MODEL, 'shell_type': 'unified_exec', 'apply_patch_tool_type': 'freeform',
                 'upgrade': None, 'model_messages': {'instructions_template': 'Stock prompt supplied separately'}}
        self.assertEqual(catalog_entry({'models': [entry]}, MODEL), entry)
        for key, value in [('shell_type', 'disabled'), ('apply_patch_tool_type', None), ('upgrade', {'id': 'other'})]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                catalog_entry({'models': [{**entry, key: value}]}, MODEL)
        with self.assertRaises(ValueError):
            catalog_entry({'models': [{**entry, 'model_messages': {}}]}, MODEL)

    def test_catalog_list_requires_exact_native_entry(self):
        self.assertTrue(catalog_list_evidence({'data': [{'model': MODEL}]}, MODEL)['selected_model_listed'])
        self.assertFalse(catalog_list_evidence({'data': [{'model': 'other'}]}, MODEL)['selected_model_listed'])
        self.assertFalse(catalog_list_evidence({'data': [{'model': MODEL}, {'model': MODEL}]}, MODEL)['selected_model_listed'])

    def test_native_sse_uses_selected_model_not_legacy_fixture_model(self):
        handler = object.__new__(Fake)
        handler.server = SimpleNamespace(model=MODEL, requests=[{}])
        handler.wfile = io.BytesIO()
        handler.send_response = lambda *_: None
        handler.send_header = lambda *_: None
        handler.end_headers = lambda: None
        handler.stream([{'type': 'text', 'text': 'result'}], 'end_turn')
        events = [json.loads(line[6:]) for line in handler.wfile.getvalue().decode().splitlines() if line.startswith('data: ')]
        self.assertEqual(events[0]['message']['model'], MODEL)
        self.assertEqual(events[-1]['type'], 'message_stop')

    def test_shell_commands_only_run_fixed_fixture_reads_and_test(self):
        read, test = fixture_commands('C:/Program Files/python.exe', True)
        self.assertTrue(read.startswith("& 'C:/Program Files/python.exe' -B -c '"))
        self.assertIn('calculator.py', read)
        self.assertIn('display.py', read)
        self.assertEqual(test, "& 'C:/Program Files/python.exe' -B test_fixture.py")
        read, test = fixture_commands('/opt/python/bin/python', False)
        self.assertEqual(test, '/opt/python/bin/python -B test_fixture.py')


if __name__ == '__main__':
    unittest.main()
