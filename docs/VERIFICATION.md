# Native relay verification — 2026-10-05

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

## Current diagnostics revision and deployment

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

### Outstanding end-to-end constraints

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
