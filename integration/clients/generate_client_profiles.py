"""Create opt-in client profiles, never install them or make inference calls.

The native model's capabilities are not inferred from a GPT catalog entry. The
stock Codex fallback prompt is pinned independently of provider capabilities.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import sys
from urllib.parse import urlsplit
from urllib.request import urlopen


CODEX_VERSION = '0.160.0'
CODEX_COMMIT = 'a956835d020762cb2b570053af06f643a11c0ecc'
PROMPT_URL = f'https://raw.githubusercontent.com/openai/codex/{CODEX_COMMIT}/codex-rs/models-manager/prompt.md'
PROMPT_SHA256 = 'ac8ae107a0d72fe3476b430afb161ea4e67da2e446d778aefc44828160559807'
DEFAULT_RESPONSES_URL = 'http://192.168.0.7:4000/claude-responses/v1'
DEFAULT_MESSAGES_URL = 'http://192.168.0.7:4000/claude-native'
ENV_KEY = 'CLAUDE_PROXY_GATEWAY_KEY'


def validate_manifest(value: object) -> dict:
    if not isinstance(value, dict) or set(value) != {
        'schema_version', 'model', 'context_window', 'context_evidence', 'qualification',
    }:
        raise ValueError('Manifest must contain only the documented metadata fields')
    if value['schema_version'] != 1 or type(value['schema_version']) is not int:
        raise ValueError('Unsupported manifest schema_version')
    if not isinstance(value['model'], str) or not re.fullmatch(r'claude-[a-zA-Z0-9][a-zA-Z0-9._-]*', value['model']):
        raise ValueError('Use an exact native Claude model ID, not a GPT alias')
    context = value['context_window']
    evidence = value['context_evidence']
    if context is None:
        if evidence is not None:
            raise ValueError('Unknown context_window must have null context_evidence')
    elif type(context) is not int or context < 1 or not isinstance(evidence, str) or not evidence.strip():
        raise ValueError('A positive context_window requires an explicit evidence reference')
    qualification = value['qualification']
    if not isinstance(qualification, dict) or set(qualification) != {'shell', 'apply_patch', 'thinking_replay', 'evidence'}:
        raise ValueError('qualification must describe shell, apply_patch, thinking_replay and evidence')
    for capability in ('shell', 'apply_patch', 'thinking_replay'):
        if qualification[capability] not in ('unverified', 'observed'):
            raise ValueError('Capability status must be unverified or observed')
    references = qualification['evidence']
    if not isinstance(references, list) or any(not isinstance(ref, str) or not ref.strip() for ref in references):
        raise ValueError('qualification.evidence must be a list of nonempty references')
    if 'observed' in qualification.values() and not references:
        raise ValueError('Observed capabilities require evidence references')
    # These files are shareable metadata, not an authentication channel.
    serialized = json.dumps(value)
    if re.search(r'sk-(?:ant-|proj-|[A-Za-z0-9]{16})|Bearer\s+\S+', serialized, re.I):
        raise ValueError('Manifest must not contain credentials')
    return value


def validate_url(value: str, *, responses: bool) -> str:
    parsed = urlsplit(value)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username is not None or parsed.password is not None:
        raise ValueError('Gateway URL must be HTTP(S) without credentials')
    if parsed.query or parsed.fragment or any(ord(char) < 32 for char in value):
        raise ValueError('Gateway URL must not contain query, fragment or control characters')
    result = value.rstrip('/')
    if responses and not result.endswith('/v1'):
        raise ValueError('Responses base URL must end in /v1')
    if not responses and (result.endswith('/v1') or result.endswith('/messages')):
        raise ValueError('Messages base URL must exclude /v1/messages')
    return result


def load_stock_prompt(path: Path | None, download: bool) -> str:
    if path is not None:
        raw = path.read_bytes()
    elif download:
        # Explicit source download only; never uses model/gateway credentials.
        with urlopen(PROMPT_URL, timeout=30) as response:
            raw = response.read(256 * 1024 + 1)
    else:
        raise ValueError('Supply --stock-prompt or explicitly select --download-stock-prompt')
    raw = raw.replace(b'\r\n', b'\n')
    if hashlib.sha256(raw).hexdigest() != PROMPT_SHA256:
        raise ValueError('Stock prompt does not match the pinned Codex 0.160.0 source')
    return raw.decode('utf-8')


def build_catalog(manifest: dict, stock_prompt: str) -> dict:
    """Use the pinned native fallback's client behavior, not GPT capabilities."""
    validate_manifest(manifest)
    return {'models': [{
        'slug': manifest['model'], 'display_name': manifest['model'],
        'description': 'Claude through the explicit proxy route; see qualification.json for evidence and limits.',
        'default_reasoning_level': None, 'supported_reasoning_levels': [],
        'shell_type': 'unified_exec', 'apply_patch_tool_type': 'freeform',
        'visibility': 'list', 'supported_in_api': True, 'priority': 0,
        'upgrade': None, 'availability_nux': None,
        'model_messages': {'instructions_template': stock_prompt},
        'include_skills_usage_instructions': False,
        'include_plugin_usage_instructions': False, 'include_apps_usage_instructions': False,
        'supports_reasoning_summary_parameter': True, 'default_reasoning_summary': 'auto',
        'support_verbosity': False, 'default_verbosity': None,
        'truncation_policy': {'mode': 'bytes', 'limit': 10000},
        'context_window': manifest['context_window'], 'max_context_window': manifest['context_window'],
        'auto_compact_token_limit': None, 'effective_context_window_percent': 95,
        'experimental_supported_tools': [], 'input_modalities': ['text'],
        'supports_search_tool': False, 'supports_experimental_context': False,
        'supports_reasoning_effort_updates': False, 'use_responses_lite': False,
    }]}


