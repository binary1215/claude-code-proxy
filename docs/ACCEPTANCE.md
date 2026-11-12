# Whole-outcome acceptance

The active user objective is usable **Claude Code and Codex through the separate,
unmodified LiteLLM gateway and Docker relay**, with OpenCode as an additional
comparison. Only free supported gateway features are in scope. The new Responses
adapter is an implementation milestone, not whole-outcome completion.

The user owns authentication, new paid usage, production rollout and material
support-scope decisions. The November12 user decision explicitly restores genuine
SDK/CLI inference as the default. Do not silently switch models/accounts/backends,
spoof an official client, remove rejected thinking, or modify LiteLLM source/license flags.

## Real Opus project work and automatic compaction — 2026-11-12

The requested bounded acceptance cases now pass. Genuine Codex completes two
automatic compactions and subsequent real file editing/tests through native
Responses in nine HTTP200 requests. Genuine Claude Code completes both project
repair and follow-up feature phases in seven HTTP200 requests. Both preserve
the supplied tests, pass independent oracles, and show real signed replay/cache
use. A separate Claude Code client test automatically compresses 24,472→1,656
tokens and retains selected tool/source/calculation state.

An isolated real backend test also passes automatic compaction 24,032→1,383
within one live session, with correct internal usage aggregation. These are
controlled lowered-threshold tests; default full-window longevity and arbitrary
project/client/model behavior remain unqualified.

The live project trial found `cli_capacity`503 from idle pending-tool workers
occupying all slots. The deployed `a6a70ae` fix permits LRU eviction of idle
workers and complete-history restoration, while protecting active requests.
Linux checks pass 276 unique tests. Earlier provider-independent fixture and
observation failures are preserved in the [full report](OPUS-PROJECT-AUTO-COMPACTION.md)
and [evidence](evidence/20261112-opus-project-long-session.json).

## Opus native Responses deployment — 2026-11-12

The standard `/v1/responses` endpoint now offers the separate
`claude-opus-5-5-responses-han` deployment, using `openai/claude-opus-5-5` and
Han's `/v1` API base. Existing 36 models, keys, gateway/client sources and the
Han image are unchanged; registration uses the supported dynamic model API
without a gateway restart.

Actual Codex passes five bounded calls covering a tool, local compaction and
two follow-ups. A deterministic arithmetic task causes real reasoning to be
emitted, then the next actual request replays its exact ID and encrypted state.
Both item-done and final snapshots agree, both arithmetic answers pass, and
post-compaction cache-read counts are 11283/12680. The previous simpler five-call
Opus test passed functionality and stream consistency but emitted reasoning only
during compaction, so its replay coverage is explicitly kept separate.

Actual Claude Code on the existing `claude-opus-5-5-han` Messages alias also
qualifies: six calls pass the client-owned MCP tool, arithmetic, manual
compaction 6088→947, retained tool/calculation results, warm/post-compaction
cache reads 5146/3139 and five exact signed-thinking replay observations. The
first native attempt returned no report; its nonsecret fixture was found not
readable by the container user, and stderr was not retained. That receipt is
preserved with unknown call count. Its corrected simple run passed functionality but did not observe
replay. Only the subsequent reasoning task establishes native signed replay.

The current route qualifies this signed-replay case; it does not fix the older
Anthropic-backed managed conversion or prove arbitrary coding workflows.
See [routing contract](LITELLM-NATIVE-RESPONSES.md) and
[full scoped results](evidence/20261112-native-responses-opus.json).

## Initial CLI-default rollout to Han — 2026-11-12

The initial rollout deployed `fc80fa3` with genuine CLI2.1.322/SDK0.3.322 inference.
All four current models return the expected reply, operating Haiku reuses its
session and reads5142 cached tokens, and existing keys/auth/data/state are kept.
The final Linux image passes274/274 isolated regressions.

Unmodified real Claude Code passes cache reuse, manual compaction5876→973,
target retention and post-compaction cache reuse. Real Codex passes tool
execution, local compaction and two follow-ups in five requests, preserving
opaque reasoning. Both client qualifications directly target the validation
proxy. At that stage automatic compaction passed with a scripted provider;
a real threshold crossing had not been tested. The later Opus qualification
above verifies real automatic compaction. Invoice/quality comparison remains untested.

Separately, the unchanged LiteLLM managed Messages path passes two real Haiku
turns with6311 upstream cache-read tokens. Its managed Responses path completes
a text request. Those three calls emitted no thinking, so they do not qualify
signed reasoning/compaction through the managed conversion. Existing transparent
gateway routes still target the separate test relay, not Han. See
[the receipt](evidence/20261112-cli-default-compaction.json) and
[CLI contract](CLI-INFERENCE.md).

