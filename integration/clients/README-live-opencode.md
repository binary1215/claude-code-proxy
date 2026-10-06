# Actual OpenCode through the existing gateway

`opencode_live_smoke.py` runs unmodified **OpenCode 1.18.34 → one loopback
byte-preserving observer → existing LiteLLM `.7:4000` → configured native
Messages route → `.64` proxy → real Haiku**. It starts no local LiteLLM, Docker
container or relay and never calls `.64` directly. It does not install or alter
OpenCode, replace its system prompt/user-agent, or read existing credentials.

This is an additional client comparison. A successful run is not certification
of all clients, downstream wire fidelity, model permissions or accounting.

## Explicit live invocation

First obtain approval for the real-model calls and provision the temporary
gateway key privately in `OPENCODE_LIVE_TEST_KEY`. Never paste it in the command,
README, result or repository. Only the name of the environment variable appears
in arguments. The model is fixed to `claude-haiku-4-5-20251001`.

```powershell
& 'C:/Users/binary/AppData/Local/Temp/litellm-stock-validation-6ba742dda05a477cb8351cf0ac54ff333/Scripts/python.exe' -B `
  integration/clients/opencode_live_smoke.py --live `
  --opencode 'C:/Users/binary/AppData/Local/Temp/opencode-smoke-918b3527bd114ef48cf595ceb1bbfe7a/bin/opencode.exe' `
  --gateway-base-url 'http://192.168.0.7:4000/claude-native' `
  --gateway-key-env OPENCODE_LIVE_TEST_KEY `
  --output 'C:/Users/binary/AppData/Local/Temp/opencode-live-NEW-UNIQUE-NAME'
```

The executable SHA-256 must equal
`184f196ec97c843a64b2e1a2b49165f25e73a5d6993e2f842c9958c2b1f7a5b2`;
the actual `--version` must report `1.18.34`. No ZIP download/extraction occurs.
The Python harness uses only the standard library. `--live` is mandatory.

The supplied gateway base can end in `/claude-native` or `/claude-native/v1`;
both produce exactly `/claude-native/v1/messages`. OpenCode's bundled Anthropic
provider gets the loopback base ending in `/v1` and appends `/messages` itself.
The observer forwards to `.7`, never directly to Anthropic or `.64`.

## Bounded real scenario

1. Generate a single random-marker fixture in a new isolated workspace.
2. Execute actual `opencode run --format json --model anthropic/<Haiku>` with
   the built-in `read` tool. All other tools are denied; only that fixture may
   be read. The real model calls `read`, receives its result, and answers.
3. Extract the actual session ID from CLI events in memory. Start the same
   unmodified executable with `run --session <id>` in the same isolated runtime.
   It recalls the fixture marker from its own session without reading again.

The normal case makes **three gateway requests**: Read request, tool result,
then session follow-up. There is a hard maximum of **four attempts** at the
observer, at most three during the Read phase and one in follow-up. Attempts
count before connecting. The observer forwards no request after a transport,
HTTP or SSE error, rejects duplicate request bodies, and the harness stops the
client; it never performs a retry, fallback, tool-result fabrication or state
repair. The pinned SDK defaults to zero retries, but OpenCode also has a
session-level retry policy. These are not misrepresented as globally disabled:
any later model attempt is counted and rejected locally after failure.
Downstream `.7`/`.64` retries remain unobserved by this harness.

The provider is configured through ordinary per-process options, with thinking
budget 1024 and output cap 4096. Native OpenCode prompt-cache markers are
observed, not inserted by the observer. The client supplies both Anthropic
`x-api-key` and configured Bearer authentication using the test gateway key;
no upstream OAuth credential is supplied to OpenCode. Config uses an environment
placeholder rather than writing the key into a config file.

## Result interpretation and retention

`opencode-live-smoke.json` contains only fixed error codes, booleans, numeric
counts/usage, public model/version/path facts and the isolated runtime location.
Request/response bodies, thinking/signatures, generated markers, full errors,
credentials and client stdout/stderr stay in harness memory. The ordinary
OpenCode session DB/history and its own runtime logs remain in the **separate**
temporary runtime; treat that directory as private rather than publishing it.
The harness does not delete it or alter normal user settings/auth files.

For non-200 responses, `error_diagnostics` contains only a closed error-type
allowlist and fixed reason enum. For example,
`third_party_plan_usage_restriction` identifies a refusal explicitly describing
third-party use as drawing from extra usage rather than Claude-plan limits, without exporting the error
text. A refusal is not repaired by retries, paid fallback or client impersonation.
This classification describes the observed request, not a universal policy claim.

`functional_pass` checks actual Read/result and same-session follow-up.
The generated `OPENCODE_LIVE_<32 hex digits>` token must appear exactly, with no
changed or conflicting fixture token. Surrounding prose, Markdown, line breaks
and whitespace after the confirmation label are accepted; label typography is
not a model-functionality requirement. Empty tool-input JSON deltas preserve
the initial input object, while nonempty malformed JSON still fails parsing.

Fidelity is recorded independently: ordered assistant content, cache-annotation-only
differences, thinking/signature, signed-empty, redacted data, tool input/ID/order
and tool-result order. Missing newly emitted thinking is not a failure; an
unemitted block type is `null`, not “preserved.” Each `signature_delta` replaces
the block's signature, matching the official TypeScript/Python SDKs; event counts
are retained separately. Text/thinking and tool JSON fragments still append.
The harness does not synthesize signature stress against the live provider.

Offline regressions distinguish one complete signature event with SSE bytes
reassembled from small chunks from repeated complete events where the last value
wins. The earlier synthetic split-event concatenation assumption was not a
normative contract and does not prove an OpenCode defect. Single-signature real
results are unaffected, and old evidence artifacts are not rewritten.

SSE usage, including cache read/write and 5-minute/1-hour creation when present,
is reported separately from OpenCode's CLI usage. Null usage updates do not
erase earlier counts. Cache hits and fidelity do **not** gate otherwise
successful functional follow-up; inspect the separately reported observations.

The single observer proves only its own unchanged request/response bytes and
the client's replay visible at `.7` ingress. Native relay ingress, downstream
body/header fidelity, real provider request count/retries and `.7` cost/log/ACL
accuracy are explicitly `null`/unobserved. Correlate sanitized server-side
history separately; never equate gateway attempts with provider calls.

No model calls were made merely by adding these files. Functional qualification
requires a separately approved live run and inspection of its report.

## Protocol references

- Pinned [`run --session` and JSON event protocol](https://github.com/anomalyco/opencode/blob/aec0b9a6d8898f68f923aaf08b7306d931fd9d76/packages/opencode/src/cli/cmd/run.ts).
- Pinned [model option/header preparation](https://github.com/anomalyco/opencode/blob/aec0b9a6d8898f68f923aaf08b7306d931fd9d76/packages/opencode/src/session/llm/request.ts).
- Pinned [SDK retry default](https://github.com/anomalyco/opencode/blob/aec0b9a6d8898f68f923aaf08b7306d931fd9d76/packages/opencode/src/session/llm.ts) and separate [session retry](https://github.com/anomalyco/opencode/blob/aec0b9a6d8898f68f923aaf08b7306d931fd9d76/packages/opencode/src/session/processor.ts).
- [OpenCode environment substitutions and inline configuration](https://opencode.ai/docs/config/).

Existing fake-provider controls and the historical split-signature test are
documented separately in `README-opencode-gateway.md`; the old concatenation
expectation is not a normative client-fidelity failure. Neither those synthetic
observations nor this oracle correction are reclassified as live evidence.
