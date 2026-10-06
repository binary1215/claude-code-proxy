# Codex coding-session qualification gaps

The original findings below came from **source review** and remain useful for
explaining the adapter's boundaries. Later synthetic and actual-provider results
are identified separately. Neither a short tool round trip nor bounded manual
compaction certifies an ordinary, full coding session.

Originally inspected client: Codex `0.160.0`, official `rust-v0.160.0` commit
`a956835d020762cb2b570053af06f643a11c0ecc`. Original proxy basis: `591e44d`.

## Current qualification status (2026-10-06)

| Scope | Observed result |
| --- | --- |
| Actual Codex through the shared `.7` gateway and `.64` relay to Haiku | A tool round trip, manual local compaction and two follow-up turns pass in each of two five-request runs; no Codex or LiteLLM source modification |
| Cache-eligible actual-provider fixture | Cache reads of 6,911 tokens on tool replay and 7,505 on the second post-compaction turn; changed-prefix compaction/first follow-up have cache misses |
| Corrected-signature synthetic adapter rerun at `ba227e2` | Two scenarios, four requests at each hop; ordered native signed/empty/redacted/tool state and reasoning-capsule replay pass |
| Corrected-signature synthetic hoist-compaction rerun at `ba227e2` | Five requests at each hop; manual compaction, two follow-ups and exact restored state pass |
| Actual Linux client file editing | After user-approved test-only namespace support, Codex creates and updates one fixture through .7 and real Haiku in four requests; actual fileChange events, tool results, file bytes and opaque replay pass |

The actual-provider runs used a temporary, bounded no-I/O tool catalog, not the
ordinary shell/apply-patch coding profile. They establish provider acceptance
of this compaction sequence, not automatic long-session behavior, measured
quality or billed savings. The separate patch-only fixture establishes bounded
file-edit success, not ordinary shell or multi-file repository work. Live signed-empty/redacted blocks
were not emitted; those remain synthetic coverage. Gateway accounting still
recorded zero tokens/spend rather than the observed provider usage.

See [live evidence](evidence/client-live-20261006.json),
[actual file-edit evidence](evidence/client-patch-live-20261006.json),
[deployment and scope details](VERIFICATION.md#actual-shared-gateway-clients-2026-10-06)
and the [corrected-signature summary](evidence/corrected-signature-qualification-20261006.json).
The corrected fixtures use complete `signature_delta` values with SDK replacement
semantics, not concatenated signature parts. Earlier split-part concatenation
was an unsupported oracle assumption, not evidence of a client defect. Historical
reports are retained; the single-signature live results are unaffected.

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
No normal user editing profile has been replaced; isolated tests use explicit
limited catalogs. Server-side execution of tools
remains out of scope, and grammar validity is not filesystem or patch-execution
validity.

The [actual coding-tool fixture](../integration/clients/README-codex-patch.md)
confirms signed-state and patch/result transport through stock LiteLLM. Its
malformed-patch negative passes, but the original valid file edit was denied by
the effective Windows read-only sandbox.

The operator subsequently enabled `validated` on the test relay, without changing
its image or other settings. The later isolated Linux preflight exposed the
actual freeform tool and replayed its result over two local fake-provider calls,
but file execution failed because the container could not create the required
sandbox namespace. No file was written and no real-provider edit phase ran.
The newly approved test-container namespace adjustment and rerun are pending;
neither approval nor successful transport is file-edit verification. See
[activation and Linux preflight](VERIFICATION.md#validated-patch-activation-and-linux-preflight-2026-10-06).

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
historical input. The original source review could not establish provider
acceptance from the Messages API's optional `tools` field alone. Subsequent
authorized Haiku tests through the shared gateway now establish acceptance of
the tested tool history, manual local compaction and two follow-up turns, in
both the short and cache-eligible five-request runs above. This does not extend
to arbitrary historical schemas or full coding sessions. Remote Responses
compaction remains unsupported.

The [actual app-server fixture](../integration/clients/README-codex-compaction.md)
now reproduces manual local compaction through unmodified LiteLLM: the CLI sends
`tools: []` with the same three reasoning capsules and prior function call/result;
the relay restores exact native blocks without `tools`, and compaction completes.
The historical default-`reject` baseline completes this bounded synthetic subset,
then fails on the next ordinary user turn at the late-developer boundary below;
its strict exit remains 1. The corrected-signature `ba227e2` rerun in opt-in
`hoist` mode instead passes compaction and two follow-ups over five requests,
with unchanged stock LiteLLM and no hidden retry. Both are bounded observations,
not whole-session acceptance.

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
developer relocation. The next authorization was limited to **testing proxy-only
developer-to-top-level-system relocation**. Separate later approvals covered
the test deployment, bounded actual-provider runs and optional apply-patch mode;
the initial test permission did not imply those actions. Codex remains unchanged.

Implementation: `RESPONSES_DEVELOPER_MESSAGE_MODE=hoist` collects developer text
without deduplication or rewriting, preserving instruction encounter order and
remaining message/tool order. Default `reject` and native Messages stay unchanged.
All hoist-mode capsules additionally bind the effective system digest. A changed
prefix with existing capsules fails 409 before provider contact; switching modes
also invalidates capsules. See the [exact contract](RESPONSES-ADAPTER.md#optional-developer-instruction-hoisting).
This is a semantic compatibility tradeoff, not lossless instruction placement,
guaranteed provider acceptance, cache savings, or whole-session qualification.

Historical hoist comparison at `1d9bbf7`: actual Codex through stock LiteLLM completes
manual compaction and **two** ordinary follow-up turns (five requests at each hop).
The late developer role remains in the actual client request; proxy translation
alone resolves the adapter rejection. System blocks are exact and equal before
compaction and both following turns in this fixture. Newly issued nonempty,
signed-empty and redacted reasoning replays exactly on the second follow-up.
The first follow-up has no old capsules. Default reject still reproduces 400
(four client, three fake-provider requests). See the
[complete comparison and evidence](../integration/clients/README-codex-compaction.md#opt-in-hoist-comparison-2026-10-05).

The corrected-signature rerun at `ba227e2` independently repeats the five-request
hoist sequence with complete signature events. It confirms exact initial and
post-compaction native assistant state, system blocks and tool-result order;
the first post-compaction input intentionally has no old reasoning capsules,
and newly issued reasoning replays on the second follow-up. This supersedes the
older split-part signature oracle, without rewriting its evidence. Actual Haiku
acceptance is separately established by the live runs above, whose fixed-system
fixture does not prove all possible mode/developer-instruction changes.

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

The source review did not install a user catalog/profile. Later tests used
isolated temporary catalogs and did not alter the normal client profile. Local
compaction after a no-I/O tool turn and further user turns now pass against the
real provider. A separate actual-provider Linux patch-only profile now passes
fixture creation and update. The ordinary shell/repository coding profile,
automatic long-session compaction and broader mode/developer-instruction changes
remain outside those results. See [whole-outcome scope](ACCEPTANCE.md).
