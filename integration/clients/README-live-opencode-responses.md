# Actual OpenCode Responses-path comparison

`opencode_responses_live_smoke.py` selects unmodified OpenCode **1.18.34**'s
bundled `@ai-sdk/openai` **Responses** provider for the native model ID
`claude-haiku-4-5-20251001`. It does not use `openai-compatible`/Chat Completions,
install a provider, edit client or LiteLLM sources, impersonate Claude Code,
replace OpenCode's system prompt, repair requests, or enable paid fallback.

The ordinary built-in `openai` provider loader calls `sdk.responses(modelID)`.
The native Claude model ID is retained, including the usual Claude-oriented
OpenCode prompt selection. Per-model configuration explicitly requests
`store: false` and `include: ["reasoning.encrypted_content"]`. The provider key
is an environment placeholder; no upstream Claude credential reaches OpenCode.
The original request and response bytes pass through one loopback observer.
Unknown client fields are inventoried and forwarded, never silently removed.

## Modes and commands

All modes require the existing pinned Windows executable, whose SHA-256 is
`184f196ec97c843a64b2e1a2b49165f25e73a5d6993e2f842c9958c2b1f7a5b2`.
The actual executable must also report version `1.18.34`. Output must be a new
directory below the system temporary directory, outside this repository.
Python uses only the standard library.

### Offline: actual client and actual proxy, synthetic upstream only

Build this repository's backend first. Then run:

```powershell
& 'C:/Users/binary/AppData/Local/Temp/litellm-stock-validation-6ba742dda05a477cb8351cf0ac54ff333/Scripts/python.exe' -S -B `
  integration/clients/opencode_responses_live_smoke.py --offline `
  --opencode 'C:/Users/binary/AppData/Local/Temp/opencode-smoke-918b3527bd114ef48cf595ceb1bbfe7a/bin/opencode.exe' `
  --node 'C:/Users/binary/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' `
  --output 'C:/Users/binary/AppData/Local/Temp/opencode-responses-offline-NEW-UNIQUE-NAME'
```

This starts the existing `boot_responses_relay.mjs` against a loopback fake
native Messages server. The real built proxy generates encrypted capsules
from synthetic thinking, signed-empty thinking and redacted-thinking blocks,
then emits a `read` function call. OpenCode reads only the generated fixture,
returns the real tool result, and, if successful, resumes its same session for
a no-tool follow-up. This tests actual client/adapter behavior without any
real Anthropic or deployed gateway request. It proves neither entitlement nor
real-provider cache or billing behavior.

The bootstrap enables developer hoisting as in the deployed test adapter.
It uses an in-memory database and a fresh local key/state key, and is stopped
after the run. No existing deployment/configuration is changed.

### Live: first-request acceptance probe

After approval and private provisioning of the existing temporary gateway key
in `OPENCODE_RESPONSES_TEST_KEY`, run:

```powershell
& 'C:/Users/binary/AppData/Local/Temp/litellm-stock-validation-6ba742dda05a477cb8351cf0ac54ff333/Scripts/python.exe' -S -B `
  integration/clients/opencode_responses_live_smoke.py --live --first-request-only `
  --opencode 'C:/Users/binary/AppData/Local/Temp/opencode-smoke-918b3527bd114ef48cf595ceb1bbfe7a/bin/opencode.exe' `
  --gateway-base-url 'http://192.168.0.7:4000/claude-responses' `
  --gateway-key-env OPENCODE_RESPONSES_TEST_KEY `
  --output 'C:/Users/binary/AppData/Local/Temp/opencode-responses-live-NEW-UNIQUE-NAME'
