# Bounded live Codex smoke

`codex_live_smoke.py` runs an existing **Codex 0.160.0** app-server and real
`claude-haiku-4-5-20251001` through either the existing `.7` gateway or a temporary
stock LiteLLM diagnostic gateway. It does not install clients, edit normal client
configuration, deploy gateways/containers, read provider credentials, or change
existing gateway or relay settings.

`--model` selects a native Claude model ID; omitting it retains the original
Haiku4.5 model. For a prepared validation relay, the explicit endpoint option
also accepts `--gateway-base-url http://192.168.0.64:13459/v1 --model claude-haiku-5-5`.
Supply that relay's proxy key in the named `--gateway-key-env` variable. This
starts no local LiteLLM and the report records `mode: direct_relay`, direct-relay
attempts, and `actual_dot7_gateway_tested: false`. The same five-request and
phase bounds apply; this direct check does not qualify the gateway route.

## Existing .7 gateway

Use the already deployed authenticated route:

```text
Codex → local byte observer → .7:4000/claude-responses/v1/responses → configured .64 relay
```

```powershell
& 'C:/path/to/existing/python.exe' -B `
  integration/clients/codex_live_smoke.py --live `
  --codex 'C:/Users/binary/.local/bin/codex.exe' `
  --gateway-base-url 'http://192.168.0.7:4000/claude-responses/v1' `
  --gateway-key-env CODEX_LIVE_GATEWAY_KEY `
  --output 'C:/Users/binary/AppData/Local/Temp/codex-live-dot7-unique-run'
```

The caller supplies the existing **gateway client key** in that named process
environment variable. This mode starts **no local LiteLLM process**, creates no
gateway YAML, performs no gateway health probes, reads no relay key, and sends
no request directly to `.64`. The observer forwards received request bodies and
the `/claude-responses/v1/responses` path unchanged to `.7`. It observes only the
client-side request and gateway response, not gateway internals or the
gateway-to-relay request.

A Python installation with PyYAML suffices for shared helper imports. Gateway
mode neither imports the LiteLLM service nor requires a local LiteLLM package.
The existing `Rpc`, `clean_env`, `start`, `stop`, and `identities` helpers
remain unchanged; stock-only helpers are not invoked in this mode.
No Node runtime is required.

### Configured native Responses model

A separate model configured for supported native Responses forwarding can be
tested through the normal gateway endpoint:

```powershell
& 'C:/path/to/existing/python.exe' -B `
  integration/clients/codex_live_smoke.py --live `
  --codex 'C:/Users/binary/.codex/packages/standalone/releases/0.160.0-x86_64-pc-windows-msvc/bin/codex.exe' `
  --model claude-opus-5-5-responses-han `
  --gateway-base-url 'http://192.168.0.7:4000/v1' `
  --gateway-route-kind native-responses `
  --gateway-key-env CODEX_LIVE_GATEWAY_KEY --cache-fixture `
  --output 'C:/Users/binary/AppData/Local/Temp/codex-opus-native-responses-unique'
```

The gateway owner must prepare and verify the separate alias first. The route
kind is an operator declaration recorded as `gateway_route_kind_declared`;
the observer does not inspect provider configuration. `/v1/responses` by itself
does not establish whether LiteLLM uses native forwarding or Chat conversion.
`actual_dot7_gateway_tested` records observed contact with `.7`; the standard
and old pass-through endpoints have separate booleans. Only a declared
`chat-conversion` check sets `gateway_managed_conversion_tested`; otherwise it
is unknown. No gateway or client source patch is performed by this harness.

## Temporary local stock diagnosis

Omit `--gateway-base-url` to retain the original diagnostic chain:

```text
Codex → local observer → temporary stock LiteLLM → local observer → .64:13457/v1/responses
```

Run this mode with existing **stock LiteLLM 1.103.1** Python and an existing
**relay client key** in the selected environment variable, not a `.7` key:

