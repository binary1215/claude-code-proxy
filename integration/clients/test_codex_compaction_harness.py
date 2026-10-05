"""Pure evidence-oracle tests; no subprocesses, client, server or provider calls."""
import copy
import unittest

from codex_compaction_smoke import (
    fixture_conversation, fixture_system, projection_checks, system_digest,
)


def message(role, text):
    return {'type': 'message', 'role': role, 'content': [{'type': 'input_text', 'text': text}]}


class CompactionEvidenceTests(unittest.TestCase):
    def test_system_preserves_instructions_then_all_duplicate_blocks_in_order(self):
        request = {'instructions': 'first', 'input': [
            message('developer', 'duplicate'), message('user', 'ordinary'),
            message('developer', 'duplicate'), message('developer', 'last'),
        ]}
        self.assertEqual(fixture_system(request), [
            {'type': 'text', 'text': text} for text in ['first', 'duplicate', 'duplicate', 'last']
        ])
        self.assertEqual(fixture_conversation(request), [
            {'role': 'user', 'block': {'type': 'text', 'text': 'ordinary'}}
        ])

    def test_text_tool_order_excludes_only_instructions_and_separate_reasoning(self):
        request = {'input': [message('user', 'before'),
            {'type': 'reasoning', 'id': 'opaque', 'encrypted_content': 'sealed'},
            {'type': 'function_call', 'name': 'get_goal', 'call_id': 'call', 'arguments': '{}'},
            {'type': 'function_call_output', 'call_id': 'call', 'output': 'result', 'is_error': False},
            message('developer', 'hoist'), message('assistant', 'answer'), message('user', 'after')]}
        self.assertEqual(fixture_conversation(request), [
            {'role': 'user', 'block': {'type': 'text', 'text': 'before'}},
            {'role': 'assistant', 'block': {'type': 'tool_use', 'id': 'call', 'name': 'get_goal', 'input': {}}},
            {'role': 'user', 'block': {'type': 'tool_result', 'tool_use_id': 'call', 'content': 'result', 'is_error': False}},
            {'role': 'assistant', 'block': {'type': 'text', 'text': 'answer'}},
            {'role': 'user', 'block': {'type': 'text', 'text': 'after'}},
        ])

    def test_oracle_rejects_unknown_instead_of_silently_dropping(self):
        for item in [
            {'type': 'message', 'role': 'user', 'content': [{'type': 'input_image', 'image_url': 'https://invalid.example'}]},
            {'type': 'unknown'},
            {'type': 'function_call', 'name': 'exec_command', 'arguments': '{}', 'call_id': 'unsafe'},
        ]:
            with self.subTest(item=item), self.assertRaises(ValueError):
                fixture_conversation({'input': [item]})

    def test_projection_requires_exact_order_and_no_deduplication(self):
        request = {'instructions': 'instruction', 'input': [message('user', 'a'), message('developer', 'd'), message('user', 'b')]}
        records = [{'phase': 'followup', 'status': 200, 'request': request}]
        body = {'system': fixture_system(request), 'messages': [{'role': 'user', 'content': [
            {'type': 'text', 'text': 'a'}, {'type': 'text', 'text': 'b'}]}]}
        upstream = [{'phase': 'followup', 'body': body}]
        self.assertTrue(projection_checks(records, upstream)[0]['conversation_order_exact'])
        reversed_body = copy.deepcopy(body)
        reversed_body['messages'][0]['content'].reverse()
        self.assertFalse(projection_checks(records, [{'phase': 'followup', 'body': reversed_body}])[0]['conversation_order_exact'])
        lost_body = copy.deepcopy(body)
        lost_body['system'].pop()
        self.assertFalse(projection_checks(records, [{'phase': 'followup', 'body': lost_body}])[0]['system_exact'])
        self.assertEqual(projection_checks(records, []), [])

    def test_projection_detects_wrong_phase_and_preserves_cache_control(self):
        item = message('developer', 'd')
        item['content'][0]['cache_control'] = {'type': 'ephemeral', 'ttl': '1h'}
        request = {'input': [item, message('user', 'u')]}
        blocks = fixture_system(request)
        self.assertEqual(blocks[0]['cache_control'], {'type': 'ephemeral', 'ttl': '1h'})
        upstream = [{'phase': 'other', 'body': {'system': blocks, 'messages': [
            {'role': 'user', 'content': [{'type': 'text', 'text': 'u'}]}]}}]
        check = projection_checks([{'phase': 'followup', 'status': 200, 'request': request}], upstream)[0]
        self.assertFalse(check['phase_exact'])

    def test_system_fingerprint_changes_on_order_or_text(self):
        first = {'system': [{'type': 'text', 'text': 'a'}, {'type': 'text', 'text': 'b'}]}
        changed = copy.deepcopy(first)
        changed['system'].reverse()
        self.assertNotEqual(system_digest(first), system_digest(changed))
        self.assertEqual(system_digest(first), system_digest(copy.deepcopy(first)))


if __name__ == '__main__':
    unittest.main()
