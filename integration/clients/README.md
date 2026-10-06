# Actual coding-client compatibility checks

Required clients: **Claude Code and Codex**. OpenCode is an additional comparison,
not a substitute for either required client. Only free, supported stock LiteLLM
features are in scope. No LiteLLM source patch, SDK/CLI proxy backend, identity
spoofing, paid-key fallback, or production replacement is implied by these tests.

## Current evidence

| Client / route | Evidence | Remaining gap |
| --- | --- | --- |
| Claude Code 2.1.289 → actual `.7` native pass-through → `.64` → real Haiku | Three requests: Read + resumed user follow-up, exact signed-state replay, cache reads 4628 / 4865; relay usage matches | Client removes tool `caller` metadata; no live signed-empty/redacted or split-signature emission in this sample; broader editing/long sessions remain |
| Codex 0.160.0 → actual `.7` Responses pass-through → `.64` adapter → real Haiku | Five requests: get_goal tool, actual compaction, two follow-ups; exact opaque replay. Eligible-prefix run reads cache 6911 / 7505 | Limited no-I/O profile, not ordinary shell/apply_patch coding; gateway usage/spend is not accounted |
| Linux Codex 0.160.0 apply_patch → actual `.7` → `.64` validated adapter → real Haiku | Four requests: actual fixture creation and same-thread update, two successful fileChange/tool results, exact file bytes, five observed opaque-state checks | Patch-only profile; no shell or multi-file repository task. Short input has zero cache reads/writes; relay usage matches, gateway accounting separate |
| OpenCode 1.18.34 → actual `.7` native pass-through → `.64` → real Haiku | Single request reached provider, returned 400 third-party plan/extra-usage restriction | Not a protocol-format error; no retry, client impersonation or paid fallback authorized |
| Claude Code 2.1.289 → native test relay → real Claude | Earlier isolated Opus control succeeded with a real cache hit | Actual `.7` route, tool-rich multi-turn acceptance, gateway policy/accounting |
| Claude Code 2.1.289 → stock pass-through → native relay → fake Anthropic | Single-signature-event control preserves signed/empty/redacted/tool history; real Read and final answer succeed | Historical split-part concatenation oracle was incorrect, not a client defect; stock route removes top-level metadata; not whole-body fidelity |
| Codex 0.160.0 → stock LiteLLM 1.103.1 Responses → fake Anthropic | Actual CLI completes a tool round trip, but signed reasoning is lost | **Not fidelity-compatible on this tested route**; real authorization also unresolved |
| Codex 0.160.0 → stock LiteLLM pass-through → new proxy Responses adapter → fake Anthropic | Both tool round trips preserve exact ordered thinking/signature/signed-empty/redacted/tool history | Real authorization, actual `.7` rollout, long coding sessions/compaction, gateway accounting |
| Codex 0.160.0 apply_patch → stock pass-through → validated adapter → fake Anthropic | Real freeform grammar and signed-state replay preserved; malformed patch blocked before delivery | File editing denied by actual Windows read-only policy; not coding-tool success, real provider or rollout proof |
| Codex 0.160.0 manual local compaction → stock pass-through → adapter → fake Anthropic | Default reject reproduces late-developer 400. Explicit hoist passes compaction + two follow-ups with exact system and opaque replay | Real-provider acceptance, automatic compaction, dynamic instruction changes with old capsules and long sessions unqualified; hoist is a semantic opt-in |
| OpenCode 1.18.34 → fake Anthropic directly | Actual CLI preserves tested signed/redacted history and tool replay | Signed-empty blocks, stock gateway chain, real upstream, cache/accounting |
| OpenCode 1.18.34 → stock pass-through → native relay → fake Anthropic | Single-signature-event controls preserve signed-nonempty/empty/redacted/tool state; real Read succeeds; tested request bodies and SSE remain exact across the chain | Historical split-part concatenation oracle was incorrect, not a client defect. Metadata absent in these requests, so known stock metadata removal is not exercised; real provider rejected the live comparison |

