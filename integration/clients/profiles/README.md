# Client connection profiles

These are opt-in **connection settings**, not copies of the synthetic test
clients. No model catalog, replacement system prompt, User-Agent override,
fixture-only tool restriction or sandbox/approval change is included. Nothing
here installs or modifies a client or changes the shared LiteLLM server.

Use an unexpired **LiteLLM gateway key**, supplied privately as
`CLAUDE_PROXY_GATEWAY_KEY`; do not give clients the proxy's internal API key or
Anthropic credential. The earlier 24-hour test key is expired. Route permission
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
