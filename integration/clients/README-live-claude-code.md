# Actual Claude Code live smoke

`claude_code_live_smoke.py` runs the existing official Claude Code 2.1.289 binary
through either the **existing `.7` gateway** or a temporary stock LiteLLM
diagnostic gateway, using real `claude-haiku-4-5-20251001`. It never modifies a
deployed service. The existing `.64` relay keeps its provider OAuth credential;
the harness neither reads nor supplies that credential.

The first print invocation uses only Claude Code's real `Read` tool to read one
new synthetic `fixture.txt`, then returns its marker. A second invocation uses
`--resume` with that invocation's generated session ID and asks for the marker
without another read. The harness never edits the client's saved history and
keeps the client's normal system prompt and user agent.

## Actual `.7` gateway

This mode runs Claude Code -> local byte-preserving observer ->
`http://192.168.0.7:4000/claude-native/v1/messages` -> the gateway's configured
`.64:13457/v1/messages` relay. It does **not** start a temporary LiteLLM gateway
or call `.64` directly. Python 3.11+ and the existing pinned native binary are
sufficient; local LiteLLM is not imported or required in this mode.

Supply the existing gateway key privately through the environment variable named
by `--gateway-key-env` (default `CLAUDE_LIVE_GATEWAY_KEY`). Only that named key is
read, and it is passed to the client's isolated child environment. Do not put
keys in arguments, configuration files, terminal output or a saved command.

```powershell
& $python -B integration/clients/claude_code_live_smoke.py `
  --live --claude $existingClaudeBinary `
  --gateway-base-url 'http://192.168.0.7:4000/claude-native' `
  --gateway-key-env CLAUDE_LIVE_GATEWAY_KEY `
  --output (Join-Path $env:TEMP ('claude-code-live-dot7-' + [guid]::NewGuid().ToString('N')))
```

The base URL includes `/claude-native`, without the final `/v1/messages`.
The observer forwards the actual client's request bytes, system prompt, user
agent and beta header, and returns the received SSE bytes. Observations cover
the client-facing `.7` exchange. The `.7`-to-`.64` exchange and native ingress
are **unobserved**: their body/SSE/header fidelity and metadata removal are
reported as unknown, never inferred from the client-facing wire.

## Local-stock diagnostic mode

Use the existing pristine LiteLLM 1.103.1 Python environment. Supply the relay
key through `--relay-key-env` (default `CLAUDE_LIVE_RELAY_KEY`). This mode starts
a temporary, unmodified free stock gateway and two observers, then calls the
existing `.64` relay. Claude Code receives a generated local gateway key rather
than the relay key. It does not test the deployed `.7` gateway.

```powershell
& $stockPython -B integration/clients/claude_code_live_smoke.py `
  --live --claude $existingClaudeBinary `
  --relay-base-url 'http://YOUR_DOT64_HOST:13457' `
  --relay-key-env CLAUDE_LIVE_RELAY_KEY `
  --output (Join-Path $env:TEMP ('claude-code-live-' + [guid]::NewGuid().ToString('N')))
```

`--relay-base-url` takes the origin only, without a `/v1` suffix. The gateway and
relay URL options are mutually exclusive. In either mode, `--output` must be a
new directory inside the system temp directory and outside the repository.
The pinned binary SHA-256 is
`bcc6d9117aec30ad9414490302a25414359c871f5647e32e49b055c92bf84e0b`.

This opt-in makes real provider requests. The expected sequence is two requests
for the Read turn and one for the ordinary follow-up. A shared observer permits
at most four outgoing remote requests and stops after the first failed request or
unexpected tool/turn; the expected functional sequence accepts only three.
Client and observer retries are zero, no client model fallback is configured,
and all process and HTTP waits have finite timeouts. Temporary stock gateway
retries are also zero. Deployed gateway and relay internal attempts are not
instrumented or changed. The cap counts observer attempts to `.7` in deployed
mode or `.64` in local-stock mode.

## Report and retention

The output directory contains only `claude-code-live-smoke.json`. It reports:

- Real Read execution, its returned marker, and recall in the resumed turn.
- Native assistant content observed in the returned SSE versus the client's actual
  replay after Read and after the user follow-up, including signed thinking and
  redacted blocks when emitted. Content equality with request-only `cache_control`
  annotations excluded is reported separately from exact content equality.
  `shape_diagnostics` records bounded block type/order and known top-level field
  differences, plus text-concatenation and tool ID/name/input equality booleans.
  It contains no field values, signatures, text or tool input keys. This can
  distinguish metadata differences from substantive changes on future runs;
  saved client sessions alone cannot reconstruct older memory-only wire captures.
- In local-stock mode, request and SSE equality at both sides of that gateway.
  Known removal of top-level `metadata` is recorded separately; it is not
  whole-body equality. In deployed mode, these comparisons are null/unknown.
- Numeric input/output/cache creation/cache read counters from actual native
  responses and the client's result. A zero or absent cache count is not a claim
  that cache reuse succeeded; these counters do not prove billing or entitlement.
- Pinned binary identity, HTTP statuses, remote request counts and fixed failure
  codes. Local-stock mode additionally checks selected local stock source
  identities before/after; this does not attest the deployed gateway's sources.

Requests, responses, signatures, raw error text and gateway/client process output
are observed in memory and are never written into the report. The harness also
creates a **separate retained temporary runtime**, named in the report, with a
fresh home, configuration and fixture-only workspace. Claude Code naturally
saves its synthetic session there, including native signed content needed for
resume; this is not a diskless test. Harness-created configuration contains no
gateway or relay key. Existing client configuration is not used or
changed. Child processes/listeners are stopped on completion; the isolated
runtime is retained for deliberate later removal.

`functional_pass` describes Read plus recall. Overall `pass` and the exit code
reflect functional completion without harness errors (and unchanged local stock
sources when applicable). Fidelity comparisons are separate findings and never
block a request from reaching the real provider.

The functional answer check requires the exact fixture marker, allowing spaces,
Markdown or surrounding prose. A missing, case-changed, extended or conflicting
fixture marker fails. The client must still complete the actual Read round trip
and the resumed user turn successfully; rigid confirmation-prefix formatting is
not an acceptance condition.

`signed_state_pass` compares every observed returned thinking/redacted block with
the actual later replay, with null for incomplete coverage unless an observed
change already proves failure. `observed_signed_state_pass` independently reports
the result of just the replays that were observed. `replay_coverage` names Read
and the user follow-up as observed or unobserved. `signed_state_status` reports
`preserved`, `preserved_partial`, `changed`, `not_observed`, or `not_emitted`.
If no such block was emitted, the pass field is null; absent new thinking is not
a functional failure. A follow-up that was never sent is unobserved rather than
a failed signature comparison. Replay content
equality and any signed-state difference remain visible even when Read and recall
succeed. Long sessions, compaction, billing, subscription entitlement and
OS-enforced network isolation remain outside either test.

SSE assembly retains the initial tool input when `input_json_delta` contributes
an exactly empty JSON buffer. Nonempty malformed JSON is still rejected.
