# Actual Codex apply_patch loopback smoke

This bounded fixture uses actual Codex CLI **0.160.0**, pristine stock LiteLLM
**1.103.1** authenticated custom-route pass-through, and the actual built relay
with explicit `RESPONSES_APPLY_PATCH_MODE=validated`. The relay executes no tools.
Only the client can apply a patch, and the sole requested target is the relative
synthetic `fixture.txt` inside a new temporary workspace. No shell tool is
advertised by the fixture catalog and no shell invocation is requested.

## Reproduce

Build the application first using the normal project build. Use the existing
pristine stock-LiteLLM Python, an existing pinned Codex executable, and Node:

```powershell
& 'C:/Users/binary/AppData/Local/Temp/litellm-stock-validation-6ba742dda05a477cb8351cf0ac54ff333/Scripts/python.exe' `
  integration/clients/codex_patch_smoke.py `
  --codex 'C:/Users/binary/.local/bin/codex.exe' `
  --node 'C:/Users/binary/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' `
  --output 'C:/Users/binary/AppData/Local/Temp/codex-patch-NEW-UNIQUE-NAME'
```

The output directory must not exist and must be under the system temp directory,
outside the repository. The fixture copies no existing auth/settings. Each case
has new `CODEX_HOME`, home/config/data directories and workspace; the environment
is allowlisted. The client uses `--ignore-user-config --ignore-rules --ephemeral`,
`workspace-write` (never bypass), disabled search/analytics/update checks and no
configured OTEL exporter. The new bootstrap uses an in-memory DB and random
local relay/auth/capsule keys. Gateway and relay credentials are distinct and
must not reach the fake Anthropic endpoint. Logs redact these generated keys.

LiteLLM is started by the existing unmodified `boot_gateway.py`; only free,
authenticated configured pass-through is exercised, not enterprise Responses
conversion. The report verifies 13 relevant installed stock source identities
before and after; it does not claim a hash of every installed dependency.

## Catalog and exact contract

The explicitly labeled synthetic catalog has exactly the native model ID
`claude-sonnet-4-20250514`, `shell_type: disabled`, and
`apply_patch_tool_type: freeform`. These fields exist solely to expose the pinned
CLI's actual custom tool to a loopback fixture. They are **not GPT metadata
attributed to real Claude**, nor evidence of real model coding capability.

The catalog shape was checked against pinned official
[ModelInfo and ModelsResponse](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/protocol/src/openai_models.rs#L376).
The offered tool is the actual CLI `custom`/`grammar`/`lark` apply_patch descriptor,
not the separate built-in Responses `apply_patch_call` protocol. Its definition
is recorded in `responses-wire.json`; native JSON wrapping and tool history are
recorded in `fake-requests.json`. The grammar source is the pinned
[apply_patch.lark](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/core/assets/tools/apply_patch.lark).
The Windows executable offered the exact official definition with CRLF line
ends. The relay accepts that known definition spelling without normalizing the
model's patch input.

## Two bounded cases and acceptance

The valid case sends signed nonempty thinking, signed empty thinking, redacted
thinking, and one tool_use in that order. Signature and tool JSON deltas are
fragmented into multiple SSE events; the fake writes UTF-8/CRLF SSE in 7-byte
pieces (TCP can coalesce them). Next-turn native assistant blocks must exactly
equal the issued blocks, and reasoning IDs/capsules must match across
`output_item.done`, `response.completed`, and client history. The actual tool
result must be resent. File content and the complete workspace file list are
checked independently of the CLI's final text/exit status.

The malformed case omits the patch terminator for the same relative target.
It must produce `response.failed`, never deliver a completed custom call, never
create a file, and fail the client turn. This is a syntax test, **not** a test of
path traversal, multi-file policy or filesystem security.

Report predicates are deliberately separate:

- `transport_state_subset_pass`: actual tool offer, isolated local auth, tool
  result/history roundtrip, exact opaque state, final event and stock identity.
- `coding_tool_subset_pass`: additionally actual `workspace-write` and exactly
  one created file with exact expected bytes. A final marker alone cannot pass.
- `malformed_patch_rejected_before_client_execution`: the negative syntax gate.

Exit zero requires both coding-tool and negative predicates. There is no
observe-only success mode. Raw synthetic tool-result text is evidence, not a
success classifier: a rejected client tool can return an ordinary custom output
string without an `is_error` flag.

## Observed local limitation (2026-10-05)

Existing executable: `codex-cli 0.160.0`, SHA-256
`fdda5fa3cf3fb3d000b876720742857676293e4315e4b045fae6f8bd7e866d1d`.
This records the existing binary's identity; no new installation, binary patch
or signature/supply-chain attestation was performed.

Initial baseline failed before provider access because the adapter did not yet
accept the official Windows CRLF grammar spelling. After that narrowly scoped
adapter fix, both cases ran against the real chain. Evidence directory:
`C:/Users/binary/AppData/Local/Temp/codex-patch-chain-grammar-b6745f41079c4ca48264886d738a2436/`.

The valid case had two requests per hop, no catalog fallback, no shell tool,
exact ordered native replay including signed-empty/redacted, exact capsules,
and correct isolated fake-provider authentication. However, the effective CLI
permission profile was **read-only**, despite `--sandbox workspace-write`.
The actual tool result was:

```text
patch rejected: writing is blocked by read-only sandbox; rejected by user approval settings
```

The workspace stayed empty. The CLI nevertheless returned 0 and a final marker;
the harness correctly returned **1**, not coding-tool success. The malformed
case returned `response.failed`, delivered no custom-call done event, wrote
nothing and failed the client turn: the intended negative passed.

Pinned source explicitly downgrades Windows workspace-write when its sandbox
implementation is disabled:
[effective_sandbox_mode](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/config/src/config_toml.rs#L728).
[Windows mode mapping](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/core/src/windows_sandbox.rs#L55)
maps `windows.sandbox=unelevated` to a restricted-token sandbox. Official
[Windows sandbox documentation](https://learn.chatgpt.com/docs/windows/windows-sandbox)
describes ACL effects for unelevated mode and users/firewall/local-policy setup
for elevated mode. Neither setup nor a permission bypass was performed. A
separately approved, suitably isolated native sandbox/runtime is still required
for an actual successful file edit; this report is not whole-goal acceptance.

The stored run predates final reporting-name/telemetry-disable cleanup. Its old
`tool_result_success` only checked protocol shape; the final source replaces it
with `tool_result_replayed` and independently requires real file creation for
`tool_execution_success`. The unmodified run remains evidence rather than being
retroactively rewritten.

HEAD independently reran the final reporting/telemetry-control version at
`C:/Users/binary/AppData/Local/Temp/codex-patch-final-20261005/`. It reproduced the
same read-only denial, exact replay and blocked malformed patch, with exit 1.
The final report explicitly records `transport_state_subset_pass:true`,
`coding_tool_subset_pass:false`, and
`malformed_patch_rejected_before_client_execution:true`.

No real provider/auth/account files, real cryptographic signature acceptance,
entitlement, billing, cache hits, long sessions, deployment or broad coding
workflow were tested. All configured providers are loopback, but the run did
not have OS-level network capture/deny enforcement; do not infer a proven
zero-egress property for all internal CLI/dependency telemetry. The final
source explicitly disables the documented telemetry/update controls.
