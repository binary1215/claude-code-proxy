# Actual coding-client compatibility checks

Required clients: **Claude Code and Codex**. OpenCode is an additional comparison,
not a substitute for either required client. Only free, supported stock LiteLLM
features are in scope. No LiteLLM source patch, SDK/CLI proxy backend, identity
spoofing, paid-key fallback, or production replacement is implied by these tests.

## Current evidence

| Client / route | Evidence | Remaining gap |
| --- | --- | --- |
| Claude Code 2.1.289 → native test relay → real Claude | Earlier isolated Opus control succeeded with a real cache hit | Actual `.7` route, tool-rich multi-turn acceptance, gateway policy/accounting |
| Claude Code 2.1.289 → stock pass-through → native relay → fake Anthropic | Single-signature-event control preserves signed/empty/redacted/tool history; real Read and final answer succeed | Split-signature-event stress loses a fragment in the client; stock route removes top-level metadata; not whole-body fidelity |
| Codex 0.160.0 → stock LiteLLM 1.103.1 Responses → fake Anthropic | Actual CLI completes a tool round trip, but signed reasoning is lost | **Not fidelity-compatible on this tested route**; real authorization also unresolved |
| Codex 0.160.0 → stock LiteLLM pass-through → new proxy Responses adapter → fake Anthropic | Both tool round trips preserve exact ordered thinking/signature/signed-empty/redacted/tool history | Real authorization, actual `.7` rollout, long coding sessions/compaction, gateway accounting |
| OpenCode 1.18.34 → fake Anthropic directly | Actual CLI preserves tested signed/redacted history and tool replay | Signed-empty blocks, stock gateway chain, real upstream, cache/accounting |

See [project verification](../../docs/VERIFICATION.md) for live-test boundaries,
and [OpenCode instructions](README-opencode.md) for its separate smoke test.
The [Claude Code harness](README-claude-code.md) distinguishes its passing
single-event state subset from split-event and whole-body preservation losses.
None of these rows establishes universal client compatibility or a measured
quality/cost improvement.

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

Two cases emit fragmented signature deltas: nonempty thinking; and nonempty,
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
3. Independently, the completed response's opaque content is already incorrect:
   two signature fragments become separate thinking blocks, with duplicated
   thinking text. Signed-empty thinking is lost in aggregation as well.

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
and the next actual client request. Split signatures concatenate once;
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
provider's **local** compaction also has an unresolved historical-tool contract,
alongside apply-patch grammar and later developer instructions. See the
[source-qualified gaps](../../docs/CODEX-QUALIFICATION.md).
See [adapter design, configuration and limitations](../../docs/RESPONSES-ADAPTER.md).
