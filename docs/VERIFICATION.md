# Native relay verification — updated 2026-10-06

## Scope and corrections

- Branch: `codex/native-messages-relay`. Production replacement and LiteLLM
  source changes are outside this verification.
- Earlier 10/10 LiteLLM results used the now-withdrawn patch. They are **not
  stock LiteLLM acceptance**. Patch tooling/suites were removed; Git history
  retains them for audit/recovery.
- Offline tests use fake upstreams/credentials. Separately authorized live
  checks use a private OAuth token only in `test-claudemock` and official CLI
  controls. No real credentials/conversations/signatures belong in this report.
- Token counts are observed counters, not invoices, proven USD savings or
  measured model-quality improvements.

## Existing diagnostics deployment

Implementation commit: `0ca75751d407b0bce2f9c15675b1e0d8fd8075c4`.

| Check | Result |
| --- | --- |
| Local TypeScript build + Node HTTP/SQLite/diagnostic-tool tests | 54/54 passed, including later test-only additions |
| Same tests in the actual Node 22 Docker image, network disabled | 44/44 passed |
| Admin TypeScript + Next.js production build | Passed |
| Independent bounded observer/storage/lifecycle/migration review | Findings fixed and rechecked |
| Stock FastAPI audit | 26 baseline + 6 synthetic replay observations verified; known losses explicitly separated |
| Test deployment health / SQLite integrity / active tasks | Healthy / ok / zero pending |
| Runtime npm audit during image build | 0 production vulnerabilities reported; build/dev set reported 1 low |

Deployed image: `local/test-claudemock:0ca7575`, ID
`sha256:12d35112176de03ab3d1e2ae46a91a8ca6a98168478c98fd6aaf37fcb9b85fc3`.
A consistent SQLite backup was made and integrity-checked before migration;
previous image/configuration were retained. The test container alone was
recreated. Production container ID/image/start time remained unchanged.

Live premium-model rejection now records HTTP 429, `rate_limit_error`, validated
request ID, OAuth auth kind and `unknown_429`, with null code/retry/quota fields.
Old rows retain null diagnostics. New fields contain no raw error messages.
The 44 tests also cover observer overflow followed by errors, unknown SSE error
types, case-insensitive SSE MIME, framing-only bounded memory and finalization.

Admin UI source was built locally, not deployed as a new remote dashboard.
Non-fatal build warning: Next.js inferred workspace root from multiple lockfiles.

## Live native relay baseline

Image `4e2b779` ran as isolated `test-claudemock`: Node 22, own volume/LAN port,
read-only root, non-root user. Existing production ID/image/start time remained
unchanged. Offline tests in that Docker image passed 31/31 before diagnostics.

| Test | Observed result |
| --- | --- |
| Proxy auth and health | Pass; requests without proxy key rejected |
| Refreshed-token model discovery | 200; catalog is not an access guarantee |
| Haiku 4.5 generation | 200 |
| Thinking stream + tool request | Signed thinking/signature deltas and terminal event received |
| Original signed content + tool result | Accepted; synthetic marker returned |
| Identical continuation/cache markers | Cache read 7582, fresh input 6, output 11, cache creation 0 |
| `tool_result.is_error=true` | Synthetic error acknowledged without tool retry |
| Further user turn | Marker recalled |
| History/counters/tasks | Provider counts matched; no pending tasks |
| Minimal Sonnet 5.5 / Opus 5.5 / Fable 5.1 | Generic 429 `rate_limit_error`; no Retry-After/quota headers |
| Direct HTTP Opus, bypass relay, same token/host | Same generic 429 |

Haiku quota headers indicated allowed 5-hour/7-day status and low utilization.
This contradicts interpreting every premium-model 429 as whole-account quota
exhaustion; it does not prove the server's actual eligibility rule.

The first live-suite attempt stopped on a harness parser bug decoding an empty
tool-input delta. Keeping `{}` fixed the fixture; the complete rerun passed.
That failure was not relay content loss.

## Unmodified official Claude Code control

Official npm `@anthropic-ai/claude-code@2.1.289` ran in a separate temporary
Docker container, not the proxy backend. Same token, no API-key fallback, no
project mount, tools disabled, empty MCP config, no persisted session. Prompt
was a synthetic request for `OK`; the CLI owns its internal request behavior.

| Requested model | Result | Interpretation |
| --- | --- | --- |
| `claude-opus-5-5` | Success, `OK`; usage only Opus 5.5 | Account/token can serve Opus through official client |
| `claude-fable-5-1` | CLI success, Fable 0 output; `claude-opus-4-8` 4 output | Fable-only generation **not established**; internal model transition |

