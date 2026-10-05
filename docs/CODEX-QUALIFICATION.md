# Codex coding-session qualification gaps

The passing actual-Codex smoke verifies a short synthetic tool round trip. It
does not certify a full coding session. The original findings below came from
**source review**. Implementation updates are identified separately; none is
a newly executed long-session/provider qualification.

Inspected client: Codex `0.160.0`, official `rust-v0.160.0` commit
`a956835d020762cb2b570053af06f643a11c0ecc`. Proxy basis: `591e44d`.

## 1. apply_patch grammar

The client has only the `Freeform` apply-patch tool variant. Its tool definition
uses `format.type=grammar` with `syntax=lark`; the proxy rejects
grammar tools by default. This is different from the supported free-text custom
tool subset. See the pinned
[enum](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/protocol/src/openai_models.rs#L322)
and [actual tool definition](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/core/src/tools/handlers/apply_patch_spec.rs#L18).

A catalog with `apply_patch_tool_type:null` can omit that tool while allowing
ordinary shell functions through `shell_type:unified_exec`. That changes the
editing workflow; it is not transparent apply-patch compatibility. Do not
silently replace grammar with unconstrained text or modify the user's normal
client profile to hide this limitation.

Implementation update: the optional `RESPONSES_APPLY_PATCH_MODE=validated`
recognizes the exact pinned grammar and optional Environment ID variant, wraps
raw input in native JSON, and validates it before emitting tool input or done
events. Unknown grammars still fail. Stream/nonstream/replay and HTTP tests cover
positive cases and invalid-patch rejection without hidden retry or content repair.
This is post-generation checking, **not constrained sampling**; failure rate and
token usage need not match GPT. The default remains `reject` until an operator
explicitly accepts that distinction. See the [full contract](RESPONSES-ADAPTER.md#optional-codex-apply_patch-grammar-adaptation).
No reduced editing profile has been installed. Server-side execution of tools
remains out of scope, and grammar validity is not filesystem or patch-execution
validity.

The [actual coding-tool fixture](../integration/clients/README-codex-patch.md)
now confirms signed-state and patch/result transport through stock LiteLLM.
Its malformed-patch negative passes, but the valid file edit was denied by the
effective Windows read-only sandbox. This is not successful editing or provider
qualification; no permission bypass or OS setup was used to make the test pass.

## 2. Local compaction after tool turns

The configured custom provider is neither OpenAI nor Azure. In this client,
[provider capabilities](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/model-provider/src/provider.rs#L461)
select **local compaction**, not `/responses/compact`. The local summarization
request uses the existing history, but
[constructs a default Prompt](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/core/src/compact.rs#L257)
whose [tool list is empty](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/core/src/client_common.rs#L45).
The history can still contain reasoning capsules, calls and results.

The original request adapter required matching current tool definitions for
historical calls, conflicting with this construction after tool use.
Implementation update: a separate history-only identity registry now restores
function/custom/namespace call transport without populating currently callable
tools or inventing missing schemas. Native-name collisions and malformed history
still fail; forced choices and new provider calls require current definitions.
Signed state is restored using the same authenticated codec. Unit/HTTP fixtures
cover empty/omitted/replaced tool lists, exact signed-state replay and rejection
of a new call to a removed tool, in both streaming and nonstream modes.

An absent old schema/grammar remains unknown; history is client-authored, not
attested execution provenance. A matching current grammar still validates
historical input. Actual provider acceptance of the resulting native history is
a separate gate: the Messages API's optional `tools` field alone does not prove
that empty current definitions plus historical client tool calls are accepted.
No successful real-provider compaction is claimed. Remote Responses compaction
remains unsupported.

The [actual app-server fixture](../integration/clients/README-codex-compaction.md)
now reproduces manual local compaction through unmodified LiteLLM: the CLI sends
`tools: []` with the same three reasoning capsules and prior function call/result;
the relay restores exact native blocks without `tools`, and compaction completes.
An independent final-source rerun confirms this bounded synthetic subset. The
next ordinary user turn fails at the late-developer boundary below in default
`reject` mode, so that baseline's strict exit remains 1. The later opt-in hoist
comparison passes the bounded continuation sequence, not whole-session acceptance.

## 3. Mid-conversation developer instructions

Mode changes and managed developer-policy changes can append developer messages
after conversation history. The pinned client explicitly assigns the
[developer role to mode instructions](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/core/src/context/world_state/collaboration_mode.rs#L158).
By default the adapter accepts system/developer messages only in the initial
prefix; later ones fail instead of being moved earlier or demoted to user text.
An explicit experimental developer-only hoist mode is described below.

This is now also an **executed finding**, not only a possible mode-change issue.
After the manual compaction above, the actual client sends retained user text,
the user-role summary, a developer skills/permissions message, a user environment
message and the new user prompt. The adapter returns HTTP 400
`unsupported_parameter` before upstream contact. Exactly four client requests
and three fake-provider requests occur, without retry or instruction relocation.

Anthropic now documents [mid-conversation system messages](https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages)
for selected models, including Opus 5.5. This is a potential native mapping,
not a universal feature or an implemented proxy capability. A model-specific
contract must validate placement, role semantics and cache behavior. Do not
assume support for Haiku or other models, or rewrite the original system prefix.

The documented native placement is narrower than an arbitrary Responses
developer message: a mid-conversation system message must follow a user turn
(or an assistant server-tool-result turn), then either end the message list or
precede an assistant turn. A `user → developer → user` sequence therefore cannot
be fixed by simply renaming `developer` to `system`. Moving the instruction,
merging it into ordinary user text, or rewriting the initial prefix changes the
contract; no such automatic fallback is used. Model support alone is insufficient.

Earlier operator direction on 2026-10-05 prohibited Codex modification and
developer relocation. The later request explicitly authorizes **testing proxy-only
developer-to-top-level-system relocation**. Codex remains unchanged; this does not
authorize deployment, real-provider charges, or the separate apply-patch mode.

Implementation: `RESPONSES_DEVELOPER_MESSAGE_MODE=hoist` collects developer text
without deduplication or rewriting, preserving instruction encounter order and
remaining message/tool order. Default `reject` and native Messages stay unchanged.
All hoist-mode capsules additionally bind the effective system digest. A changed
prefix with existing capsules fails 409 before provider contact; switching modes
also invalidates capsules. See the [exact contract](RESPONSES-ADAPTER.md#optional-developer-instruction-hoisting).
This is a semantic compatibility tradeoff, not lossless instruction placement,
guaranteed provider acceptance, cache savings, or whole-session qualification.

Executed hoist comparison at `1d9bbf7`: actual Codex through stock LiteLLM completes
manual compaction and **two** ordinary follow-up turns (five requests at each hop).
The late developer role remains in the actual client request; proxy translation
alone resolves the adapter rejection. System blocks are exact and equal before
compaction and both following turns in this fixture. Newly issued nonempty,
signed-empty and redacted reasoning replays exactly on the second follow-up.
The first follow-up has no old capsules. Default reject still reproduces 400
(four client, three fake-provider requests). See the
[complete comparison and evidence](../integration/clients/README-codex-compaction.md#opt-in-hoist-comparison-2026-10-05).

## Model metadata is necessary but insufficient

A matching `model_catalog_json` can remove the generic metadata fallback. The
[official rollout guidance](https://learn.chatgpt.com/docs/enterprise/roll-out-a-gateway#use-a-model-catalog-for-custom-names)
requires metadata to match the actual model, gateway and client version. The
catalog cannot add provider capabilities or solve the three translation gaps.

Use the exact native model ID, no implicit model upgrade, and truthful tool,
reasoning and transport capabilities. Do not copy a GPT context window or
instruction template and present it as verified Claude metadata. The native
context limit, compaction threshold, instructions, thinking policy and any
reduced editing workflow still need explicit qualification.

No catalog/profile was installed by this review. Next acceptance must include
real coding-tool input/output, local compaction after a tool turn, a further
user turn and a mode/developer-instruction change, in addition to the existing
short signed-state test. See [whole-outcome gates](ACCEPTANCE.md).