## Actual managed LiteLLM client qualification — 2026-11-12

The default `master` now contains the CLI work. Actual Claude Code 2.1.322 through
managed Messages passes client-owned MCP execution, cache reuse, manual
compaction 6645→1010, retained tool output and five exact signed-thinking replay
observations. Actual Codex 0.160.0 through managed Responses passes get_goal,
local compaction and two follow-ups over five requests, with positive reported
cache reads. The gateway, installed clients and operating image are unchanged.

Codex reasoning-state fidelity remains unqualified: a compact reasoning
`output_item.done` has no encrypted state and differs from the final snapshot.
Installed LiteLLM constructs these separately; the old observer did not record
the final field independently. This is an observed event inconsistency and
source-supported explanation, not proof that all final reasoning is lost.
The observer now distinguishes both fields, and recognizes standard managed
Responses cache counters. These reporting changes add no model calls or gates.
See [the client receipt](evidence/20261112-master-litellm-clients.json).

## Current source integration — 2026-11-06

The coding-workflow/usage branch is integrated with the current `master`
authentication and automatic-refresh implementation. The combined backend
passes **189/189 tests in an isolated Linux Docker image**; Windows passes
188 with only the Linux helper test skipped. The admin typecheck, Next.js
production build and three actual dashboard-component SSR scenarios pass.
The dashboard checks cover complete usage, partial/unknown usage and an empty
period; they are not browser visual verification.

All **112 pure client tests** pass. A newly generated native-model profile and
the actual Codex 0.160.0 `model/list` check pass without inference or tool
execution. Actual Claude Code 2.1.289 completes the scripted-provider coding
loop over seven requests, repairing two files and passing the independent test;
all six reasoning/tool-result checks pass. Codex combined editing was not rerun
through the previously observed Windows policy denial and is not a functional
pass. See the [integration receipt](evidence/20261106-master-integration.json).

This is source integration and isolated testing, not a service rollout. The
existing Han CLI-auth container remains on its previously verified image.
Its real-account login/automatic refresh evidence is recorded separately in
[container authentication](CONTAINER-AUTH.md) and the
[refresh receipts](../integration/auth/README.md). The source tests use synthetic
credentials and providers, so they do not establish new model entitlement,
real-provider coding quality, long-session compaction or gateway billing.

## Earlier local improvement status — 2026-10-24

The current work adds cache-inclusive aggregation and reusable ordinary coding
profiles, plus real-client multi-tool regression harnesses. These changes have
**not** been redeployed, and this update made no real-provider requests.

| Area | Local result | Remaining boundary |
| --- | --- | --- |
| Claude Code coding loop | Stock 2.1.289: Read two files, real Bash test failure, two real Edit operations, test success and independent Node rerun; seven requests, six exact reasoning replays | Scripted provider, not model planning/quality or live-provider coding; client adds Edit default `replace_all:false` |
| Codex coding loop | Stock 0.160.0 with both shell and freeform patch: seven requests preserve opaque state, signed/empty/redacted thinking and tool identities; catalog accepted without metadata fallback | Actual Windows policy reports read-only and denies tools; transport pass is not functional coding success. No permission change or retry around that denial |
| Reusable profiles | Native ID, pinned stock prompt, shell+patch catalog; actual Codex model/list parsing; no effort-to-thinking guessing | Unknown context is null, not a fabricated limit; no automatic-compaction qualification. User-managed/project settings and permission controls still apply |
| Usage aggregation | Period/model fresh, cache-write, cache-read, output, cache-inclusive totals; complete/partial/unknown coverage; local dashboard build passes | API supports existing from/to filters; dashboard shows today UTC. No remote UI deployment or LiteLLM cost/budget repair |

Next functional work is the combined Codex workflow in an already authorized,
working writable client environment, followed by automatic compaction and resume
under the ordinary profile. Do not weaken host permissions or discard reasoning
to turn a failed qualification into a pass. Real-provider acceptance remains a
separate bounded test. See [workflow evidence](evidence/20261024-coding-workflows.json).

## Historical protocol deployment — 2026-10-23

Core `4969a63` is deployed to **test-claudemock only**, image
`sha256:6c26b0c39b672a0e56e502331a947d1a59f17f6e3f67b6d0b9356bf93dcd8104`.
The separate gateway and coding clients remain unmodified. The following is
bounded functional evidence, not a new approval checklist or whole-client claim.