CLI `costUSD` is list-price accounting, not proof of paid API billing. CLI and
minimal raw requests are not identical. [Issue #87420](https://github.com/anthropics/claude-code/issues/87420)
describes a similar difference but is a user report, not Anthropic-confirmed root
cause. This relay does not inject official-client identity/system blocks.

## Same-host request-shape comparison

On 2026-10-05 KST, four sequential generation requests used the same server,
OAuth credential and `claude-opus-5-5`. Raw probes bracketed unmodified official
Claude Code 2.1.289 controls. A temporary loopback observer retained only closed
shape enums/counts and safe diagnostics, never request/response text or secrets.
The CLI ran with tools/MCP disabled and no project mount or persisted session.

| Phase | HTTP / result | Cache read / creation | Fresh input / output |
| --- | --- | --- | --- |
| Minimal raw, before | 429, `unknown_429` | Unknown | Unknown |
| Official CLI directly through observer | 200, exact `OK`, Opus 5.5 only | 0 / 2031, CLI counters | 2 / 4, CLI counters |
| Official CLI through observer and existing native test relay | 200, exact `OK`, Opus 5.5 only | 2031 / 0 | 2 / 4 |
| Minimal raw, after | 429, `unknown_429` | Unknown | Unknown |

Exactly one generation request per phase was observed: no observed retry or
model transition. The relay-selected credential was privately compared with the
control credential and matched; no database override or API-key fallback was
configured. Relay history independently matched HTTP 200, cache read 2031,
input 2/output 4, complete usage and null prompt/response content. No pending
tasks remained. Direct response compression prevented observer token parsing;
that row's counters are explicitly from the official CLI, not the observer.

Both CLI request projections had 11701 body bytes, three system text blocks,
two messages, adaptive thinking, zero tools, metadata, context management,
output configuration and three 1-hour cache markers. The minimal raw request
had 107 bytes, one user message, no system/thinking/metadata/cache markers and
only the OAuth beta. CLI projections included additional known beta flags and
unknown-beta counts; unknown names/values and system text were not collected.
Matching projections are **not** proof of identical complete requests.

This demonstrates that the current native relay can carry a real official
Opus request and preserve a real cache hit. It weighs against generic proxy
breakage or whole-account quota exhaustion as explanations for this raw 429.
It does **not** isolate which body/header/authorization-context difference is
decisive, prove arbitrary clients are eligible, or verify the `.7` gateway path.
There is no patch to impersonate Claude Code, transplant its system blocks,
restore an SDK backend or silently change models.

The first observer startup attempt timed out reading Docker logs before any
generation phase; owned containers were removed. Increasing that bounded log
read timeout allowed the complete four-request comparison. Both existing test
and production container ID/image/start time remained unchanged, and all
temporary comparison containers were removed afterward. Safe detailed evidence
is private on the test host; [observer code and offline checks](../integration/diagnostics/README.md)
are reproducible without real credentials.

## Stock LiteLLM HTTP gateway

Pinned 1.103.1 at `580bde9a2d148714889ec1c04a9872819e78a778`: actual FastAPI
HTTP, loopback fake upstream, 13 source identities unchanged before/after.
The actual gateway UI also reports 1.103.1, not proof of its source integrity.

- Normal `/v1/messages` dropped signed-empty thinking/unknown beta. Invalid
  signature caused a second request with thinking removed and returned 200,
  despite router retries zero.
- Built-in `/anthropic/v1/messages` and custom pass-through preserved tested
  thinking/empty/redacted/tool/cache/beta plus raw response/SSE bytes; invalid
  signature stayed one 400. Caller credentials were replaced upstream.
- Both pass-through paths re-encode JSON and remove top-level `metadata`.
- Missing auth rejects with zero upstream calls in the complete runtime. An
  initially missing Prisma dependency produced 500 instead of 401; installing
  the stock runtime dependency fixed that test environment.
- Custom-host SSE accounting may use a generic parser. Wire counters do not
  verify UI spend, budgets, managed-model permissions or prices.

See [stock gateway audit](../integration/litellm/README.md). Colliding a custom
route with `/v1/messages` was an isolated experiment, not recommended deployment.

### Strengthened synthetic acceptance audit

The updated stock audit separates **expected observations**, **preservation
successes**, **known losses**, and **not tested**. A passing process must not be
reported as full native fidelity. In addition to 26 baseline scenarios, six
actual HTTP-issued SSE-to-tool-result round trips reconstruct fragmented UTF-8,
thinking/signatures, signed-empty and redacted blocks, then replay only the
received assistant content. Success/error tool results and 5m/1h TTLs are checked.

The normal Messages path loses signed-empty history; a fake upstream rejects
both reconstructed continuations. Built-in and custom pass-through preserve
the tested opaque history and succeed in all four continuations. Fake-oracle
mutation checks ensure corrupted/dropped opaque blocks would fail. This is a
synthetic client, **not** actual coding-client certification or real signature
validation. Model ACLs, budgets, UI accounting and real cache savings remain
explicitly untested by this offline audit.

Local TypeScript build and the expanded Node suite pass 54/54, including ten
request-shape/transport safety tests. These additions change test/diagnostic
tooling and documentation, not production relay transport or LiteLLM sources.

### Live stock-gateway-to-relay check

A temporary loopback stock 1.103.1 gateway forwarded its authenticated custom
Messages/count-token routes to the new Docker test relay and real Haiku 4.5.
This was **not** the deployed `.7` gateway and did not change its settings.

- Count-token fixture: 7430 input tokens.
- Streaming call returned signed thinking and a tool request.
- Unmodified signed assistant blocks plus a synthetic tool result were accepted.
- Repeating that continuation returned the correct synthetic marker, cache read
  **7519**, fresh input **6**, output **10**, cache creation **0**.
- Relay history matched these counters and indicated complete usage. Temporary
  gateway process was stopped; credentials/signatures were not saved in reports.

An initial local harness attempt used a `.json` config extension, which LiteLLM
did not load; it returned 404 before reaching the relay. Using the supported
`.yaml` extension corrected the fixture. Only the corrected run establishes
the live result. Actual `.7` route/key changes await a separate user decision.

## Actual clients and free-gateway policy

The user selected **Claude Code + Codex as mandatory**, OpenCode as additional,
and free supported LiteLLM paths only. That whole objective is **not achieved**.

Actual isolated Codex 0.160.0 ran against stock LiteLLM 1.103.1 and a loopback
fake Anthropic provider. Both signed-nonempty and full-opaque fixtures completed
exactly one tool round trip and an exact final marker, but both failed ordered
assistant fidelity. A loopback wire observer localized the loss:

- Incremental reasoning `output_item.done` lacks opaque content; only the final
  `response.completed` includes it. Codex replays the reasoning with null opaque
  content, leaving only `tool_use` in the subsequent Anthropic assistant turn.
- Completed opaque state is independently malformed: split signature deltas
  produce separate blocks and duplicated thinking text; signed-empty is lost.
- The fake alias causes a model-metadata fallback warning. No real provider,
  cache hit, subscription permission, `.7` deployment, or quality claim follows.

The source guard passed before/after. Default fidelity mode correctly exits
nonzero; explicit observation-only mode completes successfully while retaining
`full_fidelity:false`. A read-only inspection found the same relevant defects in
LiteLLM v1.103.3 source; no newer gateway was deployed or runtime-certified.

Separately, actual OpenCode 1.18.34 directly against a fake Anthropic provider
preserved tested nonempty thinking/signature, redacted state and tool replay.
This is not gateway-chain or signed-empty coverage. Detailed scope and runnable
fixtures are in [actual-client verification](../integration/clients/README.md).
The later [OpenCode chain qualification](#opencode-native-gateway-chain-qualification)
adds those synthetic checks without changing this original baseline's scope.

The deployed UI's disabled Premium authentication control does not match the
pinned backend's intentional free `auth:true` support. An independent offline
audit verified 25 policy/schema/helper observations, with 13 selected source
identities unchanged. It also verified constraints: typed admin config drops
`forward_headers`; YAML ownership blocks field API writes; custom routes skip
managed-model ACLs; default generic/flat-zero accounting is not financial
acceptance. No DB-backed virtual-key HTTP or persisted spend test was performed.

No `.7` settings, production service, upstream credentials, or LiteLLM source
were changed during this client/policy verification. Completing dynamic-header
configuration needs the gateway owner's file/reload access. Codex live Claude
authorization and any separately billed API-key budget need an explicit choice.
A proxy-owned Responses adapter was proposed after these negative tests. The
subsequent explicitly authorized implementation is recorded below; it does not
reintroduce the withdrawn SDK backend or change this stock negative result.

## Proxy-owned Responses adapter (2026-10-05)

User direction: improve and implement **without modifying LiteLLM**. The new
optional `/v1/responses` lives entirely in this repository. It is disabled by
default, requires a separate 32-byte state key, and uses stock authenticated
pass-through with its own non-colliding gateway namespace. Native Messages
transport remains unchanged apart from sharing its existing header helper.

Implemented: strict stateless request/tool translation, incremental Responses
events, exact original signed/empty/redacted thinking in versioned AEAD
capsules, complete capsules on both item completion and full completion, and
replay scoped to relay-key fingerprint/model/upstream credential/item ID.
Unknown semantics and bad/expired state fail explicitly. Client-requested
native cache TTL/adaptive thinking can use a bounded header; it is never
forwarded to the upstream as a header. There is no new proxy-enforced caching
policy, SDK, CLI execution, impersonation, retry or account/model fallback.

Local TypeScript build and **102/102 Node tests** pass. Coverage includes the
existing native regressions plus request/stream/state/HTTP adapter tests, safe
history, credential/model separation, deadlines/disconnect/admin cancellation, malformed UTF-8, HTTP errors and
invalid terminal framing. Independent review found inconsistent tool-ID bounds;
output and replay now share a 256-character bound, with 64/65/256/257 boundary
regressions for both function and custom tools.

Actual **Codex 0.160.0 → stock LiteLLM 1.103.1 pass-through → new built relay →
loopback fake provider** passes both signed-nonempty and full-opaque tool turns:

- Exactly two requests per hop, one matching read-only `get_goal` result and
  the exact final marker; no repeated provider request.
- Exact ordered native assistant history on the second call, including split
  signature assembly, signed-empty and redacted blocks.
- Identical nonempty capsules on incremental completion, full completion and
  actual Codex replay; fresh synthetic gateway/relay credentials never leaked
  upstream. All 13 guarded stock LiteLLM sources remain unchanged.
- Model metadata fallback warning remains; unknown reasoning token splits are
  omitted, not fabricated as zero. Fixture processes are stopped afterward.

An initial fixture exposed Codex rejecting an empty `output_tokens_details`
object. Omitting that optional object when its required split is unknown fixed
the client test. Only corrected successful runs establish the positive result.
Evidence stays in private temporary directories; [reproducible harness and
scope](../integration/clients/README.md) are committed without credentials.

This completes the bounded adapter implementation, **not the whole production
goal**. No new image was deployed, no `.7` config changed, and no real provider
was called for this adapter. Actual Claude Code/Codex through that deployed
gateway, permitted real Codex authentication, DB-backed gateway route policy
and spend/budget accounting, cache-hit measurements, long coding sessions and
additional OpenCode chain verification remain. Remote Responses compaction,
saved conversations and server tools are intentionally unsupported. See
[configuration and full supported subset](RESPONSES-ADAPTER.md).

## Actual Claude Code through the synthetic stock gateway

Unmodified official Claude Code **2.1.289** ran with an isolated home/config and
only the read-only `Read` tool against stock LiteLLM **1.103.1** pass-through,
the built native relay, and a loopback fake provider. No existing login, real
provider credential or production configuration was used.

Two signature modes used identical seven-byte transport fragmentation, each
with signed-nonempty and full-opaque scenarios:

| Mode | Ordered native history replay | Other result |
| --- | --- | --- |
| One `signature_delta` per thinking block | Exact thinking/signature, signed-empty, redacted and tool content | Actual fixture Read and exact final marker, two requests per hop |
| Two `signature_delta` events per thinking block | Signature contains only the final fragment in the actual client's next request | Read/final answer still succeed; redacted/tool/text order retained |

For both modes, response/SSE payload bytes, beta headers, authentication
separation and 13 guarded stock source identities pass. In the split-event
stress case, the signature loss is already visible before the request reaches
LiteLLM; it is not native relay corruption. This does not establish that the
same pattern occurs in real provider traffic or that all official-client
versions behave identically.

Separately, complete request JSON objects are **not identical** on either mode:
the stock generic pass-through removes top-level `metadata`. This reproduces
the earlier stock audit, beyond ordinary JSON serialization differences.
Consequently the passing single-event state subset is not whole-body fidelity
or whole-goal completion. The strict full-fidelity result remains negative.

The [reproducible Claude Code harness](../integration/clients/README-claude-code.md)
records these separate claims; no source workaround, signature reconstruction,
provider call or hidden retry was added. Isolation is application-level, not
an OS-enforced sandbox. Actual `.7` and real client/model qualification remain.

## Remaining boundaries

### Goal-entry Docker candidate qualification

After the user registered the whole objective for continued execution, commit
`591e44d8648b727216d50a10a0ca4c4b6a77e42f` was archived from Git and copied to a
new task-specific directory on the existing test host. Local and remote archive
SHA-256 matched. No working-tree files or secrets were included in that archive.

- Candidate image `local/test-claudemock:591e44d` built successfully, with ID
  `sha256:5da3739096525b811104ef73a2091f48c8e0d508435196fce4cbd9be103686fe`.
- Actual runtime is **Node v22.23.3**, image user `node`. All **102/102** Node
  tests passed inside that image with external networking disabled, read-only
  root, dropped capabilities and read-only test/diagnostic mounts.
- Separate no-network startup checks verified default Responses returns 404
  and enabling it without a state key fails startup. No provider credentials
  were supplied to these fixture containers.
- Temporary fixture containers were removed on exit. The existing
  `test-claudemock` ID, image (`0ca7575`) and start time stayed unchanged.
  The candidate image/source/log remain available for later qualification.

This establishes Docker build/runtime compatibility, **not deployment**, a
production security audit, a fresh dependency-vulnerability assessment, or live
provider/gateway acceptance. The [whole-outcome gates](ACCEPTANCE.md) remain open.

### Validated apply_patch candidate qualification

Commit `acd9379` adds an explicit `RESPONSES_APPLY_PATCH_MODE=validated` option,
defaulting to `reject`. Local build and **111/111 Node tests** passed, including
stream/nonstream/replay grammar checks, invalid-output blocking, EOF/cancellation,
configuration validation and existing native/state/authorization regressions.
An independent code review's missing EOF/cancellation test was added. The LF
base grammar matched the pinned official source byte-for-byte; the actual Windows
CLI additionally exposed the exact CRLF asset spelling, now explicitly accepted.
Neither spelling authorizes normalization of patch input.

- The committed-only archive SHA-256 matched on local/test hosts:
  `4af1343beea80bebe8174fa5d794fba9bf578545354ea5f07ede7488d3d4d261`.
- Candidate `local/test-claudemock:acd9379` built with image ID
  `sha256:dfcb61738f25052f4dc3b2ec970af5dbc8b28061a4a6a59893504f9a104b27d5`.
- Linux **Node v22.23.3**, user `node`, also passed **111/111** tests in a
  no-network/read-only/capabilities-dropped fixture container. The final command
  returned zero; logs remain in the bounded candidate directory as
  `node-tests-confirmed.log`. An earlier shell exit-status wrapper was corrected;
  both test outputs reported all 111 tests passing.
- A separate no-network check confirmed default mode `reject`, and the grammar
  license and attribution are both present in the runtime image.
- Existing `test-claudemock` container ID, image `0ca7575`, and start timestamp
  were unchanged. No existing test/production container or gateway was replaced,
  no real provider was called, and no user authentication was loaded.

The actual Codex 0.160.0 synthetic coding-tool check offers the real freeform
`apply_patch` tool using a test-only catalog, with shell tools disabled. Through
stock LiteLLM 1.103.1 and the adapter, ordered signed/empty/redacted reasoning and
the patch/tool-result history replay exactly. A malformed patch fails before any
custom tool-call completion reaches the client. However, the valid patch is
**not applied**: this Windows CLI downgraded its requested workspace-write policy
to read-only because no Windows sandbox mode was configured. The tool error is
replayed unchanged; an eventual final marker is not editing success. No sandbox
bypass, global profile change, ACL/user/firewall setup or reroute was performed.

See the [coding-tool harness](../integration/clients/README-codex-patch.md) for
the isolated reproduction, negative results and distinct transport/execution
gates. Real provider quality/cost/grammar acceptance, a write-capable client and
the deployed `.7` gateway remain unverified.

### Historical tools and local compaction candidate

Commit `98d26fe` separates history-only transport identity from currently callable
tools. Local build and **115/115 Node tests** pass, including removed/omitted or
replaced current tools, deliberate namespace/kind collisions, exact signed-state
replay and rejection of new calls to removed tools in stream/nonstream HTTP.
An independent code review found no must-fix issue; its suggested grammar-
provenance boundary test was added. Missing old custom grammars are not inferred
from names, and no historical schema or new tool permission is fabricated.

- Committed-only archive SHA-256 matched between local and test hosts:
  `b392c7a58063fbc6b6e5a1a263defd145d74a821a422a2b4abe7dd55c3af0b2f`.
- Candidate `local/test-claudemock:98d26fe` image ID is
  `sha256:8e7e8f474262dde1ed995ddb99c7b4086c26e15ad2c41b1ea3f8bb8eaed989aa`.
  Its revision label is `98d26fef65ab8bc946c95e012d0c106fd7f02d39`.
- Linux **Node v22.23.3**, user `node`, passed **115/115** tests in the isolated
  no-network/read-only/capabilities-dropped fixture container. Test exit was zero;
  source/build/test logs remain in `/opt/test-claudemock/verify-98d26fe-SIDeZp`.
- Existing `test-claudemock` ID, image `0ca7575` and start time remained unchanged.
  No gateway config, provider credential, sandbox setup or existing service was
  changed. The retained image is a candidate, not a deployed replacement.

The actual Codex 0.160.0 app-server additionally completes manual local compaction
through the stock gateway and relay against a fake provider. The independently
rerun final harness preserves reasoning IDs/capsules and native blocks through
the initial real `get_goal` result and the empty-tools compaction request. It
observes both context-compaction lifecycle events and successful compaction.
Its next ordinary user turn **fails**: Codex reinserts a developer message after
retained user messages; the adapter returns 400 `unsupported_parameter` without
provider contact or relocation. Exactly four client requests and three provider
requests occur; strict test exit is 1. Final evidence is
`C:/Users/binary/AppData/Local/Temp/codex-compaction-main-20261005/codex-compaction-smoke.json`.
See the [reproducible harness](../integration/clients/README-codex-compaction.md).

These checks establish adapter behavior, not real-provider acceptance of history
without current definitions, cache savings, summarization quality or full-session
compatibility. Remote `/responses/compact` and late developer-role mapping remain
unsupported. See [Codex qualification](CODEX-QUALIFICATION.md).

### OpenCode native gateway-chain qualification

Actual pinned OpenCode **1.18.34** was subsequently run through stock LiteLLM
**1.103.1** authenticated custom pass-through and the built native relay, against
a loopback fake Anthropic provider. No new backend change was required. Four
isolated cases separate nonempty versus full opaque (signed-empty plus redacted)
history, and one versus two signature SSE events. All responses are written in
seven-byte chunks. The empty-thinking control explicitly includes an empty
`thinking_delta` before its signature, matching the documented event shape.

Both **single-signature controls pass**: the actual client executes only Read
on the exact synthetic fixture, completes the expected final answer, and replays
ordered thinking/signatures/empty/redacted/tool content. OpenCode adds an
ephemeral cache marker to tool_use; the test reports this mutation separately
and asserts the exact expected marked content, not equality with unmodified
issued content.

Both **two-signature-event stress cases lose the first fragment in the client**,
already visible before LiteLLM. The next native request contains that same
last-fragment signature. This is not observed gateway/relay stripping, nor proof
that real Anthropic normally emits multiple signature events. The pinned client
and SDK source metadata-replacement path agrees with the captured behavior.

- Exactly two client and two provider requests occur per case, eight per hop
  overall; all actual Read/final/step-finish checks pass and no retry is hidden.
- Each tested client request body, including serialized bytes, matches the
  provider-bound body. Both response SSE byte arrays and beta headers match.
  These requests have **no top-level metadata**, so the known stock metadata
  removal was not exercised. This is not universal byte-transparent gateway
  behavior or a contradiction of the Claude Code metadata finding.
- Generated credential separation, unchanged fixture/workspace and all 13
  stock source guards pass. Each case's incidental registry/release attempts
  are rejected by a local proxy, without forwarding; no OS-level egress claim.
- Final report: `observation_completed:true`, `state_control_pass:true`,
  `state_stress_pass:false`, `whole_body_semantic_exact:true`,
  `strict_qualification_pass:false`. Default strict exit is **1**, preserving
  the negative stress finding.
- Evidence resides in
  `C:/Users/binary/AppData/Local/Temp/opencode-gateway-qualified-2e4d8a321feb44c99a829b52fc3f0c3a/`.
  HEAD independently recomputed hop body comparisons, response SSE hashes and
  full-versus-last-fragment signatures from those captures; this was evidence
  inspection, not a second CLI run. An earlier fixture-only Windows CRLF/LF
  assertion mismatch was fixed before the final four-case execution, without
  changing old evidence or client/relay/gateway behavior.

See the [reproducible harness](../integration/clients/README-opencode-gateway.md)
and [pinned source cross-check](../integration/clients/README-opencode.md#pinned-source-cross-check).
No actual provider credential, `.7` deployment, entitlement, cache hit, price,
long-session, model-switch or arbitrary-tool compatibility is established.
The existing test/production containers were not changed by this qualification.

## Isolated Docker lifecycle qualification

On 2026-10-05, the [lifecycle harness](../integration/deployment/README-lifecycle.md)
ran on the `.64` Docker host (Docker 29.4.0, Python 3.10.12), using the already
qualified immutable images, without pulling/rebuilding or real credentials:

- Baseline `0ca75751d407b0bce2f9c15675b1e0d8fd8075c4`:
  `sha256:12d35112176de03ab3d1e2ae46a91a8ca6a98168478c98fd6aaf37fcb9b85fc3`.
- Candidate `98d26fef65ab8bc946c95e012d0c106fd7f02d39`:
  `sha256:8e7e8f474262dde1ed995ddb99c7b4086c26e15ad2c41b1ea3f8bb8eaed989aa`.

All **7/7 phases pass**, exit 0: baseline seed/re-creation, candidate upgrade and
streamed reasoning mint, candidate re-creation/replay, wrong state-key rejection,
native baseline rollback, and candidate re-upgrade/original-state replay.

- Seven fresh non-root/read-only containers use `network=none`, no host port or
  bind mount, one new owner-labelled synthetic volume and bounded resources.
  Each loads the image's actual app/database through a test bootstrap, not its
  `dist/server.js` entrypoint or production Compose. Inspected isolation matches
  the requested flags. A fake provider lives on container loopback only.
- Six total fake-provider requests occur, one in each successful request phase.
  The changed-key phase returns `409 invalid_reasoning_state`, with **zero**
  provider calls/new history rows. No tool execution is part of this fixture.
- Ordered nonempty thinking, signed-empty thinking, redacted thinking and text
  match the originally issued blocks after re-creation and again after rollback
  plus re-upgrade. Minting uses split signature events and seven-byte UTF-8/CRLF
  chunks; output-item-done/completed capsules agree.
- Every phase preserves the active key's exact model ACL and rejected revoked
  key, the original history row and DB-selected synthetic provider credential.
  All six successful rows have input 3/output 9/cache-read 7/cache-create 2,
  5-minute/1-hour creation counts 1 each, complete usage and **null** billed USD.
  New stored prompt/response/preview fields remain null. These are fixture
  counters, not real cache hits or price evidence.
- A SQLite backup of the seeded DB passes a separate read-only integrity/count
  check. **Restoration is not tested.** Migration/key/history-service sources
  are identical for this exact image pair; future schema rollback is not implied.
- Rolling back restores native Messages only; Responses returns 404 without a
  provider call. Re-upgrading with the original private state key restores replay
  within the fixture's one-hour TTL. Lost client history is not reconstructed.
- Cleanup passes with no remaining owned resources. A subsequent labelled-resource
  read finds no fixture containers/volumes. Existing `test-claudemock` ID
  `e818d18871aef221db9410031c27c9b2993f413d04b424629901109f732f1ccc`, image and
  start time `2026-10-04T18:34:12.359589146Z` remain unchanged.

Evidence: `/opt/test-claudemock/lifecycle-ckZWLW/result.json`, copied to
`C:/Users/binary/AppData/Local/Temp/claude-lifecycle-ckZWLW/result.json`; both have
SHA-256 `665b3ab6cbe6d1efbbc209848cd71af072702ebb723844c998fd4f443642bb03`.
Host/local script hashes were matched before execution. Main independently
inspected the implementation/result and verified seven phases, six provider calls
and cleanup. Five Python guard tests pass locally and on the host; Node syntax,
TypeScript build and existing 115 Node regressions also pass locally.

This is normal process/container **re-creation**, not `docker restart`, crash
recovery, in-flight draining or a service cutover. No `.7` gateway configuration,
real client/provider session, authentication eligibility or whole-goal acceptance
is established by it. See the [operating checklist](ADAPTER-PATCH.md#native-only-update-and-rollback-checklist).

### Fresh-volume backup restoration extension

The original seven-phase result above remains unchanged. A subsequent run adds
an eighth `backup_restore_replay` phase with the same exact image pair and an
additional fresh, owner-labelled volume. **8/8 phases and cleanup pass**, exit 0.

The original synthetic volume is mounted read-only at `/fixture-source`; only
the completed `seed-backup.db` is copied into the fresh target, with overwrite
prohibited. Its digest matches before SQLite opens it. The restored database
passes integrity and foreign-key checks, contains the two original key rows and
one original history row, and supports authenticated replay through the actual
candidate app. Exact model restrictions, the pre-backup revoked-key rejection,
provider credential selection and the full old history row are checked.

The configuration state key and opaque client history are supplied **separately**
from the private synthetic fixture file, not recovered from SQLite. Original
thinking/signed-empty/redacted/text blocks replay exactly. The new fake-provider
request produces one new correct usage record, making two restored-volume rows.
Five rows created after the seed backup are absent from the restored database,
as expected. This deliberately exposes snapshot age; it does not reconcile later
key revocations/settings or reconstruct lost client history.

Original source backup, live DB and fixture file digests are unchanged. The full
run has seven fake-provider calls; the wrong-state-key phase still has zero.
Eight fixture containers and both fresh volumes are removed after owner checks;
the subsequent labelled-resource query returns none. Existing `test-claudemock`
ID/image/start time remain the same as recorded above; no gateway or production
data is used or changed.

Evidence: `/opt/test-claudemock/restore-0zWdIQ/result.json`, copied to
`C:/Users/binary/AppData/Local/Temp/claude-restore-0zWdIQ/result.json`, both SHA-256
`051d37d77c269d7a9fd093a3102376a81676834aeabe30720f3c5c3f11d7ec30`.
All three source-file hashes matched on the host before execution. Seven Python
guard tests pass locally/on the host, including distinct read-only restore
mounts and missing-resource error discrimination; Node syntax passes. An
independent read-only review found no execution-blocking issue. This closes
only the synthetic restoration gap, not a real-deployment restore, provider
acceptance or full end-to-end gate.

### Developer hoisting comparison (2026-10-05)

At code commit `1d9bbf772ca50efe73e2bf5dcf12a2e6aeccfc2f`, the explicit proxy-only
`RESPONSES_DEVELOPER_MESSAGE_MODE=hoist` passes actual Codex 0.160.0 manual
compaction followed by two ordinary turns through stock LiteLLM 1.103.1 and a
loopback fake Anthropic endpoint. All five requests reach the fake once. System
blocks match an independent projection and remain identical across compaction;
new signed/nonempty, signed-empty and redacted reasoning replays exactly on the
second follow-up. Default reject reproduces the prior 400 with four client and
three fake-provider requests. Main independently reran both committed modes.

All 123 Node regressions and six Python evidence-oracle tests pass. New HTTP/unit
tests require changed system + old hoist capsules to fail 409 before upstream
contact, and prevent capsule reuse across policy modes. No provider signatures
are fabricated as real: all generated signatures/counters are synthetic. The
guard authenticates the effective system, not the full conversation, and does
not establish instruction hierarchy equivalence or cache savings. See the
[evidence paths/digests and exact scope](../integration/clients/README-codex-compaction.md#opt-in-hoist-comparison-2026-10-05).
No installed client, LiteLLM source or `.7`/`.64` deployment was changed. Earlier
Docker qualification applies to `98d26fe`, not this new mode.

### Hoist Docker build and real-provider gate (2026-10-06)

Historical failed stage; the corrected successful stage is recorded below.

Exact archived source `f75d75c8030871fa3c39f29c0d11bbd4129c8426` (hoist code
`1d9bbf7`) was built using the repository Dockerfile on `.64`, producing
`sha256:1a54131ea9569e3c60c533adb729f95b40d3e13f5b4c9abbd9b7d0811b95974f`.
The source archive SHA-256 is
`d04e7fd3ff521ec41bca625508ab09d61208aac3b28b012a022d56775fd1c5fe`.
All **123 existing Node regressions pass inside that image**, with network disabled,
non-root/read-only runtime and synthetic credentials. This is not a lifecycle
upgrade qualification or a cutover of the running service.

Two subsequent, separately bounded direct-provider invocations each made exactly
one request to `claude-haiku-4-5-20251001`, using the existing container's selected
OAuth credential privately. The first was the planned three-phase probe, stopped
at seed failure; the second was explicitly diagnostic-only with a one-call cap.
There were **two real provider calls total**, no fallback/hidden retry, and no
LiteLLM or actual Codex session in either invocation.

Both returned upstream and downstream HTTP 200 but failed stream qualification.
The diagnostic invocation identifies the actual boundary:

- Native `message_start` produced `response.failed` /
  `unsupported_upstream_event`; the history row records failure/incomplete usage.
- The message model matches the requested Haiku model. There are zero extra
  event-level keys, but **three extra message-level keys** outside the adapter's
  allowlist. `container` and `stop_details` are present; the third key and all
  values were deliberately not captured. Do not infer their values or a refusal
  from presence alone.
- `ResponsesStream.handle()` rejects these extra keys before reasoning creation,
  tool output, or developer-position replay. A synthetic reproduction now shows
  that either named field alone (even null) causes this current failure.
- The relay sets HTTP 200 before translating SSE; HTTP status alone is not a
  success oracle. The probe correctly rejects the failed terminal.

The current [official Messages schema](https://platform.claude.com/docs/en/api/messages/create)
documents `container` and `stop_details`. This is evidence of an adapter/schema
compatibility gap, not proof of an OAuth quota failure. A future correction must
explicitly handle supported metadata and stop semantics, not ignore all unknown
fields or drop signed reasoning. No runtime parser relaxation was made in this
test-only change; the full third-field/value shape remains unobserved.

**Not reached:** real signed-state replay, identical replay/cache measurements,
changed-system negative control, actual client compaction, `.7` routing or gateway
authorization/accounting. False cache-read flags in these failed reports mean
unobserved, **not zero cache hits**, and do not establish any cost or quality claim.

Both fresh candidate containers use an in-memory DB, no mounts/host ports,
UID/GID 1000, read-only rootfs, dropped capabilities, bounded resources and bridge
networking for the explicit provider call. Test-only instrumentation reports
fixed error enums, booleans/counts and usage numbers, not content or signatures.
No prompt/response/preview is stored. Existing `test-claudemock` ID, image, start
time and mounts remain unchanged; owned temporary containers were removed.
The injected token exists in Docker container metadata until that removal; this
is not a claim of diskless credential handling or OS-level egress isolation.

Sanitized local evidence under
`C:/Users/binary/AppData/Local/Temp/claude-hoist-next-20261006/`:

- `hoist-live-result.json`, SHA-256
  `22143a201e99225a2cdd19da5652b79ee33d89ecd9c69a2326e7cf8c7debe2ba`;
  helper SHA-256 `3d84d0d00ab929e2cbae6d3c59b47e2d5282f68ab8d95940f91f7ab1fe01abb9`.
- `hoist-diagnostic-result.json`, SHA-256
  `d6fbd3bfd3ca5f7316c68a2a18fdf4d5eee2c0f1aeae1f9336a5728636ccf09f`;
  helper SHA-256 `72bc82563cb559851ccd62b983b57b453734b8853bd726d3ac3b99cf8d5164b4`.

The retained [manual live runner](../integration/deployment/README-lifecycle.md#separate-manual-live-hoist-probe)
has 11 pure Python safety tests and seven pure helper tests. After adding the
metadata failure reproduction, all 124 backend tests pass locally, and all 17
stream tests (including that reproduction) pass in the exact candidate image.
These passing negative tests reproduce the live defect; they do not fix it.
Limits are per
invocation, not a durable cross-run allowance; failed/uncertain runs must not be
automatically repeated. The gateway owner independently rechecked `.7`: no custom
route is applied; original Stack configuration access in authenticated Portainer
is still needed. No gateway reload, credential change or deployment occurred.

### Metadata compatibility fix and live Responses replay (2026-10-06)

**Result: PASS for the bounded direct-provider sequence.** Implementation
`c8e1dcbae1fda83368f6602bc0cff00c51b9b197` handles native response metadata,
nullable cumulative usage updates, empty/null citations and default direct-tool
fields. Explicit provider refusal becomes a structured failed response, not a
retryable parser error. Metadata is response-only; signed reasoning blocks,
tool arguments/IDs and order survive replay. See the
[adapter contract](RESPONSES-ADAPTER.md#native-response-metadata-contract).

Source `f27c51ebea29a37cd85bb1ba808f2c5bbec38d6e` additionally updates the
`proxy-addr` lockfile entry to 2.0.8. Built on `.64` from source archive SHA-256
`63e23b20404f9ad71accf1231c57943d52ae2750245c26f2d7be94538194cd36`:

- Tag: `local/test-claudemock:f27c51e`.
- Exact image: `sha256:bc6d2ef8c42f8209d741ac6c7b93855073b12cf052144bb1aafb81170be00718`.
- All **149/149 backend regressions pass in this exact image**, network disabled,
  with synthetic credentials; the same source suite passes locally.
- Real probe: `claude-haiku-4-5-20251001`, existing selected OAuth credential,
  three provider calls and four local requests, with no retry/fallback.

| Phase | Fresh input | Cache creation | Cache read | Output | Responses input | Responses total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Seed signed reasoning and one tool call | 10 | 5503 | 0 | 122 | 5513 | 5635 |
| Same developer text moved after user, signed-state/tool-result replay | 5 | 148 | 5503 | 11 | 5656 | 5667 |
| Identical native request replay | 5 | 0 | 5651 | 11 | 5656 | 5667 |

All cache creations are reported as 5-minute writes; 1-hour writes are zero.
Each phase has upstream/downstream HTTP 200, exactly one provider request, a
completed SSE response, complete usage and matching persisted history counters.
The effective top-level system is unchanged by the developer position move.
Both replay responses contain the expected visible test marker and no further
tool call. Native bodies of the second and third requests match exactly.

A fourth local request changes the developer instruction while retaining old
reasoning state. It returns `409 invalid_reasoning_state` before provider contact
or a fourth history row. The proxy executes no tools: the driver supplies a
synthetic lookup result. Provider signatures are preserved and accepted by the
real upstream on replay, **not cryptographically verified locally**. This does
not test real Codex compaction, actual filesystem tools, answer quality, exact
billed savings, another model, or the deployed `.7` gateway/client chain.

This successful invocation made three provider calls. Together with the two
failed seed/diagnostic calls above, these stages total **five real calls**.
No conversation/signature content is retained in the report or history. The
candidate container was removed; existing `test-claudemock` remained image
`12d35112176d...`, container ID `e818d18871ae...`, started
`2026-10-04T18:34:12.359589146Z`. No `.7` route or service was changed.

Evidence:

- [Sanitized measured report](evidence/haiku-hoist-20261006.json), copied from the
  successful command's JSON section, without the two preceding file-hash lines.
- Original local capture:
  `C:/Users/binary/AppData/Local/Temp/claude-metadata-20261006/metadata-live-result.txt`,
  SHA-256 `68a5c5845f7d9fd79e2dce1457660c65ef956f0b7e1d7e12bb67e754902fa0b0`.
- Executed helper SHA-256:
  `392bb347e11516fcee57a50a609d1a8aaa36282680ecd659aa3d2624c11b5155`;
  executed runner SHA-256:
  `b8708de7ff66216778b2c5f3e91b10aafe6d842539d2d3db037ba7350cf534f9`.
  The runner's candidate pin was updated to the exact image above after build.
- Exact-image regression capture:
  `C:/Users/binary/AppData/Local/Temp/claude-metadata-20261006/final-image-regression.txt`,
  SHA-256 `1f74eef23d867f5f807f89a5ca3087c9e838c3de41460d65991b7fdc0cc96c60`.

The next functional step is actual-client integration through `.7`, not another
security-audit gate. Gateway configuration remains owned by `LiteLLM 관리`;
original Portainer Stack access is pending, and the existing test service still
runs the native-only baseline.

### Remaining end-to-end constraints

- General-purpose subscription-token relay eligibility and premium-model raw
  acceptance remain unresolved. No spoofing, SDK fallback or paid-key failover.
- [Official gateway documentation](https://code.claude.com/docs/en/llm-gateway#subscriptions-and-gateways)
  describes actual Claude Code retaining subscription login through a gateway.
  This is not blanket permission for arbitrary clients to reuse stored tokens.
- Clients cannot recover discarded signatures. No universal coding-client
  fidelity, cross-account signature portability, conversation persistence or
  `previous_response_id` store is provided.
- Pass-through has not established managed-route-equivalent model permissions,
  budgets, aliases, accounting or logs. Verify before rollout.
- Production/master are not replaced. The local admin UI build is separate
  from the backend-only test deployment.
