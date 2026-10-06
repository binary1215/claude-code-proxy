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

The output must be a NEW system-temp child outside the repository. The default
`--signature-events single` runs two normal state/body qualification cases and
exits nonzero if either loses required fidelity. Optional `replacement` tests
SDK last-full-value assignment; optional `split` is only a non-normative
historical observation and cannot fail signature qualification. Explicit
`--observe-only` permits zero for completed observations without changing the
recorded qualification predicates.

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
Fresh client state separates both selected cases; local processes/listeners close in
`finally`. Evidence contains only this generated synthetic conversation.

## Qualification versus non-normative observation

Each invocation tests two content sets with one selected signature-event mode.
All streams use 7-byte UTF-8/CRLF writes (TCP can coalesce writes) and fragmented
tool-input JSON:

- `signed_nonempty`: thinking plus read tool_use.
- `full_opaque`: nonempty thinking, empty signed thinking, redacted thinking,
  then read tool_use, in strict order.
- `single` (default): one full signature_delta immediately before block stop. Empty signed
  thinking includes an explicit `thinking_delta` with `thinking: ""`.
- `replacement`: two complete synthetic signature values, with the last value
  expected in replay. This is an SDK-assembly control, not ordinary stream frequency evidence.
- `split`: two partial values sent as separate signature_delta events. This
  historical input is observational only; concatenation is not required.

The [official streaming documentation](https://platform.claude.com/docs/en/build-with-claude/streaming#thinking-delta)
describes the single-signature sequence and, for omitted display, an empty
thinking delta followed by a single signature delta. This fixture **does not
claim normal real-provider streams emit multiple signature events**, or that
this synthetic combination proves any live model/display configuration. The
pinned official [TypeScript SDK](https://github.com/anthropics/anthropic-sdk-typescript/blob/d49bdab458000bcdffe77bd84b03293f31824fb3/src/lib/MessageStream.ts)
and [Python SDK](https://github.com/anthropics/anthropic-sdk-python/blob/18f25547f20cf5f01da69ac611e700e3bc9ebf21/src/anthropic/lib/streaming/_messages.py)
replace the signature with each event's value; they do not concatenate separate
signature events. Transport byte fragmentation does not alter this rule.

In split mode, `state_subset_pass`, `strict_qualification_pass`, the legacy
`state_stress_pass` and `split_signature_preserved` are null, not failed client
fidelity claims. `split_concat_matches_observed` and
`split_sdk_last_event_matches_observed` retain separate descriptive comparisons.
Exit zero means the observation completed, never that a split signature was
cryptographically valid. Single/replacement modes use normal strict results.

Before-gateway client requests and after-relay native requests are captured
separately. Original-issued equality, the explicitly observed client-added tool
cache marker, gateway/native assistant equality, whole-body semantic equality,
request-byte equality, response SSE bytes and beta-header equality are separate
checks. Known client mutation is reported, not silently erased from evidence.

## Historical observed result (2026-10-05), interpretation corrected

Evidence directory:
`C:/Users/binary/AppData/Local/Temp/opencode-gateway-qualified-2e4d8a321feb44c99a829b52fc3f0c3a/`.
Repository HEAD: `3b57e550443a65600d4a74c6f47eb0979758e977`.

These are the original saved fields, **not the corrected qualification rule**:

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

Both historical split cases replayed the second signature event value, already
visible before LiteLLM, for nonempty and empty thinking. This matches the
official SDK's assignment behavior. The old concatenation oracle was unsupported,
so those comparisons **do not establish an OpenCode signature-loss defect**.
Client and upstream assistant blocks were identical; the relay did not repair
or reinterpret them. Redacted state and actual read survived. The fake provider
did not establish cryptographic validity of any synthetic signature.

All four cases had whole-body semantic **and byte** equality from client
observer to native provider, exact provider→client SSE bytes and beta values,
correct synthetic authentication, unchanged stock source and unchanged fixture.
These OpenCode requests sent **no top-level metadata** on either turn, so the
previously known stock pass-through metadata-removal behavior was **not
exercised** here. No metadata loss or reserialization is claimed for this run,
and this result does not disprove that known conditional behavior.

Each case made one offline npm-registry request and one official-release proxy
attempt; both were rejected and never forwarded. No model request retry hid a
failure. All captures finished; the old unsupported concatenation expectation
made the historical strict result nonzero. An earlier complete observation had a Windows-generated fixture CRLF
versus LF assertion error; that artifact was preserved. The final run changed
only the harness's seeded fixture bytes, not client/proxy behavior. The current
oracle correction retains every old evidence file unchanged. No actual client
or provider was rerun for it; syntax/pure-source checks are not new live evidence.

Not tested: actual upstream cryptographic acceptance, entitlement, pricing/cache
hits, long sessions, compaction, cancellation, restart persistence, model
switches, arbitrary unknown blocks or production deployment. The result is a
narrow passing documented-shape control plus a non-normative historical
comparison, **not whole-goal/full-fidelity acceptance**. Previously passing
single-signature real-client controls remain unaffected.