```powershell
& 'C:/path/to/stock-litellm/Scripts/python.exe' -B `
  integration/clients/codex_live_smoke.py --live `
  --codex 'C:/Users/binary/.local/bin/codex.exe' `
  --relay-key-env CODEX_LIVE_RELAY_KEY `
  --output 'C:/Users/binary/AppData/Local/Temp/codex-live-local-unique-run'
```

Local mode is **not acceptance of actual .7 routing**. Its two observers compare
requests and SSE in memory. Stock LiteLLM may reserialize JSON and remove its
reserved `metadata`; byte equality, JSON equality apart from that field, and
exact input/history equality are separate diagnostics. The 13 existing guarded
stock-source identity checks are reused, not a whole-package audit. Local
gateway YAML references `os.environ/LOCAL_RELAY_AUTHORIZATION`, never a key.

## Sequence and coverage

`--live` is mandatory. Key options take environment variable **names**, never
credentials. Do not put keys in shell commands, arguments, files, or copied
terminal output. `--output` must be a new system-temporary directory outside
this repository. The safe report is `<output>/codex-live-smoke.json`.

Both modes perform one real no-I/O `get_goal` turn (two requests), actual
host-requested `thread/compact/start` local compaction (one request), and two
ordinary follow-ups (one each). Outbound attempts are counted before connect/write,
with a total cap of **five** and phase limits **2/1/1/1**. Gateway mode counts
attempts to `.7`; local mode counts attempts to `.64`. Uncertain outcomes
consume a slot. The observer never replays or follows redirects. Codex retries
are zero, as are local diagnostic LiteLLM retries. Existing `.7` retry settings
and gateway/provider-internal attempts are not observed.

A failed terminal status, HTTP response, requested tool result, or phase count
stops later phases. Exit 0 and `functional_pass: true` mean the bounded tool,
compaction and follow-up sequence passed. Byte equality and new reasoning on
every response are **not functional phase gates**. Text-only success continues.

The report records tool/result presence, markers, compaction lifecycle and
numeric usage/cache counters. When opaque reasoning is present, it compares
reasoning IDs and exact `encrypted_content` between item-done/completed, tool
replay, compaction input, and second-follow-up replay. Absent reasoning has
`null` equality, never a passing replay claim. `observed_reasoning_preserved`
and `post_compaction_reasoning_replay_observed` are separate from functional
success. Missing usage stays `null`; cache-control presence is not a cache hit.

`signed_reasoning_replay_qualified` additionally requires functional success,
all observed reasoning comparisons passing, and at least one successful actual
replay into a subsequent request. Equality between a compaction response's
done/final snapshots alone cannot qualify replay.

Replay checks compare **both** `response.output_item.done` and final
`response.completed` snapshots with the subsequent input actually sent by Codex.
Matching missing state is a failed replay observation, not successful signed
state preservation. ID equality and encrypted-state equality are also recorded
separately so an altered ID cannot be hidden by an equal payload. These checks
retain only booleans; IDs, encrypted state and bodies stay in memory. A successful
text/tool sequence with failed reasoning observations remains a functional
success with incomplete protocol fidelity.

In gateway mode, `remote_requests`, `remote_request_count`,
`remote_request_attempts`, cross-gateway body/SSE equality, local stock
identities and `no_hidden_retries` are **null/unobserved**.
`gateway_request_attempts` and `observed_no_retries` describe only this harness's
visible `.7` requests. `gateway_internals_observed` and
`relay_ingress_observed` remain false; `direct_relay_request_attempts` stays zero.
`actual_dot7_gateway_tested` becomes true only after an observed attempt to
`.7:4000`; endpoint-path and declared route-kind fields distinguish the routes.
It is not an acceptance or internal-configuration result by itself.

The temporary catalog is a **limited test profile, not official Claude
capability metadata**. Shell, apply_patch, search and agents are disabled.
Prompts request only built-in `get_goal`, then no further tools. The reused RPC
helper rejects unexpected app-server action requests. Every request includes:

```text
x-claude-proxy-native-options: {"cache_control":{"type":"ephemeral","ttl":"5m"}}
```

