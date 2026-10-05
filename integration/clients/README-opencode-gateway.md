# Actual OpenCode stock-gateway native relay smoke

This bounded fixture runs unmodified **OpenCode 1.18.34 → stock LiteLLM 1.103.1
free authenticated configured pass-through → built native relay → loopback fake
Anthropic Messages**. It never invokes a real provider or existing account.
It qualifies a narrow actual-client control, not the whole goal or production
authorization/billing/signature validity.

## Reproduce

Build the repository normally first. Use the existing verified client asset;
the harness neither downloads, extracts, installs nor patches it:

```powershell
& 'C:/Users/binary/AppData/Local/Temp/litellm-stock-validation-6ba742dda05a477cb8351cf0ac54ff333/Scripts/python.exe' `
  integration/clients/opencode_gateway_smoke.py `
  --binary 'C:/Users/binary/AppData/Local/Temp/opencode-smoke-918b3527bd114ef48cf595ceb1bbfe7a/bin/opencode.exe' `
  --archive 'C:/Users/binary/AppData/Local/Temp/opencode-smoke-918b3527bd114ef48cf595ceb1bbfe7a/opencode-windows-x64-baseline.zip' `
  --node 'C:/Users/binary/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' `
  --output 'C:/Users/binary/AppData/Local/Temp/opencode-gateway-NEW-UNIQUE-NAME'
