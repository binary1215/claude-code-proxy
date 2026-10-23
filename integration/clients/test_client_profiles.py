"""Static profile contracts; no credentials, clients or network access."""
import json
from pathlib import Path
import tomllib
import unittest


PROFILES = Path(__file__).parent / 'profiles'
MODEL = 'claude-haiku-4-5-20251001'
BASE = 'http://192.168.0.7:4000/claude-responses/v1'


class ProfileTests(unittest.TestCase):
    def test_codex_is_named_opt_in_responses_provider_without_client_policy_changes(self):
        config = tomllib.loads((PROFILES / 'codex.toml').read_text(encoding='utf-8'))
        self.assertEqual(set(config), {'profiles', 'model_providers'})
        profile = config['profiles']['claude_proxy']
        self.assertEqual(profile, {'model': MODEL, 'model_provider': 'claude_proxy', 'web_search': 'disabled'})
        provider = config['model_providers']['claude_proxy']
        self.assertEqual(provider['base_url'], BASE)
        self.assertEqual(provider['env_key'], 'CLAUDE_PROXY_GATEWAY_KEY')
        self.assertEqual(provider['wire_api'], 'responses')
        self.assertFalse(provider['requires_openai_auth'])
        self.assertFalse(provider['supports_websockets'])
        self.assertEqual(provider['request_max_retries'], 0)
        self.assertEqual(provider['stream_max_retries'], 0)
        for forbidden in ('http_headers', 'experimental_bearer_token', 'model_catalog_json', 'base_instructions'):
            self.assertNotIn(forbidden, json.dumps(config))

    def test_opencode_bundled_responses_native_model_and_encrypted_history(self):
        config = json.loads((PROFILES / 'opencode-responses.json').read_text(encoding='utf-8'))
        self.assertEqual(config['model'], 'openai/' + MODEL)
        self.assertEqual(config['small_model'], config['model'])
        self.assertEqual(config['enabled_providers'], ['openai'])
        self.assertEqual(set(config['provider']), {'openai'})
        provider = config['provider']['openai']
        self.assertEqual(provider['options'], {'baseURL': BASE, 'apiKey': '{env:CLAUDE_PROXY_GATEWAY_KEY}'})
        self.assertNotIn('npm', provider)
        self.assertEqual(provider['models'][MODEL]['options'], {'store': False, 'include': ['reasoning.encrypted_content']})
        for forbidden in ('permission', 'agent', 'system', 'instructions', 'headers'):
            self.assertNotIn(forbidden, config)
        self.assertNotIn('headers', provider['models'][MODEL])


if __name__ == '__main__':
    unittest.main()