def render_codex_config(manifest: dict, catalog_path: Path, responses_url: str) -> str:
    # JSON quoted strings are valid TOML basic strings, including Windows paths.
    quote = json.dumps
    return f'''# Isolated opt-in configuration for Codex {CODEX_VERSION}; no permission overrides.
model_catalog_json = {quote(str(catalog_path.resolve()))}

[profiles.claude_proxy]
model = {quote(manifest['model'])}
model_provider = "claude_proxy"
web_search = "disabled"

[model_providers.claude_proxy]
name = "Claude through LiteLLM and claude-code-proxy"
base_url = {quote(responses_url)}
wire_api = "responses"
env_key = "{ENV_KEY}"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
'''


LAUNCHER = '''"""Opt-in child-process launcher; does not modify the parent shell or client sources."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('client', choices=['codex', 'claude'])
parser.add_argument('--executable', help='Installed client executable; default is the client name')
parser.add_argument('client_args', nargs=argparse.REMAINDER, help='Arguments after -- go to the client')
args = parser.parse_args()
root = Path(__file__).resolve().parent
settings = json.loads((root / 'connection.json').read_text(encoding='utf-8'))
environment = os.environ.copy()
key = environment.get(settings['env_key'])
if not key:
    parser.error('Gateway credential environment variable is missing')
executable = args.executable or args.client
extra = args.client_args[1:] if args.client_args[:1] == ['--'] else args.client_args
if args.client == 'codex':
    version = subprocess.run([executable, '--version'], text=True, capture_output=True, check=True).stdout.strip()
    if version != 'codex-cli ' + settings['codex_version']:
        parser.error('This generated catalog targets Codex ' + settings['codex_version'] + '; regenerate/qualify other versions separately')
    environment['CODEX_HOME'] = str(root / 'codex-home')
    command = [executable, '--profile', 'claude_proxy', *extra]
else:
    environment['ANTHROPIC_BASE_URL'] = settings['messages_base_url']
    environment['ANTHROPIC_AUTH_TOKEN'] = key
    # Do not let an inherited API credential or alternate cloud provider select another route.
    for name in ('ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK',
                 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'):
        environment.pop(name, None)
    command = [executable, '--model', settings['model'], *extra]
raise SystemExit(subprocess.call(command, env=environment))
'''


