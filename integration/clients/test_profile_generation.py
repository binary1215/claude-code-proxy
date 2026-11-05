"""Pure profile generation contracts; no credentials, provider calls or clients."""
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import tomllib
import unittest
from unittest.mock import patch

import generate_client_profiles as profiles


EXAMPLE = Path(__file__).parent / 'profiles' / 'metadata.example.json'


class ProfileGenerationTests(unittest.TestCase):
    def setUp(self):
        self.manifest = json.loads(EXAMPLE.read_text(encoding='utf-8'))
        # Tiny local fixture stands in for the public source; no test downloads it.
        self.prompt_hash = patch.object(profiles, 'PROMPT_SHA256', hashlib.sha256(b'stock').hexdigest())
        self.prompt_hash.start()
        self.addCleanup(self.prompt_hash.stop)

    def test_unknown_context_stays_unknown_and_native_identity_is_preserved(self):
        model = profiles.build_catalog(self.manifest, 'stock instructions unchanged')['models'][0]
        self.assertEqual(model['slug'], self.manifest['model'])
        self.assertIsNone(model['context_window'])
        self.assertIsNone(model['max_context_window'])
        self.assertIsNone(model['upgrade'])
        self.assertEqual(model['shell_type'], 'unified_exec')
        self.assertEqual(model['apply_patch_tool_type'], 'freeform')
        self.assertEqual(model['model_messages'], {'instructions_template': 'stock instructions unchanged'})
        self.assertEqual(model['supported_reasoning_levels'], [])
        self.assertEqual(model['input_modalities'], ['text'])
        self.assertNotIn('base_instructions', model)

    def test_explicit_context_requires_evidence(self):
        self.manifest['context_window'] = 123456
        with self.assertRaises(ValueError):
            profiles.validate_manifest(self.manifest)
        self.manifest['context_evidence'] = 'operator-provided observed limit evidence'
        self.assertEqual(profiles.build_catalog(self.manifest, 'stock')['models'][0]['context_window'], 123456)
        for invalid in (0, -1, True, '123456'):
            self.manifest['context_window'] = invalid
            with self.assertRaises(ValueError):
                profiles.validate_manifest(self.manifest)

    def test_manifest_does_not_accept_credentials_or_false_capability_claims(self):
        for field, value in [('api_key', 'secret'), ('model', 'gpt-5')]:
            invalid = copy.deepcopy(self.manifest)
            invalid[field] = value
            with self.assertRaises(ValueError):
                profiles.validate_manifest(invalid)
        for evidence in ('Bearer test-credential', 'sk-ant-oat01-test-credential'):
            invalid = copy.deepcopy(self.manifest)
            invalid['qualification']['evidence'] = [evidence]
            with self.assertRaises(ValueError):
                profiles.validate_manifest(invalid)
        self.manifest['qualification']['evidence'] = []
        with self.assertRaises(ValueError):
            profiles.validate_manifest(self.manifest)

    def test_url_contract_prevents_double_v1_and_embedded_secrets(self):
        self.assertEqual(profiles.validate_url('https://gateway.example/responses/v1/', responses=True),
                         'https://gateway.example/responses/v1')
        for url in ('https://name:secret@gateway.example/v1', 'https://gateway.example/v1?key=secret',
                    'https://gateway.example/v1#secret', 'file:///tmp/v1', 'https://gateway.example/responses'):
            with self.assertRaises(ValueError):
                profiles.validate_url(url, responses=True)
        with self.assertRaises(ValueError):
            profiles.validate_url('https://gateway.example/native/v1', responses=False)

    def test_new_isolated_output_contains_only_metadata_and_environment_key_name(self):
        with tempfile.TemporaryDirectory(prefix='profile-generation-') as temporary:
            output = Path(temporary) / 'new profile space'
            with patch.dict(os.environ, {profiles.ENV_KEY: 'private-value-must-not-be-read'}):
                profiles.generate(self.manifest, 'stock', output, profiles.DEFAULT_RESPONSES_URL, profiles.DEFAULT_MESSAGES_URL)
            config = tomllib.loads((output / 'codex-home/config.toml').read_text(encoding='utf-8'))
            self.assertEqual(Path(config['model_catalog_json']), (output / 'codex-home/models.json').resolve())
            self.assertEqual(set(config), {'model_catalog_json', 'profiles', 'model_providers'})
            self.assertEqual(config['profiles']['claude_proxy']['model'], self.manifest['model'])
            provider = config['model_providers']['claude_proxy']
            self.assertEqual(provider['env_key'], profiles.ENV_KEY)
            self.assertEqual(provider['request_max_retries'], 0)
            self.assertFalse(provider['supports_websockets'])
            generated = '\n'.join(path.read_text(encoding='utf-8') for path in output.rglob('*') if path.is_file())
            self.assertNotIn('private-value-must-not-be-read', generated)
            qualification = json.loads((output / 'qualification.json').read_text(encoding='utf-8'))
            self.assertTrue(qualification['generated_not_certified'])
            self.assertIsNotNone(qualification['context_warning'])
            before = {str(path): path.read_bytes() for path in output.rglob('*') if path.is_file()}
            with self.assertRaises(FileExistsError):
                profiles.generate(self.manifest, 'stock', output, profiles.DEFAULT_RESPONSES_URL, profiles.DEFAULT_MESSAGES_URL)
            self.assertEqual(before, {str(path): path.read_bytes() for path in output.rglob('*') if path.is_file()})

    def test_invalid_url_leaves_output_uncreated(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / 'not-created'
            with self.assertRaises(ValueError):
                profiles.generate(self.manifest, 'stock', output, 'https://gateway.example', profiles.DEFAULT_MESSAGES_URL)
            self.assertFalse(output.exists())

    def test_programmatic_generation_checks_prompt_before_claiming_provenance(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / 'not-created'
            with self.assertRaises(ValueError):
                profiles.generate(self.manifest, 'different prompt', output, profiles.DEFAULT_RESPONSES_URL, profiles.DEFAULT_MESSAGES_URL)
            self.assertFalse(output.exists())

    def test_prompt_identity_and_explicit_download_only(self):
        with self.assertRaises(ValueError):
            profiles.load_stock_prompt(None, False)
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'prompt.md'
            path.write_text('not the pinned stock prompt', encoding='utf-8')
            with self.assertRaises(ValueError):
                profiles.load_stock_prompt(path, False)

    def test_existing_output_refused_before_download(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(profiles, 'load_stock_prompt') as load:
            self.assertEqual(profiles.main(['--manifest', str(EXAMPLE), '--output', temporary, '--download-stock-prompt']), 2)
            load.assert_not_called()

    def test_launcher_requires_environment_key_without_starting_client(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / 'new'
            profiles.generate(self.manifest, 'stock', output, profiles.DEFAULT_RESPONSES_URL, profiles.DEFAULT_MESSAGES_URL)
            environment = os.environ.copy()
            environment.pop(profiles.ENV_KEY, None)
            result = subprocess.run([sys.executable, str(output / 'launch.py'), 'claude'], env=environment,
                                    text=True, capture_output=True)
            self.assertEqual(result.returncode, 2)
            self.assertIn('Gateway credential environment variable is missing', result.stderr)

    def test_launcher_scopes_environment_and_preserves_user_tool_permissions(self):
        # Execute launcher text against mocked subprocess only; no actual client.
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / 'new'
            profiles.generate(self.manifest, 'stock', output, profiles.DEFAULT_RESPONSES_URL, profiles.DEFAULT_MESSAGES_URL)
            secret = 'private-not-persisted'
            for client in ('claude', 'codex'):
                with self.subTest(client=client), patch.object(sys, 'argv', ['launch.py', '--executable', 'local-client', client, '--', 'hello']), \
                     patch.dict(os.environ, {profiles.ENV_KEY: secret, 'ANTHROPIC_API_KEY': 'old', 'CLAUDE_CODE_USE_VERTEX': '1'}), \
                     patch('subprocess.call', return_value=0) as call, \
                     patch('subprocess.run', return_value=subprocess.CompletedProcess([], 0, 'codex-cli 0.160.0\n', '')):
                    with self.assertRaises(SystemExit) as stopped:
                        exec(compile(profiles.LAUNCHER, 'launch.py', 'exec'), {'__file__': str(output / 'launch.py')})
                    self.assertEqual(stopped.exception.code, 0)
                    command = call.call_args.args[0]
                    child_env = call.call_args.kwargs['env']
                    self.assertEqual(command[0], 'local-client')
                    self.assertEqual(command[-1], 'hello')
                    self.assertNotIn('--dangerously-skip-permissions', command)
                    self.assertNotIn('--sandbox', command)
                    if client == 'codex':
                        self.assertEqual(child_env['CODEX_HOME'], str(output / 'codex-home'))
                        self.assertEqual(command[1:3], ['--profile', 'claude_proxy'])
                    else:
                        self.assertEqual(child_env['ANTHROPIC_AUTH_TOKEN'], secret)
                        self.assertNotIn('ANTHROPIC_API_KEY', child_env)
                        self.assertNotIn('CLAUDE_CODE_USE_VERTEX', child_env)
                        self.assertEqual(command[1:3], ['--model', self.manifest['model']])
                    self.assertEqual(os.environ['ANTHROPIC_API_KEY'], 'old')


if __name__ == '__main__':
    unittest.main()
