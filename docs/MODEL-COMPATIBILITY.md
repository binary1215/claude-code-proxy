# Current Claude model compatibility

Verified on 2026-11-11 against the authenticated Han model catalogue and the
official [thinking configuration](https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting),
[effort](https://platform.claude.com/docs/en/build-with-claude/effort), and
[tool-workflow](https://platform.claude.com/docs/en/build-with-claude/thinking-tool-workflows)
contracts.

## Discovery and transport

`GET /v1/models` reads the upstream catalogue, including newly released IDs;
there is no fixed model list to regenerate. The authenticated catalogue currently
includes `claude-fable-5-2`, `claude-haiku-5-5`, `claude-sonnet-5-5`, and
`claude-opus-5-5`, each reporting 1,000,000 input tokens and 128,000 output tokens.
Catalogue visibility is not an inference or subscription-entitlement test.

Native Messages requests retain their original model ID, thinking policy,
parameters and bytes. The optional official CLI is used for authentication and
refresh, so installing a newer CLI is not how native HTTP model IDs are enabled.

The Responses adapter uses verified, exact-ID request policies. These are not a
catalogue or access allowlist. Unknown IDs still work under the previous bounded
contract; provide explicit supported native options when required. Gateway
aliases such as `claude-fable-5-2-han` belong in LiteLLM. A direct/pass-through
Responses request must use the upstream ID `claude-fable-5-2`.

## Responses defaults and options

| Model | Default adapter thinking | Explicit lower-thinking mode | Effort levels |
| --- | --- | --- | --- |
| Fable/Mythos 5.2, 5.1, 5; Opus 5.5 | Adaptive | Always on | low, medium, high, xhigh, max |
| Opus 5; Haiku 5.5 | Adaptive | `disabled` at high effort or below | All five |
| Sonnet 5.5 | Adaptive | `between_tools` at high effort or below | All five |
| Sonnet 5; Opus 4.8/4.7 | Adaptive | `disabled` | All five |
| Opus/Sonnet 4.6 | Existing manual budget; an explicit Responses effort selects adaptive | `disabled` | low, medium, high, max |
| Older and unknown IDs | Existing manual/default-budget contract | Existing contract | Explicit matching native options required |

Known policies accept up to **128,000** requested output tokens. The unknown/older
contract retains its 65,536 adapter ceiling. The global
`RESPONSES_MAX_OUTPUT_TOKENS` ceiling is now 128,000; the default stays 8,192.
Request-level validation still uses the selected model's adapter policy.
`RESPONSES_THINKING_BUDGET_TOKENS` applies to manual defaults, not adaptive models;
its existing maximum remains 65,535. A small output budget includes thinking and
can finish before visible answer text is produced.

For a known adaptive model, Responses effort maps to the **same native label**,
without guessing a token budget or requiring duplicate extension fields:

```json
{
  "model": "claude-fable-5-2",
  "input": "Explain this change.",
  "reasoning": { "effort": "low" },
  "max_output_tokens": 4096,
  "store": false
}
```

This produces native `thinking: {"type":"adaptive"}` and
`output_config: {"effort":"low"}`. Explicit native options remain available;
conflicting efforts fail rather than silently overriding a caller's choice.
Known adaptive policies also accept `display: "summarized"` or `"omitted"`.

`reasoning.effort: "none"` emits a real native `thinking: {"type":"disabled"}`
where the model supports it. Always-on models reject it. Sonnet 5.5's
`between_tools` is not equivalent to disabling all thinking and must be requested
explicitly through `anthropic.thinking`. Disabled/between-tools modes reject
`xhigh` or `max` where the model requires adaptive thinking at those levels.

Forced tool choices remain model-specific. Fable/Mythos 5.2/5.1, Opus 5.5 and
Sonnet 5.5 require `auto` or `none`. Verified other adaptive policies accept forced
tools; manual enabled thinking retains the previous restriction. Client tools
continue to execute only in the client.

## Replay and migration limits

The original thinking, signed-empty and redacted blocks remain in authenticated
Responses capsules. Fable 5.2 checks the preceding system, tools and messages on
every account; keep that prefix and the producing account/model unchanged.
Start a fresh conversation when switching models. See the official
[Fable 5.2 changes](https://platform.claude.com/docs/en/models/fable-5-2/whats-new-fable-5-2)
and [preserved-thinking rules](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking).

This update does not add provider fallback translation, binding-control beta
metadata, arbitrary new block types or server-side compaction to Responses.
Unsupported semantics still fail explicitly. Native Messages can carry upstream
extensions unchanged. The existing response/block limits, capsule lifetime and
client-history responsibilities still apply; see [the adapter contract](RESPONSES-ADAPTER.md).

Optional profile manifests for the latest models are provided at
[Fable 5.2](../integration/clients/profiles/metadata.fable-5-2.example.json) and
[Haiku 5.5](../integration/clients/profiles/metadata.haiku-5-5.example.json).
Their context limits come from the authenticated catalogue and official model
documentation; they do not certify client coding quality or automatic compaction.

## Verification on 2026-11-11

- Windows backend: 204 passed, one Linux-only helper skipped. The built Linux
  CLI-auth image passed all 205 backend tests, including 16 new-model regressions.
  Profile-generator tests passed 11/11.
- Han received source `532e003` while retaining its data/auth volumes, private
  settings and login-session binding. Its existing 19 refresh successes and zero
  refresh failures survived the update. Other containers were preserved.
- The LiteLLM owner added `claude-fable-5-2-han` and `claude-haiku-5-5-han` using
  the existing Han credential, adaptive thinking, 1M input and 128K output
  metadata. Existing model entries, keys and routes were retained.
- One bounded direct Responses check per latest model reached upstream but all
  four returned HTTP429 `rate_limit_error`. There was no specific error code,
  Retry-After or quota header; the recorded classification is `unknown_429`.
  This did not establish account-quota exhaustion. Actual answer generation
  and Fable's real signed-state follow-up were unconfirmed in that run. No retry or
  identity/account/model fallback was used.

See the [sanitized evidence](evidence/20261111-current-models.json). Offline
compatibility and deployment success are separate from provider acceptance.

## Actual managed-gateway client tests on 2026-11-12

An unmodified official Claude Code **2.1.322**, verified against the official npm
archive integrity, ran in fresh isolated test containers through the existing
shared LiteLLM **managed `/v1/messages`** endpoint to Han. The model names were
`claude-fable-5-2-han`, `claude-haiku-5-5-han`, `claude-sonnet-5-5-han`, and
`claude-opus-5-5-han`. All four produced the expected short answer with HTTP200.
The production auth CLI and gateway settings were not changed.

Fable 5.2 passed a resumed two-turn marker conversation and a separate
medium-effort arithmetic probe. The probe returned a signed thinking block;
the next actual client request replayed that block exactly and its follow-up
returned HTTP200 and the correct answer. Han observed 3233/3326 cache-read tokens
on the probe's first/follow-up turns. These are provider counters, not invoice
savings or a controlled quality comparison. The full client prefix changed on
resume; only the recorded thinking-block equality is claimed.

The request-only `x-litellm-num-retries: 0` override prevented the gateway's
default two retries. Han's history matched exactly **7 successful official-client
requests and 5 generic-HTTP requests returning429**. A raw Haiku control still
returned429 after official-client success. This narrows the observation to
request/client differences but does not identify which header, payload field or
other provider rule caused it. No identity was forged and no account/model
fallback was used.

This qualification covers genuine Claude Code text/reasoning through the managed
Messages path. It does not certify Codex, the separate Responses route, tools,
automatic compaction or long repository work. The observer captured only the
client/gateway wire, so gateway/Han byte identity is not inferred. See the
[sanitized actual-client receipt](evidence/20261112-han-managed-client-tests.json).