See [project verification](../../docs/VERIFICATION.md) for live-test boundaries,
and [OpenCode instructions](README-opencode.md) for its separate smoke test.
The [OpenCode gateway-chain harness](README-opencode-gateway.md) defaults to two
single-signature client cases, separating those controls from optional multiple-
signature-event stress and client-added cache controls from gateway preservation.
The [Claude Code harness](README-claude-code.md) distinguishes its passing
single-event state subset from non-normative split-event observations and
whole-body preservation differences. See the
[signature-oracle correction](../../docs/VERIFICATION.md#signature-oracle-correction-2026-10-06).
The [Codex coding-tool harness](README-codex-patch.md) separately gates transport
replay, actual file editing, and invalid-patch rejection.
The [manual compaction harness](README-codex-compaction.md) separates
history preservation during compaction from the next ordinary user turn; the
opt-in hoist path now also passes the bounded real-provider sequence above.
None of these rows establishes universal client compatibility or a measured
quality/cost improvement.

Live runners: [Claude Code](README-live-claude-code.md),
[Codex](README-live-codex.md), [OpenCode](README-live-opencode.md),
and the separate [Linux Codex patch preflight/live runner](README-live-codex-patch.md).
They use the already deployed routes and an approved gateway key supplied by an
environment-variable name; no installation, normal client configuration edit,
provider credential export or gateway restart is performed. Each writes a safe
report and retains its separate synthetic client session outside the repository.

## Codex + stock Responses reproduction

Use an existing official Codex executable and the pristine stock
`litellm[proxy]==1.103.1` environment described in the
[gateway audit](../litellm/README.md). Do not point the fixture at a live gateway.

```sh
python integration/clients/codex_smoke.py --codex /path/to/codex --output /new/temp/evidence
```

The default `--route stock` retains the negative baseline. Build the proxy first
(`npm run build`) and select the implemented adapter path with:

```sh
python integration/clients/codex_smoke.py --route adapter --codex /path/to/codex --output /new/temp/adapter-evidence
```

The adapter fixture starts an isolated built Node relay with fresh synthetic
relay/admin/provider keys and a random state key. A separate authenticated stock
pass-through route replaces the gateway key with the relay key. The real native
model ID is explicit; no model alias/fallback is used. All fixture processes are
stopped on completion. No `.7` settings or real provider credentials are used.

The default exit status is **nonzero when fidelity fails**, even if the CLI
finishes normally. `--observe-only` permits exit zero for a completed diagnostic
run with a negative fidelity result. Always inspect `observation_completed` and
`full_fidelity` separately in `codex-smoke.json`.

The harness creates a private home/config/workspace, ignores user configuration
and project rules, runs an ephemeral read-only Codex session, and removes
inherited provider credentials. Its fake model requests only the read-only
`get_goal` tool, never shell/file/network tools. The selected client must expose
that tool; otherwise the fixture fails rather than substituting an unsafe tool.
The client and gateway use loopback URLs and synthetic credentials. This is
configuration isolation, **not an OS-enforced egress sandbox**. The observer
forwards response bytes while changing HTTP transport framing; it is not a
production component or a wire-framing fidelity test.

Two cases emit one complete signature event per thinking block, with fragmented
transport bytes: nonempty thinking; and nonempty,
signed-empty, redacted thinking plus a tool call. The local fake returns a final
marker after a tool result so execution completion can be distinguished from
history preservation. It is not a real signature validator. Acceptance also
requires the exact ordered issued assistant content, one matching successful
tool result, exactly two requests at each hop, a completed turn and exact final
agent message, no fixture failure/key leak, and unchanged selected gateway
source files. The source guard covers 13 files, not the entire installed package.

Raw synthetic requests/SSE and client events stay in the selected new directory
outside the repository. They contain generated client instructions and dummy
thinking/signatures, not a user's actual project or provider conversation.

### Observed failure on 2026-10-05

Both scenarios completed exactly two requests and returned the expected marker.
Nevertheless `full_fidelity=false`:

1. LiteLLM's reasoning `response.output_item.done` has summary text but no
   `encrypted_content`. `response.completed.output` has opaque content later.
2. Actual Codex's next Responses request replays that reasoning ID and summary
   with `encrypted_content:null`. The subsequent Anthropic request contains the
   tool call but no thinking or redacted blocks.
3. The historical split-part fixture produced separate thinking blocks and
   duplicated text; its concatenation expectation was subsequently corrected
   against official SDK behavior. Signed-empty aggregation and missing
   incremental opaque state remain distinct observations, not validated by
   that discarded concatenation assumption.

The stock source explains both gateway-side defects:
[incremental reasoning completion](https://github.com/BerriAI/litellm/blob/580bde9a2d148714889ec1c04a9872819e78a778/litellm/responses/litellm_completion_transformation/streaming_iterator.py),
[Anthropic signature handling](https://github.com/BerriAI/litellm/blob/580bde9a2d148714889ec1c04a9872819e78a778/litellm/llms/anthropic/chat/handler.py),
and [thinking aggregation](https://github.com/BerriAI/litellm/blob/580bde9a2d148714889ec1c04a9872819e78a778/litellm/litellm_core_utils/streaming_chunk_builder_utils.py).
The Codex run also warns that the synthetic alias lacks custom model metadata;
this is a disclosed fixture limitation, not evidence that adding metadata would
repair these observed malformed gateway events.

Read-only inspection of the same relevant source in LiteLLM
[`v1.103.3`, `ecae261b100cdf6bcb1d024ae69e4efa4a891be0`](https://github.com/BerriAI/litellm/tree/ecae261b100cdf6bcb1d024ae69e4efa4a891be0)
found both defects still present. That version was not installed or runtime-tested.

An Anthropic-only relay cannot repair opaque state discarded between LiteLLM
and the client. The user subsequently authorized the new proxy-owned adapter
below. The negative baseline remains useful and is not overwritten by that work.

### Implemented adapter result on 2026-10-05

Actual Codex 0.160.0 → unmodified LiteLLM 1.103.1 pass-through → built new adapter
→ fake Anthropic passes both `signed_nonempty` and `full_opaque` cases. Each has
exactly two requests per hop, the requested read-only tool result and final
marker, and exact ordered native assistant replay. Complete authenticated
reasoning capsules are identical in `output_item.done`, `response.completed`
and the next actual client request. That historical run expected signature
concatenation; the current adapter instead follows SDK signature replacement.
Its normal fixtures now emit complete signatures with transport fragmentation;
signed-empty and redacted blocks are retained. No gateway/relay key reaches
the fake provider; 13 guarded stock files remain unchanged.

The adapter's encrypted capsules cannot be decoded by the stock plaintext
opaque-state check, so `completed_opaque_exact` is `null` for this route, not
false or an omitted acceptance requirement. Ciphertext identity and the exact
decoded **next native request** establish its round-trip test instead.
The custom-model metadata fallback warning remains disclosed. An initial run
failed because an empty `output_tokens_details` object lacked the Codex-required
`reasoning_tokens`; omitting the unknown split fixed it without fabricating zero.

This is a short synthetic protocol smoke, not a full coding session or provider
signature validation. Remote compaction is unsupported; the default custom
provider's **local** compaction now has a history-only tool translation and an
[executed optional hoist continuation fixture](README-codex-compaction.md#opt-in-hoist-comparison-2026-10-05).
These do not establish real-provider acceptance. Apply-patch has a separately opt-in
validated adapter and coding-tool fixture, not a completed live qualification. See the
[source-qualified gaps](../../docs/CODEX-QUALIFICATION.md).
See [adapter design, configuration and limitations](../../docs/RESPONSES-ADAPTER.md).
