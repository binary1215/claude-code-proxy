# Actual Codex manual local compaction smoke

This fixture captures actual pinned Codex **0.160.0** app-server stdio RPCs,
through pristine stock LiteLLM **1.103.1** free authenticated configured
pass-through, the built proxy Responses adapter, and a loopback fake Anthropic
Messages endpoint. It is not a live-provider or whole-session acceptance test.

## Reproduce safely

Build the repository normally first. With existing binaries and the pristine
stock Python environment, use a NEW directory under the system temp directory:

```powershell
& 'C:/Users/binary/AppData/Local/Temp/litellm-stock-validation-6ba742dda05a477cb8351cf0ac54ff333/Scripts/python.exe' `
  integration/clients/codex_compaction_smoke.py `
  --codex 'C:/Users/binary/.local/bin/codex.exe' `
  --node 'C:/Users/binary/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' `
  --output 'C:/Users/binary/AppData/Local/Temp/codex-compaction-NEW-UNIQUE-NAME'
```

Default `--expect success` is strict: a failed post-compaction user turn returns
**1**, even when local compaction succeeds. Only explicitly selected
`--expect capture` allows zero for a completed observation; the report still
keeps `full_session_pass: false`. This diagnostic mode is not acceptance.

The guarded `codex_patch_smoke.py` helpers are reused for environment isolation,
stock identity checks, process cleanup, and synthetic SSE generation. The
existing default-reject `boot_responses_relay.mjs` starts the actual application
with an in-memory DB; no grammar opt-in or source monkeypatch is used. No
existing helper/source/config file is modified by this harness.

Each execution has new home/config/data/`CODEX_HOME` and workspace, allowlisted
environment, disabled analytics/feedback/update checks/OTEL exporters, disabled
search and agents, and `read-only`/`never` permissions. The app-server has no
`--ignore-user-config` option; it receives an empty fresh home and direct local
configuration overrides instead. The thread is persistent **only inside that
isolated temp home**, because actual `get_goal` rejects ephemeral threads. No
goal is set or mutated: success requires the exact returned no-goal JSON
structure with null goal/budget values. No shell, patch, image, other file or
external tool is called. Some untouched built-in descriptors such as view_image
may still be advertised on ordinary turns; the fixture never invokes them.

All configured providers and HTTP observers are loopback. Gateway/relay/fake
credentials are distinct and synthetic; captured evidence omits headers and
redacts generated local keys. No existing credentials or account state are
copied/read, no Windows sandbox setup/ACL/user/firewall changes are requested,
and no permission bypass is used. There is no OS-level network capture/deny
proof for arbitrary dependency internals, so this is not a zero-egress audit.

## Protocol and bounds

The harness performs the official app-server handshake, starts a fresh thread,
and sends one synthetic normal turn. Only the built-in no-I/O `get_goal` is
requested by the fake model. The fake emits nonempty signed thinking, empty
signed thinking, redacted thinking, and tool_use, with fragmented signature
deltas and 7-byte UTF-8/CRLF SSE writes. It then sends a final text marker after
the actual tool result is returned.

Next, the host explicitly requests `thread/compact/start`. It does not inject
history, replace client requests, or fabricate historical schemas. The fake
returns a deterministic text summary. Both `contextCompaction` lifecycle events
and the actual compaction turn terminal status must be observed. A separate,
ordinary `turn/start` then tests continuation; there is no mode/model change.

Limits: each request 1 MiB, each response capture 4 MiB, app-server stdout 5 MiB
or 1,500 messages, bounded RPC deadlines (30/45 seconds), and at most six HTTP
requests per observer/provider. The strict known-case gates require two initial
requests, one compaction request, and one further user request with no hidden
retry. Processes and local listeners are closed in `finally`. RPC notifications
are buffered so completion-before-ack ordering is not silently discarded.

The synthetic model catalog is explicitly labeled as a local fixture, with the
exact native slug, shell disabled and no apply_patch. It is not a claim that
real Claude possesses GPT/Codex metadata. Relevant contracts:

- [Official app-server manual compaction documentation](https://learn.chatgpt.com/docs/app-server#trigger-thread-compaction).
- [Pinned official model/catalog types](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/protocol/src/openai_models.rs#L376).

The pinned server requires `thread/start.sandbox: "read-only"`, not the
camel-case value shown in some current examples. An initial RPC-only attempt
captured that validation error; it made no provider/Responses HTTP requests.

## Observed candidate result (2026-10-05)

Final-source independent rerun evidence:
`C:/Users/binary/AppData/Local/Temp/codex-compaction-main-20261005/`.
Repository candidate: `98d26fef65ab8bc946c95e012d0c106fd7f02d39`.
Built request-adapter SHA-256:
`d9d0b6edf95ba9b810cdca0dc65723a510bac6c1bd89a0a1f60065c1da77f46b`.
Existing Codex binary SHA-256:
`fdda5fa3cf3fb3d000b876720742857676293e4315e4b045fae6f8bd7e866d1d`.
These are observed identities, not a new installation or binary attestation.
Thirteen relevant installed stock-LiteLLM source identities matched before and
after; this does not hash every package/dependency.

Observed predicates:

- `local_compaction_subset_pass: true`: successful actual get_goal result,
  exact ordered native reasoning/tool history, same reasoning IDs/capsules in
  done/completed/initial replay/compaction input, tools **key absent** in the
  native compaction request, no fabricated historical definitions, and actual
  app-server compaction lifecycle/turn completion.
- `post_compaction_continuation_pass: false`.
- `full_session_pass: false`; default strict exit **1**.

The actual compaction request used the exact model slug, `tools: []`, streaming,
and `include: ["reasoning.encrypted_content"]`. Its input contained three
reasoning items followed by the previous function call/output and messages.
The candidate forwarded the historical native tool_use/result without enabling
any callable output tool; the fake summary alone was not counted as proof.

The further ordinary user turn was then sent by Codex with these message roles:

```text
user → user (compaction summary) → developer (skills/permissions) → user (environment) → user (new prompt)
```

The CLI unsolicitedly reinserted a **late developer** message after retained
user messages. The unchanged adapter rejected that request before provider
contact with HTTP **400**, `invalid_request_error` / `unsupported_parameter`:

```text
System and developer messages are allowed only in the initial prefix.
```

There were exactly four client→gateway requests and three fake-provider
requests; no continuation reached the fake provider and no retry repaired it.
No developer message was moved, renamed or hidden to produce a success. The
workspace remained empty. This is a real post-compaction continuation boundary,
not an artificial model-switch test.

The original pre-candidate implementation required current definitions for
historical calls and therefore would reject this captured `tools: []` history
shape. That is a source-based finding only: the candidate was built before the
first valid capture, and the harness did not swap shared source/dist to claim an
executed original baseline. The earlier worker capture is retained at
`C:/Users/binary/AppData/Local/Temp/codex-compaction-final-b7eac215be6f423baa70f02ee7b89a34/`.
The independent run above used the final hardened harness, including absent-key,
request-count and exact no-goal-result checks and notification buffering. It
reproduced the same passing local-compaction subset and failing continuation,
with strict exit 1, unchanged stock source identities and no hidden retries.

Not tested: automatic threshold-triggered compaction, remote
`/responses/compact`, long sessions, resume after process restart, real-provider
signature validation, authorization/entitlement, billing/cache effects or broad
tool compatibility. Manual local compaction is established only for this
bounded synthetic subset; whole-session continuation is not established.
