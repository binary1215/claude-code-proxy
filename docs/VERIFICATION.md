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
| Local TypeScript build + Node HTTP/SQLite tests | 44/44 passed |
| Same tests in the actual Node 22 Docker image, network disabled | 44/44 passed |
| Admin TypeScript + Next.js production build | Passed |
| Independent bounded observer/storage/lifecycle/migration review | Findings fixed and rechecked |
| Stock FastAPI audit | 26 expected-behavior scenarios passed; includes known lossy default-route behavior |
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

## Remaining boundaries

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
