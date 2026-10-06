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
preservation and explicit account/cost choices remain in scope; independent
functional work can continue while gateway access is pending.

| Area | Evidence to collect | Current boundary |
| --- | --- | --- |
| Reproducible implementation | Exact Git/image revision, native and Responses regression tests | Corrected `f27c51e` Docker image passes 149/149 regressions and the three-call real Haiku Responses sequence; not deployed over the existing service |
| Actual clients | Claude Code and Codex on each selected gateway route, streaming, tool execution/result, further user turns | Codex synthetic chain passes; Claude Code single-signature-event state subset passes, but split-event client loss and gateway metadata removal remain; no deployed `.7` client acceptance |
| Reasoning continuity | Ordered thinking/signatures, signed-empty/redacted blocks and tool IDs survive replay; corruption fails explicitly | Synthetic edge cases pass. Real Haiku returns signed reasoning + one tool call; hoisted and identical Responses replays succeed. This is provider acceptance, not local signature verification or actual client compaction |
| Cache accounting | Repeated eligible native prefix, provider cache read/write/fresh/output counts and matching relay history | Direct Haiku Responses reads 0 → 5503 → 5651, writes 5503 → 148 → 0, fresh input 10 → 5 → 5. Native/Responses/history counts match; deployed gateway accounting is still unmeasured |
| Gateway authorization | Missing/expired/revoked keys, allowed/denied routes, relay model ACL, caller/provider secret separation | Stock source/helper audit exists; actual gateway DB-backed virtual-key acceptance remains |
| Gateway accounting | Stream completion/failure/cancellation usage and persisted spend compared with known source counters | Generic pass-through accounting is not verified; unknown cost must not be presented as zero or a saving |
| Coding-session envelope | Actual tool schema, model metadata, context limit, follow-up behavior and compaction choice | Optional validated apply-patch transport passes synthetic replay; actual Windows CLI denied the file edit. Codex compaction + two follow-ups pass with opt-in hoist through stock LiteLLM/fake provider at `1d9bbf7`; default reject still fails on the late developer. Direct real-provider developer-position replay now passes; changed system with retained capsules fails 409 locally. Real-client/provider long sessions and deployment mode choice remain; remote compaction unsupported |
| Deployment and rollback | Backed-up config/database, preserved state key, exact target, no unrelated service change, healthy rollback target | Isolated Docker 8/8 lifecycle phases pass for exact native `0ca7575`/candidate `98d26fe` images, including fresh-volume synthetic DB restoration and original-state replay with separately retained key/client history. Real deployment backup/cutover not qualified; existing test container remains `0ca7575` |
| Additional client | OpenCode with the same explicitly selected native model through gateway/relay | Pinned actual-client stock-gateway/native-relay fake-provider chain passes single-signature nonempty/empty/redacted/tool controls; multiple-signature-event stress loses fragments in the client. Real `.7`/provider/cache acceptance remains; not a replacement for mandatory clients |

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
  top-level-system hoisting experiment on 2026-10-05. Default rejection and the
  running deployment stay unchanged. This does not reduce mandatory acceptance:
  actual provider replay, cache behavior and instruction-change semantics
  remain separate measurements. The bounded direct-provider sequence now passes;
  actual client/gateway integration is still to be tested. Proxy-only validated apply-patch activation is a separate
  choice, not implied by this experiment or by leaving Codex unchanged.
- The shared gateway UI does not preserve `forward_headers` through the audited
  typed admin schema. Dynamic header forwarding needs the gateway owner's YAML
  and reload access; UI admin access alone is not equivalent.
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
