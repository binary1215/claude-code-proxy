# Stock LiteLLM gateway verification

This project does **not** modify LiteLLM. The earlier source patch, installer
and patch-dependent suites were withdrawn. Their historical passing results do
not establish compatibility with an unmodified gateway.

Audited upstream: [LiteLLM 1.103.1 at
580bde9a2d148714889ec1c04a9872819e78a778](https://github.com/BerriAI/litellm/tree/580bde9a2d148714889ec1c04a9872819e78a778).
Re-test after upgrades. Tests use actual FastAPI HTTP requests, not only library
calls. The deployed UI also reports 1.103.1; that is not a source-integrity check
of the deployed gateway.

## Findings

| Path | Observed behavior in the pinned stock gateway |
| --- | --- |
| Normal `/v1/messages` with `anthropic/` model | Drops signed-empty thinking and an unknown beta; invalid signature causes another upstream request with thinking removed, even with router retries zero |
| Built-in `/anthropic/v1/messages` | Preserves tested thinking/signatures/tools/cache/beta and raw response/SSE bytes; signature rejection remains one 400 |
| Explicit custom pass-through route | Same tested content/response preservation with a configurable relay target |

**Pass-through is not whole-request byte preservation.** LiteLLM re-encodes
JSON and removes top-level `metadata`. The relay cannot recover fields lost
before it. Chat/Responses conversion remains outside this native pass-through contract.

Codex now has a separate [proxy-owned Responses adapter](../../docs/RESPONSES-ADAPTER.md),
behind another stock authenticated pass-through route. It bypasses the normal
LiteLLM Responses conversion without modifying LiteLLM. Actual Codex synthetic
signed-state/tool replay passes on that path; separately approved shared-gateway
deployment and actual-provider results are summarized below. The policy/accounting
constraints still apply; the candidate configuration is not an automatic installer.

Custom-host SSE can take a generic logging path instead of Anthropic's usage
parser. Wire usage preservation does **not** prove spend logs, budgets or prices.
Pass-through auth also does not establish the same model permissions, aliases,
routing or fallbacks as `model_list`. This is a fidelity-first candidate, not a
production gateway-policy replacement.

## Candidate configuration (not installed automatically)

Use a distinct namespace; do not shadow `/v1/messages` or other existing routes.
Configure gateway master/virtual-key policy through normal secret management.
The relay key, gateway caller key and upstream Anthropic credential are separate.

```yaml
general_settings:
  pass_through_endpoints:
    - path: /claude-native/v1/messages
      target: http://YOUR_RELAY_HOST:13456/v1/messages
      methods: [POST]
      auth: true
      forward_headers: true
      headers:
        Authorization: os.environ/CLAUDE_PROXY_AUTHORIZATION
        x-api-key: ""
        anthropic-version: "2023-06-01"
```

`CLAUDE_PROXY_AUTHORIZATION` contains `Bearer <relay-proxy-key>`, supplied
privately to LiteLLM. Static Authorization replaces gateway bearer auth; the
empty `x-api-key` prevents forwarding another caller credential. Caller beta
flags otherwise pass through. Use only a trusted target and keep `auth: true`.

With the same auth/header configuration, add separate routes as needed:

| Method | Client path | Relay target path |
| --- | --- | --- |
| POST | `/claude-native/v1/messages/count_tokens` | `/v1/messages/count_tokens` |
| GET | `/claude-native/v1/models` | `/v1/models` |

Messages clients use `/claude-native` as base and real upstream model IDs.
Validate URL construction and signed-history replay per client. Do not assume
normal aliases or Chat/Responses requests work here. Verify virtual-key route
restrictions, model permissions and spend logs before production rollout.

## Reproducible isolated HTTP audit

Use a fresh stock `litellm[proxy]==1.103.1` environment and required proxy runtime
dependencies (the audited environment also required `prisma==0.11.0`). Paired
audit/bootstrap scripts use a loopback fake upstream and random temporary key,
remove inherited credentials, disable telemetry and check 13 pinned source-file
identities before/after. They do not edit LiteLLM or call a provider.

```sh
python integration/litellm/test_stock_gateway.py --output /path/to/temporary/evidence
```

Keep evidence outside the repo. The JSON report separates preservation from
known transformations. Audit completion is not universal client compatibility,
provider authorization, real cache savings, production rollout or verified
financial controls. See [project verification](../../docs/VERIFICATION.md).

The audit now includes 26 baseline scenarios and six real HTTP-issued synthetic
multi-turn replays: fragmented SSE is assembled into signed/empty/redacted/tool
blocks and returned with successful or failed tool results. It checks 5m/1h
cache TTLs and uses a mutation-checked fake validation oracle. The normal route's
history loss is expected to be **detected**, not counted as fidelity success.

Report schema 2 includes `semantic_capabilities` per route, explicit
`observed_known_loss` versus `fidelity_success`, an `acceptance` summary, and
`not_tested` for actual coding clients, real signatures/cache, managed-model
ACLs, budgets and UI/spend accounting. No tested route is declared whole-request
lossless: pass-through still strips metadata and reserializes JSON. Keep these
limitations in deployment decisions even when every expected observation matches.
The optional `--collision` probe is explicitly marked experimental/not asserted
for the colliding route; its exit status is not compatibility acceptance.
Credential isolation checks every upstream request, including retries and
multi-turn seed/replay calls, for the local random gateway key.

### Corrected-signature rerun (2026-10-06)

The rerun at proxy source `ba227e2` uses one **complete** `signature_delta` value
per signed block. Anthropic's pinned
[TypeScript SDK](https://github.com/anthropics/anthropic-sdk-typescript/blob/d49bdab458000bcdffe77bd84b03293f31824fb3/src/lib/MessageStream.ts)
and [Python SDK](https://github.com/anthropics/anthropic-sdk-python/blob/18f25547f20cf5f01da69ac611e700e3bc9ebf21/src/anthropic/lib/streaming/_messages.py)
replace the signature value on each such event; they do not concatenate signature
parts. The old split-part concatenation expectation was an unsupported oracle
assumption, not a demonstrated client defect. Historical evidence is unchanged.
Thinking/tool JSON remain fragmented, and seven-byte client reads exercise SSE
and UTF-8 assembly without claiming control of TCP packet boundaries.

| Corrected local run | Reviewed result |
| --- | --- |
| Stock gateway audit | 26 baseline cases and six multi-turn replays match expected observations; all 13 pinned source files remain unchanged |
| Stock replay fidelity | Four built-in/custom pass-through replays preserve the tested state; two normal-route replays detect known signed-history loss and end in the expected 400, not fidelity success |
| Actual Codex, fake-provider Responses adapter | Two scenarios and four requests at each hop pass ordered signed/empty/redacted/tool state and capsule replay |
| Actual Codex, fake-provider hoist compaction | Five requests at each hop pass manual compaction and two follow-ups, exact restored state and no hidden retries |

The stock report has zero validation errors and checks gateway-key isolation on
all 32 upstream requests, but explicitly reports `full_native_fidelity: false`.
The normal route has nine known-loss observations; each pass-through route has
two (metadata removal and request JSON reserialization). All three corrected
runs are local synthetic-provider tests, not new real-provider calls. Their
counts and source-report hashes are retained in the
[sanitized summary](../../docs/evidence/corrected-signature-qualification-20261006.json).

## Free authentication and configuration constraints

Deployment update, 2026-10-06: the owner applied the two `.7` Messages/Responses
routes using YAML and a user-approved restart, without changing LiteLLM source
or version. Dynamic header delivery was measured with a pre-inference rejection.
See [deployment evidence and rollback](../../docs/VERIFICATION.md#shared-gateway-routes-2026-10-06).
The configuration limitation below describes why YAML was chosen, not a current
access blocker. A separate approved 24-hour virtual key subsequently passed the
two allowed routes and rejected generic Responses/model-info access. Real
Claude Code and Codex tests pass their bounded profiles. The measured gateway
logs still record **zero tokens/spend and no provider cache usage for all 20
requests**, including a failed SSE stream recorded as success. This is missing
accounting, not free usage. See [live results and accounting limitations](../../docs/VERIFICATION.md#actual-shared-gateway-clients-2026-10-06).

The actual Codex profile completes a no-I/O tool round trip, manual local
compaction and two follow-ups in each of two five-request Haiku runs. The
cache-eligible run observes cache reads of 6,911 and 7,505 tokens; the short run
does not. These provider-accepted results are distinct from the corrected
synthetic runs, and do not qualify ordinary shell/apply-patch editing. Actual
file editing remains unverified after a failed Linux container-namespace
preflight; the separately approved new test-container preflight is pending.
See [Codex qualification scope](../../docs/CODEX-QUALIFICATION.md).

The deployed 1.103.1 UI disables its pass-through authentication toggle with a
Premium label. The pinned backend intentionally supports `auth: true` without
a license: registration attaches the real `user_api_key_auth` dependency even
with `premium_user=False`. Using this supported safe setting does not require
a license flag change. Do not create an unauthenticated route as a workaround.

The UI/admin CRUD endpoint and typed `/config/update` schema drop
`forward_headers`. Consequently the dynamic beta-header contract above requires
an owner-applied YAML configuration and reload. A static-header API-only route
is a narrower contract, not an equivalent substitute. If YAML owns
`pass_through_endpoints` (even an empty list), API writes to that field are
rejected. Built-in `/anthropic` uses process-global upstream environment
configuration, not a model's UI `api_base`; do not redirect it casually on a
shared gateway.

Custom routes require explicit virtual-key route permissions, including
`metadata.allowed_passthrough_routes`. That helper grants child paths too, and
an empty key list can inherit team grants; it is not an explicit deny. Custom
pass-through skips the usual model allowlist because its body model is not
resolved as a managed model. Route authentication alone is therefore not proof
of model isolation. Require a separately verified relay/model restriction before
relying on it for that policy.

Budget checks can reject an already exhausted cached spend value, but that does
not prove new stream usage is charged correctly. Custom-host streams use generic
accounting, and a default flat `cost_per_request: 0` can override derived cost.
The [official cost-header contract](https://docs.litellm.ai/docs/proxy/pass_through_cost_tracking)
supports upstream-reported cost/tokens, but final SSE usage is not known when
initial HTTP headers are sent. Do not fabricate a zero price or label an
unverified spend dashboard accurate.

Reproduce 25 stock policy/helper/schema observations without a database,
provider, remote host, or license override:

```sh
python integration/litellm/test_gateway_policy.py --output /new/temp/policy-evidence
```

This checks 13 policy-related source identities before/after, not the full
package. It is not DB-backed HTTP virtual-key authentication, persisted CRUD,
multi-worker synchronization, budget debit/concurrency, or UI-accounting proof.
The [actual Codex audit](../clients/README.md) separately detects reasoning loss
in the stock Responses conversion; pass-through Messages results cannot be used
as acceptance for that route.
