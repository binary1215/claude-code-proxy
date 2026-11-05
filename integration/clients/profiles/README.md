# Client connection profiles

The static snippets are opt-in **connection settings**, not copies of the
synthetic test clients. They contain no model catalog, replacement system prompt,
User-Agent override, fixture-only tool restriction or sandbox/approval change.
The optional generator below adds an explicitly described native-model catalog
and isolated launcher. Nothing here installs or modifies a client or changes the
shared LiteLLM server.

Use an unexpired **LiteLLM gateway key**, supplied privately as
`CLAUDE_PROXY_GATEWAY_KEY`; do not give clients the proxy's internal API key or
Anthropic credential. Test keys are short-lived; verify the selected key's current
expiry instead of assuming a key from an earlier run is still valid. Route permission
must include the exact path selected below. A gateway key does not grant
provider entitlement, and a passing local test does not remove an upstream
subscription restriction.

| Client | Base URL | Resulting model endpoint |
| --- | --- | --- |
| Claude Code, native Messages | `http://192.168.0.7:4000/claude-native` | `/claude-native/v1/messages` |
| Codex, Responses | `http://192.168.0.7:4000/claude-responses/v1` | `/claude-responses/v1/responses` |
| OpenCode, bundled OpenAI Responses | `http://192.168.0.7:4000/claude-responses/v1` | `/claude-responses/v1/responses` |

Do not append another `/v1`. These are the project's existing LAN endpoints;
HTTP has no transport encryption and is not an Internet deployment suggestion.
The two formats coexist. LiteLLM authenticates/routes; this proxy owns Responses
translation and reasoning restoration. Ordinary LiteLLM `/v1/responses` model
conversion is not interchangeable with this route.

## Codex

Merge the two uniquely named tables from [codex.toml](codex.toml) into a private
Codex config without replacing existing content. If those names already exist,
review the overlap first. Select explicitly with `codex --profile claude_proxy`.
The environment key is resolved when the process starts; it is not embedded in
TOML. Existing approval and sandbox settings remain in effect.