```

The output must be a NEW system-temp child outside the repository. Default exit
is strict and **nonzero if any required state/body case loses fidelity**.
Explicit `--observe-only` permits zero only for completed observations; it never
changes the recorded state/control/stress/strict predicates into successes.

Official [release v1.18.34](https://github.com/anomalyco/opencode/releases/tag/v1.18.34),
source `aec0b9a6d8898f68f923aaf08b7306d931fd9d76`:

- `opencode-windows-x64-baseline.zip` SHA-256:
  `f89ab2720050780a450e3cf3e48ac3f0409235b46b6c548c69aa2b7051d716f4`.
- Existing extracted executable SHA-256:
  `184f196ec97c843a64b2e1a2b49165f25e73a5d6993e2f842c9958c2b1f7a5b2`.
- Both hashes and actual `--version == 1.18.34` are required before qualification.

## Isolation and assertions

The existing direct `opencode_smoke.mjs` permission/isolation profile is reused:
each case receives new home/config/data/cache/state/temp/DB and one synthetic
fixture file. No user auth/proxy/config environment is inherited. Only the exact
fixture `read` is allowed; all other permissions default to deny. Actual requests
must advertise **only read**. Snapshots, sharing, plugins/MCP, LSP downloads,
external skills, project/Claude Code config, updates, model fetching and auto
compaction are disabled.

The actual CLI must execute that built-in read, return a matching non-error
tool_result containing the fixture, and finish with exact parsed JSON text and
`step_finish` reasons `tool-calls → stop`. The workspace must still contain only
the unchanged, exactly LF-encoded seeded fixture. No shell/edit/network tool is
ever requested. Application-level permissions are not an OS filesystem sandbox.

An explicit loopback HTTP/CONNECT rejecting proxy and offline npm registry never
forward incidental requests. All configured provider addresses are loopback.
Synthetic gateway, relay and upstream keys are distinct; upstream must receive
only the fake-provider key. Captures omit auth headers and redact generated
keys. No global installation/settings/OS sandbox setup or `.7` access occurs.
This is not OS-enforced zero-egress proof against arbitrary executables or
dependency internals.

The existing guarded Python helper supplies stock-source identity checks and
process cleanup. The unmodified existing relay bootstrap starts the actual app
with an in-memory DB and fake upstream; only native `/v1/messages` is called,
not the Responses adapter. The stock gateway uses its unchanged
`boot_gateway.py`, no route/source monkeypatch and no enterprise conversion.
Thirteen relevant stock source identities must match before/after.

Every client/fake request is bounded to 1 MiB; response capture to 4 MiB; client
stdout/stderr to 1 MiB each; client execution to 60 seconds. Each case requires
exactly two model requests per hop, with extra attempts failing the observer.
Fresh client state separates all four cases; local processes/listeners close in
`finally`. Evidence contains only this generated synthetic conversation.

## Control versus stress

The matrix is two content sets × two signature-event patterns. All four fake
streams use 7-byte UTF-8/CRLF writes (TCP can coalesce writes) and fragmented
tool-input JSON:

- `signed_nonempty`: thinking plus read tool_use.
- `full_opaque`: nonempty thinking, empty signed thinking, redacted thinking,
  then read tool_use, in strict order.
- `single`: one full signature_delta immediately before block stop. Empty signed
  thinking includes an explicit `thinking_delta` with `thinking: ""`.
- `split`: two separate signature_delta events for each signature, a deliberate
  synthetic fragmentation stress.

The [official streaming documentation](https://platform.claude.com/docs/en/build-with-claude/streaming#thinking-delta)
describes the single-signature sequence and, for omitted display, an empty
thinking delta followed by a single signature delta. This fixture **does not
claim normal real-provider streams emit multiple signature events**, or that
this synthetic combination proves any live model/display configuration.

Before-gateway client requests and after-relay native requests are captured
separately. Original-issued equality, the explicitly observed client-added tool
cache marker, gateway/native assistant equality, whole-body semantic equality,
request-byte equality, response SSE bytes and beta-header equality are separate
checks. Known client mutation is reported, not silently erased from evidence.

## Actual observed result (2026-10-05)

Evidence directory:
`C:/Users/binary/AppData/Local/Temp/opencode-gateway-qualified-2e4d8a321feb44c99a829b52fc3f0c3a/`.
Repository HEAD: `3b57e550443a65600d4a74c6f47eb0979758e977`.

```text
observation_completed          true
state_control_pass             true
state_stress_pass              false
split_signature_preserved      false
whole_body_semantic_exact       true
strict_qualification_pass       false
default exit                   1
```

Both **single-signature controls passed**, including signed-empty and redacted
state, exact block order, successful actual fixture read/result, final client
events, beta, response SSE, generated-key separation and exactly two requests
per hop. OpenCode added precisely `cache_control: {type: "ephemeral"}` to the
replayed tool_use. Thus equality against the unmarked originally issued block
is false; equality against the independently reported exact cache-marked client
form is true. Thinking/signature/redacted data remained exact.

Both **split-signature stress cases failed state fidelity**: OpenCode replayed
only the second signature fragment. The loss is already present in the actual
client request **before LiteLLM**, for nonempty and empty thinking. Client and
upstream assistant blocks are identical; the relay did not repair or modify the
damaged signature. Redacted state and actual read still survived. A permissive
fake provider/client exit 0 was not counted as state success.

All four cases had whole-body semantic **and byte** equality from client
observer to native provider, exact provider→client SSE bytes and beta values,
correct synthetic authentication, unchanged stock source and unchanged fixture.
These OpenCode requests sent **no top-level metadata** on either turn, so the
previously known stock pass-through metadata-removal behavior was **not
exercised** here. No metadata loss or reserialization is claimed for this run,
and this result does not disprove that known conditional behavior.

Each case made one offline npm-registry request and one official-release proxy
attempt; both were rejected and never forwarded. No model request retry hid a
failure. All captures finished; only stress fidelity makes the strict result
nonzero. An earlier complete observation had a Windows-generated fixture CRLF
versus LF assertion error; that artifact was preserved. The final run changed
only the harness's seeded fixture bytes, not a client/proxy behavior or failed
signature expectation.

Not tested: actual upstream cryptographic acceptance, entitlement, pricing/cache
hits, long sessions, compaction, cancellation, restart persistence, model
switches, arbitrary unknown blocks or production deployment. The result is a
narrow passing documented-shape control plus an independently visible synthetic
stress loss, **not whole-goal/full-fidelity acceptance**.
