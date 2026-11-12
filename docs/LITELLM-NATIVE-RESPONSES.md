# Native Responses model routing through LiteLLM

Use separate model aliases for native Messages and Responses clients. Both use
the ordinary authenticated LiteLLM API and the same Han proxy; protocol
conversion for Codex belongs to the proxy's Responses adapter.

```text
Claude Code -> LiteLLM /v1/messages  [claude-opus-5-5-han]
            -> Han /v1/messages -> genuine CLI inference
Codex       -> LiteLLM /v1/responses [claude-opus-5-5-responses-han]
            -> Han /v1/responses -> native Messages -> genuine CLI inference
```

## Configuration

Merge the selected entries from
[native-responses.example.yaml](../integration/litellm/native-responses.example.yaml)
into the existing gateway, or register the equivalent deployment through its
supported model-management API. No LiteLLM or installed client source patch is
needed. This uses standard model routing rather than a custom Enterprise
pass-through endpoint.

The Responses deployment uses `openai/claude-opus-5-5`, API base ending in `/v1`,
and the proxy key. LiteLLM sends the canonical model ID to Han. Its `openai/`
prefix selects native Responses; `model_info.mode: responses` and
`supported_endpoints: ["/v1/responses"]` document the intended endpoint. See
[LiteLLM's native Responses configuration](https://docs.litellm.ai/docs/response_api_native_passthrough).

Keep the existing Messages alias on the Anthropic provider and root API base.
If a named credential includes its own `api_base`, check the resolved deployment
value: it must not replace the Responses base with the root Messages base.
Do not append `/responses` or `/v1/messages` to either configured base.
Use an existing stable proxy-key identity so reasoning capsules remain valid.

Set the Codex provider's base URL to `http://YOUR_LITELLM_HOST:4000/v1`, its wire
API to `responses`, and model to `claude-opus-5-5-responses-han`. Use a LiteLLM
client key there, never an Anthropic token or Han's upstream credential.
No ordinary Codex configuration is changed by the qualification harness.

## State and compatibility

The old Anthropic-backed managed Responses route can construct item-done and
final reasoning separately. The native Responses deployment instead selects
Han's adapter. It is still necessary to test the resulting gateway stream:
supported routing alone does not prove preservation of every extension.

Clients must send their full history, including reasoning items with
`encrypted_content`. Han does not persist responses for `previous_response_id`.
Keep the proxy state key, API-key identity, model and upstream account stable
throughout a conversation; do not move existing signed histories to a different
model. Start a fresh session when changing from the former managed-conversion
route because its reasoning encoding is not Han's capsule format.

`supported_endpoints` describes routing capability; do not treat it as a
credential access-control list. Retain the gateway's ordinary model permissions.
This Responses-only alias is not a Chat Completions backend. Native client
options and other custom headers require their own forwarding verification.
The inspected LiteLLM 1.109.0 OpenAI and OpenAI-like Responses configuration
removes `cache_control` from input/tool objects. CLI-managed prompt caching is
separate: check returned cache counters instead of assuming caller cache markers
survive. Provider cache counters are evidence of reuse, not proof of invoice
accuracy or gateway spend/budget enforcement.

The deployed gateway does not enable encrypted-content affinity through its
supported router settings. In the inspected version, enabling
`optional_pre_call_checks: ["encrypted_content_affinity"]` can wrap terminal
reasoning IDs differently from item events. Revalidate event IDs and replay
before enabling that independent routing feature; native Responses support
alone is not a guarantee for every affinity configuration.

## Verification and rollback

The [2026-11-12 Opus receipt](evidence/20261112-native-responses-opus.json)
records successful actual Codex and Claude Code reasoning tasks through the
deployed gateway. Codex's item-done, final output and next input preserve the
same signed state; native Claude Code replays five exact returned thinking
blocks. Both clients pass their bounded tool/compaction/follow-up workflows
and observe cache reads. The earlier simple tasks and failed native fixture
startup are retained separately instead of being counted as replay evidence.

Run the [bounded real Codex sequence](../integration/clients/README-live-codex.md)
with `--gateway-route-kind native-responses`, the exact new alias and a fresh
private output directory. Its five calls cover a client-owned tool, local
compaction and two follow-ups. Compare reasoning IDs and encrypted state both
between item-done and final events and against actual subsequent client input.
Keep absence of thinking separate from a passing replay observation.
Use `--reasoning-fixture` for the deterministic arithmetic follow-ups used by
the successful Opus run; the default trivial markers may emit no thinking.

Verify the existing Messages alias with the genuine Claude Code client as an
independent regression. Preserve failed receipts and distinguish functional
success from signed-state qualification. Do not export credentials, reasoning
contents or capsules into public evidence.

Rollback removes only the newly registered Responses deployment and returns
clients to their prior configuration. Existing Messages deployments, keys and
proxy state stay in place. The former Responses conversion route retains its
documented signed-state limitation; rollback does not fix it.