This preserves the relay's native thinking/output policy. The intended `.64`
deployment has thinking budget 1024 and output cap 8192; the harness neither
changes nor inspects those settings. See
[native caller options](../../docs/RESPONSES-ADAPTER.md#codex-configuration).

## Optional cache fixture

Add `--cache-fixture` to either mode to append 128 deterministic rows of inert
reference words to this harness's existing temporary catalog `base_instructions`.
This targets roughly 6,000 total input tokens for the ordinary turns, with enough
stable reference text to exceed Haiku 4.5's documented **4,096-token minimum**.
The actual tokenizer and request shape determine the count; the report's usage
fields remain the evidence. See [Anthropic's cache limitations](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#cache-limitations).

The default catalog stays unchanged when the flag is omitted. The optional
reference is supplied through normal temporary client configuration; neither
observer nor gateway rewrites requests. The five-call cap and phase sequence
remain unchanged. Tool-definition changes during compaction or other prefix
changes can still affect reuse; cache hits are measured, not required for the
functional smoke to pass.

The report records `cache_fixture_requested`, its UTF-8 byte/word counts and
reference-row count. `cache_write_observed` and `cache_hit_observed` independently
summarize positive native cache usage across observed responses. They are false
when reported counters are zero and null when no relevant counter was observed.
Neither changes `functional_pass`. Per-request `sse_failure_codes` contains
only known adapter error codes or the fixed `unrecognized_sse_failure` label;
free-form provider errors remain in memory.

## Optional reasoning fixture

Add `--reasoning-fixture` to replace only the two ordinary post-compaction
follow-up prompts. The first asks for the unique integer `N` in `[0,215441)`
whose remainders modulo `17,19,23,29` are `4,17,18,3`, and asks the model to
solve and verify all congruences before its final marker and decimal answer.
The next uses that answer to compute `(37*N + 11) mod 100000`. The expected
answers are `173829` and `31684`. The original response markers remain present.

This sends a genuine nontrivial task through Codex. It does not inject reasoning
items, edit histories or change effort, model metadata or native headers.
Thinking emission remains the model's decision. Per-phase
`reasoning_fixture_answer_correct` and the aggregate
`reasoning_fixture_answer_checks_passed` are separate observations; they do not
change the existing functional pass/exit criteria. Default prompts and the
five-request budget remain unchanged when this option is absent.

Managed LiteLLM Responses may expose only `input_tokens_details.cached_tokens`
and `cache_write_tokens`. Those counters are also observed, with native counters
taking precedence when both forms exist; aliases are never added twice.
The report records the actual gateway Responses path and distinguishes the
managed `/v1/responses` conversion from configured pass-through paths.
Reasoning-state presence is reported separately for `output_item.done` and the
final `response.completed` snapshot. The legacy `encrypted_content_present`
field refers to done items only; a false value does not establish absence from
the final snapshot. Identity/content comparison remains separate from functional
tool/compaction/continuation results.

## Retention and bounds

Observer bodies, SSE, signatures, opaque capsules, raw RPC events, exception
text, gateway logs and client stderr are **never written by the harness**.
Keys are supplied only by environment/HTTP headers. Reports contain fixed
labels, booleans, counts, statuses and numeric usage. There is no prompt or
model-output rewriting.

The fresh temporary home, `CODEX_HOME`, catalog and workspace remain under
`--output`, plus gateway YAML in local mode only. **Codex's own session history
may contain generated prompts, replies and opaque reasoning**; this natural
client retention is not an observer export. Keep that directory private if
retained. No ordinary client state is copied. Owned client/local-gateway
processes and listeners stop at the end; the existing `.7` service is not managed.

Bounds: 1 MiB/request, 4 MiB/captured response, 75-second HTTP/stream idle timeout,
100-second turn wait, and reused RPC limits of 5 MiB stdout or 1,500 events.
RPC acknowledgements have a 30-second timeout. This smoke does not establish
OS-enforced isolation, automatic compaction, remote `/responses/compact`, long
coding sessions, restart/resume, all tools, internal gateway behavior, billing
accuracy or subscription entitlement.