def generate(manifest: dict, stock_prompt: str, output: Path, responses_url: str, messages_url: str) -> Path:
    validate_manifest(manifest)
    stock_prompt = stock_prompt.replace('\r\n', '\n')
    if hashlib.sha256(stock_prompt.encode('utf-8')).hexdigest() != PROMPT_SHA256:
        raise ValueError('Stock prompt does not match the pinned Codex 0.160.0 source')
    responses_url = validate_url(responses_url, responses=True)
    messages_url = validate_url(messages_url, responses=False)
    output = output.absolute()
    # No merge/overwrite mode: generation can never replace a user's existing config.
    output.mkdir(parents=False, exist_ok=False)
    codex_home = output / 'codex-home'
    codex_home.mkdir()
    catalog_path = codex_home / 'models.json'
    files = {
        catalog_path: json.dumps(build_catalog(manifest, stock_prompt), ensure_ascii=False, indent=2) + '\n',
        codex_home / 'config.toml': render_codex_config(manifest, catalog_path, responses_url),
        output / 'launch.py': LAUNCHER,
        output / 'connection.json': json.dumps({
            'model': manifest['model'], 'codex_version': CODEX_VERSION,
            'responses_base_url': responses_url, 'messages_base_url': messages_url, 'env_key': ENV_KEY,
        }, indent=2) + '\n',
        output / 'qualification.json': json.dumps({
            'manifest': manifest, 'codex_source_commit': CODEX_COMMIT,
            'stock_prompt_sha256': PROMPT_SHA256, 'stock_prompt_source': PROMPT_URL,
            'generated_not_certified': True,
            'reasoning_policy': 'No effort mapping is advertised; the proxy owns its configured native thinking budget.',
            'context_warning': None if manifest['context_window'] is not None else
                'Context limit is unverified. Automatic context-based compaction has no declared threshold; do not treat this as long-session qualification.',
            'proxy_prerequisites': ['RESPONSES_ENABLED=true', 'RESPONSES_APPLY_PATCH_MODE=validated',
                                    'RESPONSES_DEVELOPER_MESSAGE_MODE=hoist', 'persistent state key'],
            'limits': ['Text-only profile; no hosted search, automatic paid fallback or provider entitlement change.',
                       'Tool declarations enable client tools; evidence status does not certify provider reliability.',
                       'Codex home is isolated; global MCP/plugins/preferences are not copied.',
                       'Claude settings remain layered; verify the selected gateway/authentication in /status.',
                       'Client flags and managed/project settings remain user-owned; inspect overrides before use.'],
        }, ensure_ascii=False, indent=2) + '\n',
    }
    for path, content in files.items():
        with path.open('x', encoding='utf-8', newline='\n') as handle:
            handle.write(content)
    return output


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True, help='New directory under an existing parent; never overwritten')
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument('--stock-prompt', type=Path, help='Exact pinned source prompt, usable offline')
    source.add_argument('--download-stock-prompt', action='store_true', help='Explicitly download pinned public Codex source only')
    parser.add_argument('--responses-base-url', default=DEFAULT_RESPONSES_URL)
    parser.add_argument('--messages-base-url', default=DEFAULT_MESSAGES_URL)
    args = parser.parse_args(argv)
    try:
        manifest = validate_manifest(json.loads(args.manifest.read_text(encoding='utf-8')))
        # Refuse existing output before a source download or other work.
        if args.output.exists() or args.output.is_symlink():
            raise ValueError('Output already exists; choose a new directory')
        prompt = load_stock_prompt(args.stock_prompt, args.download_stock_prompt)
        result = generate(manifest, prompt, args.output, args.responses_base_url, args.messages_base_url)
    except (OSError, ValueError) as error:
        # Do not echo manifest contents, URLs or credential values.
        print(f'Profile generation failed ({type(error).__name__}); check inputs and output path.', file=sys.stderr)
        return 2
    print(f'Created opt-in profiles at {result}; no client was started and no inference was requested.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