| Area | Latest result | Remaining boundary |
| --- | --- | --- |
| Reasoning replay | Self-contained `ccpr2` restores authenticated ID and original blocks even when OpenCode omits external IDs; actual offline Read/follow-up passes | Old ID-less `ccpr1` cannot be recovered; whole omitted items cannot be reconstructed |
| Mandatory clients through `.7` | Real Haiku: Claude Code Read/resume 3 requests; Codex tool/local compaction/two follow-ups 5 requests pass; signed/opaque replay observed | Codex uses a limited test catalog; normal shell/repository coding and current-image file editing are not requalified |
| Cache | Claude reads 0/4626/4858; Codex reads 0/6941/0/0/7423. Relay rows match observed provider counters | Compaction changes the prefix and can miss cache; no invoice or quality experiment |
| OpenCode real-provider path | One first-request probe reaches upstream; HTTP400 classified `third_party_plan_usage_restriction` | Provider eligibility remains unresolved; no retry, impersonation or paid fallback |
| Gateway access/cancellation | Fresh 24h key permits only two dedicated routes; no-inference Responses validation reaches adapter. Stock local Messages/Responses cancellation passes | Local cancellation is not deployed-Linux generation/billing cancellation proof; key expires 2026-10-24 22:41:47.947 KST |
| Gateway accounting | Fresh owner audit matches all nine requests and 8 success/1 failure; gateway input/output/spend are all 0, cache counters null | These are not provider usage or free use; proxy counters do not repair gateway spend/budget enforcement |
| Regression/deployment | 167 local backend, 163 exact-image backend, 79 client pure and 18 deployment pure tests pass; 47 old rows/config/state key/volume preserved | Admin UI built locally only; old-image rollback cannot read new ccpr2 state; rollback not rerun this update |

The primary replay-compatibility defect is fixed. The complete goal is still
broader: OpenCode's current subscription path is refused, ordinary full coding
profiles need broader execution evidence, and the stock pass-through accounting
limitation is not repaired by proxy counters. These are explicit remaining
capability/account decisions, not reasons to add new hard gates or patch LiteLLM.
See [live and offline evidence](VERIFICATION.md) and
[ordinary connection profiles](../integration/clients/profiles/README.md).

## Historical qualification baseline — through 2026-10-07

Operator priority, 2026-10-06: focus on working client features and integration;
do not add vulnerability audits or additional hard gates. The table tracks what
works and what remains unmeasured, not a new approval workflow. Existing service
preservation and explicit account/cost choices remain in scope. Gateway access
and the bounded real-client runs at that date were complete. The table below is
retained as historical evidence; the 2026-10-23 status above supersedes its
deployment, missing-ID defect and source-not-yet-deployed statements.

| Area | Evidence to collect | Current boundary |
| --- | --- | --- |
| Reproducible implementation | Exact Git/image revision, native and Responses regression tests | Deployed image remains `f5031f3`; current source adds SDK-compatible signature replacement and passes 153 backend + 63 pure observer tests. Corrected actual-Codex synthetic adapter/compaction reruns also pass; source correction not yet deployed |
| Actual clients | Claude Code and Codex on selected gateway routes, streaming, tool execution/result, further turns | Actual `.7` + real Haiku: Claude Code Read/resume (3 requests), Codex get_goal/compaction/two follow-ups (5 requests), and Linux Codex fixture create/update (4 requests) pass. Broader shell and repository coding are not covered |
| Reasoning continuity | Ordered thinking/signatures, signed-empty/redacted and tool IDs survive replay; corruption fails explicitly | Actual signed-state replay passes both mandatory clients; Codex opaque state survives tool and compaction input. Native Claude client omits tool caller metadata, but IDs/name/input/text/order match. Historical split-part concat oracle corrected to SDK replacement, not a client defect; live signed-empty/redacted not emitted |
| Cache accounting | Eligible prefix, provider cache read/write/fresh/output counts and matching relay history | Actual Claude Code reads 0/4628/4865. Actual Codex eligible-prefix sequence reads 0/6911/0/0/7505, writes 6911/163/5421/7505/58. Relay DB equals client-observed provider counts; these are not invoice savings |
| Gateway authorization | Missing/expired/revoked keys, allowed/denied routes, relay model ACL, secret separation | Separate 24h test key: two routes work, generic Responses/model-info denied 403, missing key 401. Custom pass-through bypasses normal gateway model resolution; current relay key also has no model allowlist (NULL). Haiku scope was harness-enforced. Real expiry/revocation and in-flight cancellation remain untested |
| Gateway accounting | Completion/failure/cancellation usage and persisted spend versus source counts | Actual gateway records zero input/output/spend and no cache usage. Its HTTP200 success includes a failed SSE response. These are verified limitations, not free usage or billing truth |
| Coding-session envelope | Actual tool schema, metadata, context limit, follow-ups and compaction | Manual compaction + two follow-ups pass with hoist. After approved test-only namespace support, Linux Codex actually creates/updates one fixture via validated apply_patch through .7 and real Haiku. Workspace-write remains enforced; temporary test profile unloaded. Windows original denial and remote-compaction limitation remain |
| Deployment and rollback | Backups, preserved state key, exact target, healthy rollback | `f5031f3` image-only update preserves config/state key/volume and all29 pre-update history rows. Prior native rollback/re-upgrade succeeded. New rollback config pins the previously working f27c51e image; not rerun during this update. Real backup restore into a fresh volume remains untested |
| Additional client | OpenCode comparison on native and Responses routes with Haiku | One actual request on each route received the provider's 400 third-party plan/extra-usage restriction; Responses alone did not resolve it, and the exact classification trigger remains unknown. Separately, offline Responses Read succeeds but replay omits reasoning IDs while preserving ciphertexts; the proxy rejects that second request with `invalid_reasoning_state`. No retry, impersonation or paid fallback. See the 2026-10-07 evidence |