This follows the official [custom-provider configuration](https://learn.chatgpt.com/docs/config-file/config-advanced#custom-model-providers)
and [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).
Responses HTTP/SSE is selected explicitly and retry counts are zero so a failed
turn is visible, not silently replayed. Hosted web search is not implemented by
this proxy. No fake GPT model identity or synthetic catalog is supplied.

Proxy-side prerequisites for the already agreed coding flow:

- `RESPONSES_ENABLED=true`, persistent state key and unchanged upstream identity.
- `RESPONSES_DEVELOPER_MESSAGE_MODE=hoist` for the tested local-compaction
  continuation shape. This is an explicit semantic policy, not a client patch.
- `RESPONSES_APPLY_PATCH_MODE=validated` for Codex's freeform patch tool, with
  actual file permission still enforced by Codex. See the
  [adapter contract](../../../docs/RESPONSES-ADAPTER.md).

Codex 0.160.0's ordinary custom-model fallback was exercised in the two-case
adapter smoke without a custom catalog, and reports a metadata fallback warning.
The stronger manual-compaction and Linux file-edit qualifications use separate,
explicitly limited catalogs. They do **not** establish every normal-profile tool
or later Codex version. Keep those coverage boundaries when adopting this
profile; a connection snippet is not whole-client certification.

## Generate an isolated ordinary coding profile

[generate_client_profiles.py](../generate_client_profiles.py) creates a **new**
directory containing a Codex home/config/catalog, a Claude Code launcher, and
qualification notes. It does not start a client, call a model, install a package,
copy saved credentials, or overwrite an existing directory. Python 3.11+ is
needed for the tests; the generated launcher uses only the standard library.

Start with [metadata.example.json](metadata.example.json), copied to a private
path if you want to supply additional evidence. Its native Haiku model ID matches
the existing route. `context_window:null` deliberately means **unverified**; it
is not a claimed unlimited context window or a copied GPT limit. Set a positive
token limit only with a corresponding `context_evidence` reference for that exact
model/provider. A null limit leaves context-based automatic compaction without a
declared threshold: qualify a real limit before adopting long sessions.
Capability statuses are records of evidence, not switches that hide tools. The
example's shell/editing statuses remain unverified until the ordinary coding
workflow is actually tested; its bounded thinking replay evidence is narrower.

```powershell
python integration/clients/generate_client_profiles.py `
  --manifest integration/clients/profiles/metadata.example.json `
  --output 'C:/private/claude-coding-profile' `
  --download-stock-prompt
```

The parent of `--output` must exist; the output itself must not. The optional
download fetches **only the pinned public Codex source prompt**, with no gateway
credential. For offline generation, replace `--download-stock-prompt` with
`--stock-prompt PATH` pointing to the exact source file; LF and CRLF checkouts are
accepted. Responses/Messages URL overrides are available in `--help`, with the
same path rules as the static snippets.

The generated catalog targets Codex **0.160.0** at commit
`a956835d020762cb2b570053af06f643a11c0ecc`, based on its
[fallback descriptor](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/models-manager/src/model_info.rs)
and [model schema](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/protocol/src/openai_models.rs).
It retains the [stock generic instructions](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/models-manager/prompt.md)
verbatim, advertises ordinary `unified_exec` shell plus `freeform` apply_patch,
uses the native Claude ID and `upgrade:null`, and does not borrow GPT context or
reasoning metadata. The existing proxy `validated` patch/`hoist` prerequisites
above still apply. No reasoning effort picker is advertised: the proxy owns its
configured native thinking budget, and encrypted thinking replay remains in use.
This first profile is text-only and does not advertise hosted search or image
capabilities. See the official [catalog rollout guidance](https://learn.chatgpt.com/docs/enterprise/roll-out-a-gateway).

Supply the gateway credential privately in `CLAUDE_PROXY_GATEWAY_KEY`, then
explicitly launch from the workspace you want the client to operate in:

```powershell
python 'C:/private/claude-coding-profile/launch.py' codex
python 'C:/private/claude-coding-profile/launch.py' claude
# A non-PATH executable must be selected before the client positional argument:
python 'C:/private/claude-coding-profile/launch.py' --executable 'C:/tools/codex.exe' codex
# Client arguments follow --; they are the caller's deliberate overrides.
python 'C:/private/claude-coding-profile/launch.py' claude -- --continue
```

The Codex child receives an isolated `CODEX_HOME`; your normal chats, MCP/plugin
setup and preferences are not copied or modified. Its version is checked against
the catalog. No sandbox or approval policy is set by the generated profile; use
the client's ordinary controls for the workspace. The Claude child receives the
native gateway base URL and bearer token, without persisting either credential.
Inherited competing Anthropic API/OAuth credentials and alternate-cloud selector
variables are removed **only from that child environment**; the parent shell is
unchanged. Claude's managed/project settings still apply: verify `/status` before
using the route. This is not client isolation from its managed/project policy.

`qualification.json` records unknowns, metadata evidence and proxy prerequisites.
Generation is not certification of reliable tools, automatic compaction, provider
entitlement, or billed savings. Keep the generated directory private because a
subsequently launched client may create its own conversation/session state there.

Local verification on 2026-10-24: actual Codex 0.160.0 `model/list` parsed the
generated catalog with the native ID, text modality and no migration. Although
its picker reports the empty reasoning-effort list's default as `none`, all
seven requests in the bounded offline workflow sent `reasoning:{summary:"auto"}`
without `effort`; the native side retained `thinking:{type:"enabled",
budget_tokens:1024}`. This confirms profile/wire behavior against the scripted
loopback provider, not real-provider reasoning quality. The same run could not
execute the file/shell workflow under the existing Windows read-only policy;
catalog parsing and protocol passage must not be reported as successful coding
task completion. No client permissions were changed to obtain these observations.

## OpenCode Responses

Use [opencode-responses.json](opencode-responses.json) as an explicit configuration
file, selected through `OPENCODE_CONFIG`, in a fresh shell/session. Do not replace
your normal global configuration. OpenCode merges configuration layers, so
review overlapping project/global settings; the example is not isolation.
Official [configuration and environment interpolation](https://opencode.ai/docs/config/)
describe this mechanism.

The provider ID is intentionally the bundled `openai` provider: in tested
OpenCode 1.18.34 it chooses `sdk.responses()`. `openai-compatible` chooses Chat
Completions and is **not** a substitute. The native Claude model ID is retained,
along with default client prompt selection; `store:false` and encrypted reasoning
replay are requested explicitly. See the
[pinned provider implementation](https://github.com/anomalyco/opencode/blob/aec0b9a6d8898f68f923aaf08b7306d931fd9d76/packages/opencode/src/provider/provider.ts).

The `ccpr2` proxy supports this client's omitted external reasoning IDs without
discarding the encrypted state. The actual offline Read + tool result + resumed
follow-up passes. This does not overturn the separately observed **upstream
subscription-restriction 400**. Neither this profile nor the proxy impersonates
another client, changes provider authentication, or enables paid fallback.

## Claude Code native Messages

In a dedicated shell, pass the gateway key via its documented bearer variable:

```powershell
# CLAUDE_PROXY_GATEWAY_KEY must already have been supplied privately.
if (-not $env:CLAUDE_PROXY_GATEWAY_KEY) { throw 'Gateway key is missing' }
$env:ANTHROPIC_BASE_URL = 'http://192.168.0.7:4000/claude-native'
$env:ANTHROPIC_AUTH_TOKEN = $env:CLAUDE_PROXY_GATEWAY_KEY
claude --model claude-haiku-4-5-20251001
```

Do not put a real key in a committed settings file or command literal. The
documented bearer variable takes precedence over a saved personal login while
set, without deleting that login. Verify the selected base URL and credential
source in `/status`; close the dedicated shell afterward. Existing managed or
project settings can override shell values. See the official
[gateway connection instructions](https://code.claude.com/docs/en/llm-gateway-connect).
This profile leaves Claude Code's tool approvals and instructions unchanged.

The native relay preserves signed thinking/tool blocks; the stock gateway's
known top-level `metadata` removal remains. Current offline regression proves
the tested state subset, not whole-request transparency.

## Diagnose before spending inference

The sibling [connection diagnostic](../check_gateway_connection.py) can check
the Responses route without inference; run its `--help` for exact arguments.
It distinguishes expired credentials/route denials from a recognizable
proxy-side validation response. Reachability and route authentication do not
prove the Anthropic token, model entitlement, cache charging or working model
output. Use the bounded live harness only after a deliberate authorization and
with an unexpired key; do not reinterpret missing usage as zero cost.

If a client sends old `ccpr1` capsules **without** their IDs, start a new
conversation: those historical values cannot be recovered. `ccpr1` with its
original ID can still replay during the format migration. Keep the state key,
model, effective instructions and upstream identity stable for retained history;
changing them can intentionally invalidate old state.
