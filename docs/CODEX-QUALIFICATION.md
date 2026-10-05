# Codex coding-session qualification gaps

The passing actual-Codex smoke verifies a short synthetic tool round trip. It
does not certify a full coding session. The following findings come from
**source review**, not a newly executed long-session/provider test.

Inspected client: Codex `0.160.0`, official `rust-v0.160.0` commit
`a956835d020762cb2b570053af06f643a11c0ecc`. Proxy basis: `591e44d`.

## 1. apply_patch grammar

The client has only the `Freeform` apply-patch tool variant. Its tool definition
uses `format.type=grammar` with `syntax=lark`; the proxy currently rejects
grammar tools explicitly. This is different from the supported free-text custom
tool subset. See the pinned
[enum](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/protocol/src/openai_models.rs#L322)
and [actual tool definition](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/core/src/tools/handlers/apply_patch_spec.rs#L18).

A catalog with `apply_patch_tool_type:null` can omit that tool while allowing
ordinary shell functions through `shell_type:unified_exec`. That changes the
editing workflow; it is not transparent apply-patch compatibility. Do not
silently replace grammar with unconstrained text or modify the user's normal
client profile to hide this limitation.

The next implementation decision is an explicitly bounded, validated grammar
adapter versus a user-approved reduced tool profile. Neither is implemented by
this source review. Server-side execution of tools remains out of scope.

## 2. Local compaction after tool turns

The configured custom provider is neither OpenAI nor Azure. In this client,
[provider capabilities](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/model-provider/src/provider.rs#L461)
select **local compaction**, not `/responses/compact`. The local summarization
request uses the existing history, but
[constructs a default Prompt](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/core/src/compact.rs#L257)
whose [tool list is empty](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/core/src/client_common.rs#L45).
The history can still contain reasoning capsules, calls and results.

The current request adapter requires matching current tool definitions for
historical calls. Thus source-level request construction conflicts with proxy
validation after tool use. Merely documenting remote compaction as unsupported
does not describe the default custom-provider limitation accurately.

Before changing this contract, distinguish historical tool identity/schema from
currently callable tools, preserve opaque state, and test the actual provider's
acceptance of the resulting native history. The Messages API's optional `tools`
field alone does not prove that empty current definitions plus historical client
tool calls will be accepted. No successful real compaction is claimed.

## 3. Mid-conversation developer instructions

Mode changes and managed developer-policy changes can append developer messages
after conversation history. The pinned client explicitly assigns the
[developer role to mode instructions](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/core/src/context/world_state/collaboration_mode.rs#L158).
The adapter currently accepts system/developer messages only in the initial
prefix; later ones fail instead of being moved earlier or demoted to user text.

Anthropic now documents [mid-conversation system messages](https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages)
for selected models, including Opus 5.5. This is a potential native mapping,
not a universal feature or an implemented proxy capability. A model-specific
contract must validate placement, role semantics and cache behavior. Do not
assume support for Haiku or other models, or rewrite the original system prefix.

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
