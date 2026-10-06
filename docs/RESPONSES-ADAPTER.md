# Opt-in Responses adapter, stock LiteLLM

This is a **new, bounded protocol adapter**, not the removed SDK backend or legacy
Chat translator. LiteLLM's source is unchanged. It does not run Claude Code,
execute tools, impersonate an official client, retry a provider request, strip
rejected signatures, or switch models/accounts.

```text
Claude Code / native client → LiteLLM /claude-native → native /v1/messages
Codex / Responses client   → LiteLLM /claude-responses → new /v1/responses
                                                       ↓
                                            authorized Anthropic upstream
```

Use two non-colliding pass-through namespaces. Do not send the Codex path through
LiteLLM's normal Responses-to-Chat-to-Anthropic conversion: the pinned audit
detects signed-history loss there. The default native deployment stays unchanged;
the new endpoint requires explicit enablement and a dedicated state key.

## Protocol and state contract

- Stream native thinking and signature fragments independently. A block closes
  only at `content_block_stop`; signed-empty and redacted blocks remain present.
- Each original thinking/redacted block becomes a Responses reasoning item.
  Its `encrypted_content` is a versioned AES-256-GCM capsule containing that
  exact native block. It is this relay's format, **not OpenAI ciphertext**.
- Put the complete capsule in `response.output_item.done` and keep the same item
  and capsule in `response.completed.output`. This follows the
  [OpenAI streaming replay contract](https://developers.openai.com/api/reference/resources/responses/streaming-events).
- On replay, decrypt the capsule and restore the original block, never visible
  summary text. Bind it to the validated relay-key fingerprint, exact native
  model ID, upstream URL/credential digest and reasoning item ID. Changed,
  foreign or expired capsules fail before provider contact.
- The client owns conversation history. There is no conversation database or
  `previous_response_id` store. Changing an item's summary does not change its
  authenticated native content. This authenticates individual opaque blocks,
  not the entire conversation: a client that omits a whole item cannot have it
  reconstructed. Clients must replay all returned items in order.
- Final success/incomplete events are held until the native stream and framing
  finish cleanly. Unknown block/event semantics, malformed tool JSON, model
  changes, truncation and provider errors do not become a successful completion.
- Use fresh/cache-write/cache-read counts separately in relay history. Standard
  Responses input counts sum them only when all are reported. Native usage is
  also returned as `anthropic_usage`; unknown reasoning-token splits are omitted,
  not guessed as zero. No price is fabricated. This is not a LiteLLM spend-log
  or budget-accounting implementation.

Only the client holds these ciphertext capsules. The relay's existing history
keeps neither plaintext conversations nor capsules. A client can still persist
visible thinking/text in its own session files. AEAD protects capsule contents,
not the rest of an unencrypted LAN connection: use trusted networks/TLS.

## Enable in the proxy container

Use the existing `compose.adapter.yml` and a private env file:

```dotenv
RESPONSES_ENABLED=true
RESPONSES_STATE_KEY=<canonical-base64-of-32-random-bytes>
RESPONSES_STATE_TTL_SECONDS=604800
RESPONSES_MAX_OUTPUT_TOKENS=8192
RESPONSES_THINKING_BUDGET_TOKENS=1024
RESPONSES_APPLY_PATCH_MODE=reject
RESPONSES_DEVELOPER_MESSAGE_MODE=reject
```

Generate a separate cryptographic random state key through your normal secret
provisioning. Never use the admin secret, a provider token, or a committed sample
key. Enabling the adapter with an invalid/missing state key fails startup. With
the feature disabled, `/v1/responses` returns 404.

Preserve the state key across restarts and replicas **only within one intended
trust boundary**. Matching relay credentials must also be shared if replay is
expected across replicas. A shared LiteLLM-to-relay key gives all callers that
same relay principal; it does not provide per-virtual-key isolation. Use separate
relay keys/routes where that isolation is required. Never trust a caller-supplied
user header for the capsule's identity binding.

Default capsule validity is seven days; supported TTL is 60 seconds to 30 days.
Rotating the state key, provider credential, upstream URL or relay key invalidates
old capsules. There is no silent migration/fallback or old-key ring. Plan rotation
around active conversations. Capsule expiry is unrelated to provider prompt-cache
TTL. The maximum request is 10 MiB; native response total is 8 MiB, each SSE event
and content block is bounded to 1 MiB, and at most 512 output blocks are supported.

The default native thinking policy is a 1024-token enabled budget with an
8192-token output limit; `0` disables the default budget. Model capability must
be verified. An explicit request `anthropic.thinking` can select an authorized
native policy. The adapter does not guess what a model supports or turn a
provider rejection into a different model or thinking mode.

### Optional Codex apply_patch grammar adaptation

`RESPONSES_APPLY_PATCH_MODE=reject` is the default. An operator may explicitly
select `validated` after accepting **post-generation validation**, which is not
equivalent to provider-side constrained decoding. This setting does not enable
Responses by itself or affect the native Messages endpoint.

Validated mode recognizes only the exact `apply_patch` Lark grammar emitted by
Codex 0.160.0 at commit `a956835d020762cb2b570053af06f643a11c0ecc`, including its
optional Environment ID variant. Altered/unknown grammars, syntax types and tool
names are rejected before provider contact; arbitrary grammars are never run.
Both the LF source asset and the exact CRLF spelling observed from the pinned
official Windows executable are recognized; mixed/arbitrary whitespace variants
are not. The caller's exact recognized grammar definition is retained in the
native tool description. This does not normalize CRLF in patch input itself.
Namespaces retain their existing reversible name mapping.

The native tool uses `{input: string}`. The property description includes the
exact grammar and the tool description distinguishes the JSON transport wrapper
from the raw patch string. All custom input is buffered until the native block
ends, checked against the bounded grammar, then returned without normalization.
Invalid output yields `invalid_tool_grammar` (streaming `response.failed`, or an
HTTP 502 for nonstreaming). No patch input delta, input-done or completed tool
item for that invalid call is emitted. There is no repair, hidden retry or
unconstrained-text fallback. Replayed patch inputs with a current grammar
definition are validated as well. The raw patch limit is 1 MiB; existing encoded
JSON/event/block limits can reject a smaller raw patch with escaping overhead.

This preserves the syntax of accepted calls, **not generation success rate,
token cost, sampling distribution, filesystem safety or successful application**.
For example, the pinned grammar allows a header-only Update hunk that the actual
CLI executor rejects. Paths and permissions remain the client's responsibility;
the proxy never reads files or applies patches. Checks are per tool call, not a
transaction: an earlier completed tool in the same response might already have
executed before a later invalid call fails. Provider acceptance and real coding
quality remain separate gates. See the [grammar attribution](../licenses/CODEX-NOTICE.md).

### Optional developer instruction hoisting

`RESPONSES_DEVELOPER_MESSAGE_MODE=reject` retains the existing initial-prefix-only
contract. The explicit experimental `hoist` option also accepts **developer**
messages after user/assistant/tool history. It changes only the proxy's Responses
adapter; native Messages, Codex and LiteLLM are not modified. Late `system`
messages remain rejected. Unknown option values fail startup.

The effective top-level native system contains request `instructions` first,
then all accepted system/developer text blocks in their input encounter order.
Text, duplicates and per-block cache markers are kept, with no deduplication or
new prompt. User/tool data is never promoted; the relative order of remaining
history is unchanged (adjacent same-role messages still merge as before).
This deliberately changes where developer instructions apply. It is **not**
lossless instruction-hierarchy or model-behavior equivalence.

Every capsule minted in hoist mode is additionally AEAD-bound to a policy-tagged
digest of the exact translated system blocks, including cache markers. The full
system is collected before any capsule is opened. A changed/added/removed
instruction, including an added duplicate, causes replay to fail with HTTP 409
`invalid_reasoning_state` before provider contact. There is no deletion of
thinking, re-signing, hidden retry, or automatic new session. A text-only compacted
history without old capsules may establish a new scope, and subsequent unchanged
system requests can replay the new capsules. This check is conservative: it is
not provider-signature verification or a digest of all history/tools.

`reject` and `hoist` capsules are intentionally incompatible in **both** directions,
even for requests with only initial instructions or no system at all. Changing
the mode requires a fresh conversation or client-produced compaction that no
longer replays old capsules. Existing reject-mode capsules keep their original
format/binding; no deployment is switched automatically.

Hoisting does not guarantee cache savings. The cache hierarchy is tools, system,
then messages; changing the effective system invalidates downstream cached
content. Stable subsequent translated prefixes remain eligible, but actual hits
depend on provider rules and explicit cache controls. See the
[official invalidation rules](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#what-invalidates-the-cache).
Instruction changes with retained reasoning therefore remain an explicit failure
boundary, not universal long-session compatibility. Synthetic tests cannot prove
real Anthropic acceptance, costs or answer quality.

## Configure the unmodified gateway

An owner-applied YAML change and reload are required for dynamic header forwarding
on the pinned stock version. This example is **not applied to the shared server**:

```yaml
general_settings:
  pass_through_endpoints:
    - path: /claude-responses/v1/responses
      target: http://YOUR_RELAY_HOST:13456/v1/responses
      methods: [POST]
      include_subpath: false
      auth: true
      forward_headers: true
      headers:
        Authorization: os.environ/CLAUDE_PROXY_AUTHORIZATION
        x-api-key: ""
```

`CLAUDE_PROXY_AUTHORIZATION` contains `Bearer <relay-key>`. It is not the caller's
gateway key or the provider token. Provision a narrowly scoped gateway key using
the normal admin workflow and verify its route grants. Set the relay key's
`allowed_models` to the intended native model IDs; custom pass-through bypasses
LiteLLM's managed-model allowlist. Authentication, route policy and accounting
have separate acceptance requirements; see [the policy audit](../integration/litellm/README.md).
Do not disable authentication or change license flags to work around the UI.

## Codex configuration

Use a separate user-level provider/profile and an environment-supplied gateway
key. Replace the placeholder with an authorized **exact native model ID**, not a
LiteLLM model alias. The adapter rejects a different model reported upstream.

```toml
model = "YOUR_AUTHORIZED_NATIVE_MODEL_ID"
model_provider = "claude_relay"
web_search = "disabled"

[model_providers.claude_relay]
name = "Claude via stock LiteLLM"
base_url = "http://YOUR_GATEWAY_HOST:4000/claude-responses/v1"
wire_api = "responses"
env_key = "LITELLM_API_KEY"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
stream_idle_timeout_ms = 300000
```

Do not inherit a conflicting global reasoning-effort setting. Effort is not
silently translated into an arbitrary Anthropic token budget. `none` disables
thinking; `low`/`medium`/`high` require explicit native adaptive thinking with the
same `output_config.effort`. Other values are rejected. Some models do not support
adaptive thinking, so use their explicit enabled-budget policy instead.

Clients unable to add JSON extension fields can supply the same native options
as a bounded `x-claude-proxy-native-options` JSON header. For example, to explicitly
request automatic 5-minute prompt caching, add **under the provider table**:

```toml
http_headers = { "x-claude-proxy-native-options" = '{"cache_control":{"type":"ephemeral","ttl":"5m"}}' }
```

An adaptive policy can use a header such as
`{"thinking":{"type":"adaptive"},"output_config":{"effort":"high"}}`
with matching `model_reasoning_effort="high"`. Set the latter before the TOML
provider table. Body `anthropic` and this header are mutually exclusive; they are
never merged with an implicit precedence. Header options are validated by the
same closed schema and are not forwarded as an HTTP header to Anthropic.
Codex's [official configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
documents custom provider headers.

Cache controls remain **caller-requested**, not a restored legacy per-key TTL.
Neither cache policy is added by default nor is `prompt_cache_key` treated as an
Anthropic cache breakpoint. Both `5m` and `1h` native TTLs are accepted when
explicitly requested. Cache writes can cost money, and a cache marker is not a
hit guarantee: minimum prefix size, matching content, model and provider policy
still apply. See [Anthropic caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

## Supported subset and explicit rejections

Supported: stateless POST Responses, streaming/nonstream text, initial
system/developer prefixes, explicitly opt-in late-developer hoisting as above,
user/assistant text, HTTPS/inline input images,
function tools (including namespaces), free-text custom tools, optionally the
exact validated Codex apply_patch grammar described above, tool results,
signed reasoning replay, caller cache controls, native thinking options, and
key/model authorization. Images are passed to the provider, never fetched by
the relay; local files, file IDs, and non-auto detail conversion are rejected.
Function arguments are syntax-checked JSON objects, not locally schema-executed.
Tools always run in the client, never in this container.

Historical calls do not need to remain in the current `tools` list. The adapter
reconstructs their existing deterministic function/custom/namespace transport
identity, preserves call/result order and signed reasoning, and does not invent
schemas or re-enable those tools. Only current definitions authorize new provider
tool calls and explicit `tool_choice`. Ambiguous native-name collisions across
history and current definitions fail. `tools: []` (or no tools field) therefore
leaves native `tools` and `tool_choice` absent even when tool history is present.

This is not tool-history attestation: calls/results are client-authored, and an
absent old schema or grammar cannot be recovered. Custom history retains the
raw string in the existing `{input: string}` transport wrapper; a name such as
`apply_patch` alone never implies a grammar. If a matching current definition
declares a recognized grammar, its historical inputs are still validated.
Changing current tool definitions may also change the provider's cache prefix.
Do not infer real provider acceptance or cache savings from this translation.

Unsupported: Chat Completions, saved/previous responses, background jobs,
Responses compaction, WebSockets, built-in server tools/search, arbitrary grammar tools,
strict tool-schema guarantees, structured output, automatic truncation, arbitrary
future block types and late system-message relocation. These return explicit
errors instead of silently changing semantics. Long-running Codex sessions are
**not certified** by a short tool smoke. The pinned custom-provider client uses
local compaction with empty current tools; the history-only translation above
removes the former current-definition validation conflict. It does not implement
the remote `/responses/compact` endpoint or prove upstream acceptance of local
summarization. Apply-patch mode requires an explicit operator choice
and further real-provider qualification. Developer hoisting is a separate opt-in
with the replay and semantic limitations above, not general instruction-change
support. See [coding-session qualification gaps](CODEX-QUALIFICATION.md).
Initial system/developer messages necessarily share Anthropic's system channel;
this is not a claim that the providers have identical instruction hierarchies.

Preserved signed state is not authorization to use a subscription token from an
arbitrary third-party client. This feature supplies no new provider entitlement
and leaves credential selection unchanged. Use a permitted credential/model
combination; an API-key billing decision or gateway rollout remains separate.

## Verification

### Native response metadata contract

The adapter explicitly accepts the documented `container`, `diagnostics` and
`stop_details` message fields after bounded shape validation. Present values,
including nulls, are retained under the response-only `anthropic_metadata`
extension. Native terminal `stop_reason`/`stop_sequence` are also retained.
Container/stop details update from `message_delta`; a null delta container does
not erase a previously reported container. Unknown fields and invalid metadata
still fail explicitly. The extension is not logged, replayed as prompt content,
included in reasoning capsules, or a promise that clients preserve extensions.
It does not enable server-side tools or container reuse.

Native `refusal` or non-null refusal details result in `response.failed` with the
fixed `provider_refusal` code, original partial output and native metadata. They
never produce `response.completed` or trigger relay retries/model fallback.
Nonstream returns HTTP 200 with the same structured failed result, not a
transient HTTP 502. This is an explicit adapter failure contract, **not** an
OpenAI-native `refusal` content-item translation or a normal successful answer.
Reported usage counters remain available; an error history row is not marked
complete. Changing or clearing observed refusal details is rejected.
As with other late stream failures, already emitted tool items cannot be
retracted. A client that executes a tool before the response terminal may already
have acted when a later refusal arrives. This adapter neither executes those
tools nor guarantees client-side rollback; client tool authorization remains
necessary. No claim of refusal-safe speculative execution is made.

Nullable input/cache counters in native usage deltas mean no new measurement,
not zero; earlier reported cumulative values remain. Present counters replace,
never add. Null server-tool/output-token breakdown updates likewise leave earlier
breakdowns intact. Malformed, negative or decreasing input/output/cache counters
still fail; other native usage breakdowns remain opaque in `anthropic_usage`.

Absent/null/empty text citations normalize to no annotations. Omitted or explicit
`caller: {type: "direct"}` (and null `toolset_name`) normalize to the existing
direct, client-executed tool-call contract. These default field-presence differences
are not byte-preserved. Actual citations, server-tool callers and non-null toolsets
remain unsupported and cannot be silently discarded or run as client tools.
Thinking/signature blocks, tool arguments, identifiers and ordering are not
rewritten by this normalization.

Sources: [Anthropic Messages schema](https://platform.claude.com/docs/en/api/messages/create),
[official SDK types](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/messages/messages.ts),
[official cumulative stream handling](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/lib/MessageStream.ts).
This schema correction still requires a new real-provider qualification; the
earlier failed capture did not record its third extra message key or values.

### Regression and client checks

The HTTP/unit tests cover capsule mutation/scope/expiry, signed-empty/redacted
replay, fragmented UTF-8/signatures/tool JSON, block order, namespace/custom tool
mapping, cache controls, accounting uncertainty, exact-once upstream rejection,
timeouts/cancellation, safe history, and failure without a success terminal.

The actual Codex 0.160.0 smoke can exercise the complete isolated chain:

```sh
python integration/clients/codex_smoke.py --route adapter --codex /path/to/codex --output /new/temp/evidence
```

It starts the built relay and an unmodified stock LiteLLM gateway with synthetic
credentials and a loopback fake provider. Both normal signed thinking and
signed-empty/redacted tool turns require exact native replay and identical opaque
items at incremental completion, full completion and client replay. Default
exit is nonzero on any fidelity failure. `--route stock` retains the earlier
negative baseline. This verifies protocol mechanics, not real signatures,
provider eligibility, actual cache savings, production gateway policy or billing.