For Codex, the [official gateway contract](https://learn.chatgpt.com/docs/enterprise/gateway-compatibility)
requires actual streaming, continuation, tool, routing and authentication evidence.
Stateless HTTP can replay input without saved-response persistence; that does not
make unsupported long-session features work. Follow the
[official rollout test procedure](https://learn.chatgpt.com/docs/enterprise/roll-out-a-gateway)
using an isolated client and a narrowly scoped gateway credential.

## Execution order

1. Qualify the committed proxy image and complete synthetic actual-client chain
   tests without real provider credentials. Retain both positive adapter results
   and the negative normal-LiteLLM Responses baseline.
2. Prepare a reversible update of **test-claudemock only**, preserving its existing
   database/authentication and provisioning a separate durable state key. Do not
   replace an unrelated production container or delete a volume.
3. Obtain owner-authorized access to the shared gateway's YAML/reload workflow.
   Add separate authenticated Messages and Responses namespaces, without
   shadowing existing routes or changing process-global provider routing.
4. Qualify virtual-key route restrictions and relay model restrictions. A shared
   LiteLLM-to-relay key is one relay identity; require separate keys/routes if
   per-user encrypted-state isolation is intended.
5. With an explicitly permitted credential/model, run bounded real client/tool
   and cache checks. Record selected model, each request count, terminal status,
   actual cache counters, errors and any client feature limitations. A provider
   rejection stops that path; it does not authorize spoofing or paid-key fallback.
6. Compare gateway persisted usage/spend with provider/relay facts and test
   cancellation and revocation. If free gateway functionality cannot satisfy a
   financial-control requirement, present that conflict for a user decision.
7. Deliver verified client profiles, operating limits, rollback instructions and
   evidence. Mark the whole objective complete only when its functional requirements are
   met, or after the user explicitly changes those requirements.

## Access and decision dependencies

- Operator direction, 2026-10-05: gateway configuration access/preparation is
  delegated to the existing `LiteLLM 관리` task. That handoff is not evidence of
  an applied route or successful end-to-end acceptance; verify its result before
  coordinating any reload with the prepared relay.
- Do not modify Codex itself to make this gateway path work. After initially
  rejecting developer relocation, the operator authorized a bounded proxy-only
  top-level-system hoisting experiment on 2026-10-05. The code default remains
  rejection; on 2026-10-06 the test-only deployment explicitly enabled Responses
  and hoisting after successful direct-provider testing. Other services remain
  unchanged. This does not reduce mandatory acceptance:
  actual provider replay, cache behavior and instruction-change semantics
  remain separate measurements. The bounded direct-provider sequence now passes;
  actual client/gateway integration now passes the bounded live profiles.
  Separately, the operator explicitly approved proxy-only validated apply-patch
  activation and isolated Linux fixture editing; the test service now enables it.
- The shared gateway UI does not preserve `forward_headers` through the audited
  typed admin schema. On 2026-10-06 the operator approved YAML application and
  restart, and the gateway owner deployed both routes without a source/version
  change. Dynamic headers and actual client/provider calls are measured;
  virtual-key accounting limitations are now confirmed. See the live evidence.
- Existing subscription-token acceptance by official Claude Code is not proof
  that Codex or another arbitrary client is authorized or accepted. This feature
  does not confer provider entitlement or approve separate API charges.
- Validated apply-patch mode requires acceptance of post-generation checking,
  not provider constrained sampling. It is off by default. Actual local editing
  also needs a user-approved write-capable client sandbox; a test denial does not
  authorize disabling safeguards or changing OS users/firewall/ACLs.
- Cache hits and correct signed-state replay are measurable. An exact cost
  reduction or answer-quality improvement needs its own controlled measurement;
  neither follows from successful protocol tests alone.

See [implementation/configuration](RESPONSES-ADAPTER.md),
[verification facts](VERIFICATION.md), [client evidence](../integration/clients/README.md)
and [stock gateway policy constraints](../integration/litellm/README.md).
