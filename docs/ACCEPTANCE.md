# Whole-outcome acceptance

The active user objective is usable **Claude Code and Codex through the separate,
unmodified LiteLLM gateway and Docker relay**, with OpenCode as an additional
comparison. Only free supported gateway features are in scope. The new Responses
adapter is an implementation milestone, not whole-outcome completion.

The user owns authentication, new paid usage, production rollout and material
support-scope decisions. Do not silently replace the agreed model/account, restore
the SDK/CLI proxy backend, spoof an official client, remove rejected thinking,
or modify LiteLLM source/license flags.

## Functional verification status

Operator priority, 2026-10-06: focus on working client features and integration;
do not add vulnerability audits or additional hard gates. The table tracks what
works and what remains unmeasured, not a new approval workflow. Existing service
preservation and explicit account/cost choices remain in scope. Gateway access
and the bounded real-client runs are now complete; remaining feature scope is
listed separately below.

| Area | Evidence to collect | Current boundary |
| --- | --- | --- |
| Reproducible implementation | Exact Git/image revision, native and Responses regression tests | `f5031f3` fixes empty tool input deltas; 152/152 local backend regressions. Exact image deployed to test-claudemock, not production |
| Actual clients | Claude Code and Codex on selected gateway routes, streaming, tool execution/result, further turns | Actual `.7` + real Haiku: Claude Code Read/resume (3 requests) and Codex get_goal/compaction/two follow-ups (5 requests) pass. Ordinary unrestricted coding profile is not covered |
| Reasoning continuity | Ordered thinking/signatures, signed-empty/redacted and tool IDs survive replay; corruption fails explicitly | Actual signed-state replay passes both mandatory clients; Codex opaque state survives tool and compaction input. Native Claude client omits tool caller metadata, but IDs/name/input/text/order match. Synthetic native split-signature loss remains; live signed-empty/redacted not emitted |
| Cache accounting | Eligible prefix, provider cache read/write/fresh/output counts and matching relay history | Actual Claude Code reads 0/4628/4865. Actual Codex eligible-prefix sequence reads 0/6911/0/0/7505, writes 6911/163/5421/7505/58. Relay DB equals client-observed provider counts; these are not invoice savings |
| Gateway authorization | Missing/expired/revoked keys, allowed/denied routes, relay model ACL, secret separation | Separate 24h test key: two routes work, generic Responses/model-info denied 403, missing key 401. Custom pass-through bypasses normal gateway model resolution; current relay key also has no model allowlist (NULL). Haiku scope was harness-enforced. Real expiry/revocation and in-flight cancellation remain untested |
| Gateway accounting | Completion/failure/cancellation usage and persisted spend versus source counts | Actual gateway records zero input/output/spend and no cache usage. Its HTTP200 success includes a failed SSE response. These are verified limitations, not free usage or billing truth |
| Coding-session envelope | Actual tool schema, metadata, context limit, follow-ups and compaction | Codex actual manual compaction + two follow-ups pass with hoist. apply_patch remains disabled on the deployed service; actual file editing and broader shell/tool profile remain. Prior synthetic patch transport passed but Windows denied editing. Remote compaction unsupported |
| Deployment and rollback | Backups, preserved state key, exact target, healthy rollback | `f5031f3` image-only update preserves config/state key/volume and all29 pre-update history rows. Prior native rollback/re-upgrade succeeded. New rollback config pins the previously working f27c51e image; not rerun during this update. Real backup restore into a fresh volume remains untested |
| Additional client | OpenCode comparison on the same native route/model | Actual single request reached provider; 400 third-party plan/extra-usage restriction. No retry, impersonation or paid fallback. Prior synthetic single-signature controls pass, split-signature loss remains |

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
  actual client/gateway integration now passes the bounded live profiles. Proxy-only validated apply-patch activation is a separate
  choice, not implied by this experiment or by leaving Codex unchanged.
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