```

Only the environment variable's name appears in arguments. Never put its value
in the command, repository or report. The only allowed deployed origin is
`.7:4000`, and the only allowed path is `/claude-responses/v1/responses`.
No local LiteLLM/relay is started, and `.64` is never contacted directly.

`--first-request-only` forwards **at most one** gateway attempt, receives the
original HTTP/SSE response, then stops the client and blocks subsequent model
attempts locally. The permitted Read tool may already have read the temporary
fixture, but no tool-result model request is forwarded. This specifically
separates first-request provider acceptance from follow-up compatibility.

`first_request_accepted` means HTTP 200 **and** a complete successful Responses
SSE terminal were observed. `first_request_probe_complete` means a complete
HTTP response was captured, including a refusal. Exit status is zero only for
an accepted first request. **`functional_pass` remains false and
`multi_turn_tested` remains false regardless of acceptance.** Deliberate client
termination is not reported as a completed coding session or tool round-trip.

### Live: full bounded scenario

Omit `--first-request-only` only when full multi-turn live testing is authorized
and the relevant compatibility issue has been addressed or is intentionally
being tested. The normal scenario uses three requests: Read request, tool
result, then same-session no-tool follow-up. The maximum is four attempts,
at most three in the Read phase and one in follow-up. There is no call after a
transport/HTTP/SSE failure, duplicate-body retry, request repair or fallback.
Attempts consume their slot before connecting, including uncertain outcomes.

The live observer bounds its outgoing gateway requests, not hidden behavior
inside `.7`/`.64`. Downstream request/retry counts and gateway accounting remain
unobserved and require separate server evidence.

## Verified initial offline finding

The original q1/q2 qualification against the then-current `503555d` source
showed a real compatibility issue, **not** a provider entitlement result:

1. First Responses request returned HTTP 200 from the actual local proxy.
2. OpenCode completed its real fixture Read tool.
3. The next request replayed all three `encrypted_content` values exactly,
   but omitted all three reasoning item IDs.
4. The proxy returned HTTP 400 `invalid_reasoning_state` before making a
   second fake-native call, because its `ccpr1` contract required both the
   ID and the encrypted capsule.

The safe q2 report was retained at
`C:/Users/binary/AppData/Local/Temp/opencode-responses-offline-20261006-q2/opencode-responses-live-smoke.json`.
It recorded two client requests, one fake-native request and zero real gateway
requests. The observer did not add the missing IDs or retry the request. This
is distinct from the earlier native OpenCode request's real Anthropic
third-party-plan refusal. Neither finding alone proves the outcome of a real
Responses-path first request. Later source/deployment fixes must be qualified
separately; historical failed reports should not be rewritten.

## Observed deployed first-request result (2026-10-07 KST)

The separately authorized live probe was executed once at
2026-10-06 15:01:22–23 UTC (2026-10-07 00:01:22–23 KST). Actual OpenCode used
the bundled Responses provider through `.7` and the existing `.64` test image.
The one request received **HTTP 400 `invalid_request_error`**, classified from
the original provider response as `third_party_plan_usage_restriction`.
There was no adapter error code. The deployed proxy recorded matching
upstream HTTP 400 in history row 47; this was not a LiteLLM route-permission
403 or the offline missing-ID error.

The report showed the genuine OpenCode User-Agent, unmodified observer bytes,
`store: false`, and requested encrypted reasoning content. There was no retry,
paid fallback, deployment/image change, follow-up request or live tool call.
The probe completed but was not accepted; functional and multi-turn success
were not claimed. Usage/cache counters were unavailable, **not evidence of
zero billing**. Safe evidence is collected in
[`docs/evidence/opencode-responses-20261007.json`](../../docs/evidence/opencode-responses-20261007.json).

This establishes that **switching OpenCode to this Responses route alone did
not resolve the observed provider refusal**. It does not isolate which client
prompt/header/request feature caused the different result from earlier Codex
tests. The separate offline missing-ID compatibility defect remains relevant
to future multi-turn testing; fixing that defect would not itself change the
provider's first-request usage decision.

## Evidence, confidentiality and interpretation

`opencode-responses-live-smoke.json` is sanitized. It includes public
version/model/endpoint facts, numeric usage, field/type inventories, fixed
error enums, process status and booleans. It excludes raw prompts, request and
response bodies, thinking, signatures, ciphertexts, fixture markers, session
IDs, full provider errors and credentials. Those wire values remain in memory.
OpenCode's ordinary history/database/logs remain in a **separate private
temporary runtime** identified by the report. Do not publish that directory.

The environment is isolated from ordinary user settings/auth, external plugins,
model registry downloads and project config. Only the generated fixture Read
tool is permitted. This is a bounded client configuration, **not** an
OS-enforced filesystem/network sandbox.

Reported fidelity distinguishes:

- Complete versus incomplete/error Responses streams and non-200 HTTP errors.
- Reasoning ID preservation versus encrypted-content preservation. Neither
  a missing ID nor an unchanged ciphertext is mislabeled as the other.
- Exact function argument serialization versus parsed JSON equality.
- Ordered tool/result IDs and the actual fixture result.
- Offline native restoration of thinking/signature, signed-empty and redacted
  blocks by the real proxy. Synthetic signatures are not provider validation.
- Client CLI usage, Responses usage and native usage extensions. Missing or
  unobserved counters remain unknown; a synthetic cache value is not savings.

Functionality and observed state fidelity are separate report dimensions.
Signed-empty/redacted live preservation is not claimed unless those blocks
were actually emitted and observed. The harness does not test compaction,
cancellation, model/account/key switching, full client feature coverage, real
provider billing, gateway model ACLs or deployment rollback.

Pure regressions (no client, network, runtime or credential reads):

```powershell
python -S -B -m unittest discover -s integration/clients -p test_live_opencode_responses_observer.py
```

Source references: pinned OpenCode
[provider selection](https://github.com/anomalyco/opencode/blob/aec0b9a6d8898f68f923aaf08b7306d931fd9d76/packages/opencode/src/provider/provider.ts),
[provider options](https://github.com/anomalyco/opencode/blob/aec0b9a6d8898f68f923aaf08b7306d931fd9d76/packages/opencode/src/provider/transform.ts),
and [model-specific system prompt selection](https://github.com/anomalyco/opencode/blob/aec0b9a6d8898f68f923aaf08b7306d931fd9d76/packages/opencode/src/session/system.ts).
