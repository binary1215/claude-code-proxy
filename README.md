# Claude Code Proxy — CLI inference and Messages / Responses facade

A Claude CLI inference proxy, forked from [MehdiMohseni82/claude-code-proxy](https://github.com/MehdiMohseni82/claude-code-proxy). **The default backend uses the genuine Agent SDK/Claude CLI.** The standard image includes SDK0.3.322 and CLI2.1.322. A literal native HTTP relay remains an explicit backend/build target.

```text
Claude Code / Messages -> unchanged LiteLLM -> /v1/messages
Codex / Responses     -> unchanged LiteLLM -> enabled /v1/responses
  -> genuine CLI / caller-tool broker -> private HTTP forwarder -> provider
```

The HTTP backend has no automatic SDK fallback, local tool execution, invented thinking, conversation storage or provider/account failover. The caller owns HTTP conversation history and executes its client tools. Upstream-native server-tool definitions are forwarded on the HTTP route; they are not executed on the proxy host. The [Responses adapter](docs/RESPONSES-ADAPTER.md) is disabled by default and supports a bounded client-tool subset. CLI mode uses the context and control adaptations described below rather than literal native-byte forwarding.

## Default CLI inference and context management

`CLAUDE_INFERENCE_BACKEND=cli` is the default. It
runs an isolated official CLI session, appends caller instructions through its
supported system-prompt option, and brokers caller tools through owned MCP tools.
Tool execution stays in the calling client. The CLI uses a private loopback HTTP
forwarder, so provider authentication and refresh remain in the existing HTTP
layer. There is no automatic switch between backends after a rejection.

Live sessions reuse matching history. Compacted, changed or restarted caller
history can be imported with native roles, thinking signatures and completed tool
results through a version-pinned CLI resume adapter. CLI automatic compaction is
enabled; client-local compaction can remove tools during its summary request.
Actual internal compaction usage is counted separately from wire context usage.
Imported transcripts are temporary, with a default runtime under `/tmp`.
See the [CLI backend contract and limits](docs/CLI-INFERENCE.md),
[optional Compose file](compose.cli.yml) and [private-env template](.env.cli.example).

The earlier optional-stage Linux image passed **248/248** tests. Three real Haiku5.5
requests passed: tool intent, caller-result continuation and Responses SSE;
the continuation reported **2772 cache-read tokens**. Those historical results
precede the default/compaction work. [Historical receipt](docs/evidence/20261112-cli-inference.json).

## Actual Opus project editing and automatic compaction — 2026-11-12

Both required clients now pass real project work through the existing LiteLLM
gateway using **Opus 5.5**. Each repairs two source files, runs the failing and
passing tests, implements a same-conversation follow-up, and passes independent
tests without changing the supplied acceptance tests.

| Boundary | Observed result |
| --- | --- |
| Codex 0.160.0 / Responses | Nine HTTP200 requests; two genuine automatic compactions, subsequent file edits/tests, exact signed-state replay and cache reads |
| Claude Code 2.1.322 / Messages | Seven HTTP200 project requests; both editing phases pass, 16 exact signed-thinking replays and cache reads. A separate six-request automatic test compresses 24,472→1,656 tokens and retains selected state |
| Proxy CLI backend | Six real provider calls in one session; automatic compaction 24,032→1,383, retained state and correct separate wire/internal usage accounting |

The live tests exposed an idle-session `cli_capacity`503 defect. Han now runs
the fix from `a6a70ae`: idle workers awaiting client-owned tools can be evicted
and later restored from complete history; active requests remain protected.
Linux verification passes **276 tests**. Existing keys, auth/data volumes and
automatic refresh are preserved; LiteLLM and client sources are unchanged.

Automatic tests use explicitly lowered, isolated thresholds. Default full-window
longevity, arbitrary coding quality and invoice accuracy remain unverified.
See the [complete results and earlier failed attempts](docs/OPUS-PROJECT-AUTO-COMPACTION.md)
and [machine-readable evidence](docs/evidence/20261112-opus-project-long-session.json).

## Verified CLI default — 2026-11-12

The initial Han CLI-default rollout used source `fc80fa3`, official
CLI2.1.322 and SDK0.3.322. Opus5.5, Sonnet5.5, Fable5.2 and Haiku5.5 all returned
the expected reply with HTTP200. A second operating Haiku request reused its
CLI session and reported **5142 cache-read tokens**. Existing proxy keys, auth
and data volumes, automatic refresh and the Responses state key were retained.

The final Linux image passes **274/274** offline regressions. With a real account,
unmodified Claude Code passed cached continuation, manual compaction
**5876 -> 973 tokens**, retained-target recall and cached post-compaction turns.
Unmodified Codex passed its tool round trip, local compaction and two follow-ups
over five Responses requests, including exact reasoning replay. These client
tests directly reached the validation proxy; they are not full client tests
through LiteLLM. Genuine SDK automatic compaction and multi-call usage accounting
pass against a scripted provider; that initial release did not induce a
real-account automatic threshold crossing. The later Opus checks above do.
See the [release evidence](docs/evidence/20261112-cli-default-compaction.json)
and [context contract](docs/CLI-INFERENCE.md).

Separately, existing LiteLLM managed Messages passed two real Haiku turns with
**6311 upstream cache-read tokens**; its managed Responses path completed a text
request. No gateway configuration/client source changed. Those initial three
calls did not emit thinking or exercise compaction. Subsequent actual-client
qualification is recorded below.

## Opus native Responses through LiteLLM — 2026-11-12

The new **`claude-opus-5-5-responses-han`** deployment routes the standard
gateway `/v1/responses` to Han's Responses adapter. Existing 36 model entries
were preserved; no gateway restart, source patch, new key or proxy image change
was needed. Native Claude Code keeps **`claude-opus-5-5-han`** on `/v1/messages`.

Real Codex 0.160.0 passes tool execution, local compaction and two follow-ups
using Opus 5.5. A nontrivial arithmetic task emits signed reasoning; its item
IDs and encrypted state match between item-done, final output and the actual
next client request. Both arithmetic answers pass. Post-compaction cache reads
are **11283/12680 tokens**. This closes the previously observed streaming and
signed-replay gap for this deployment; the older Anthropic-backed conversion
route retains its limitation.

Real Claude Code 2.1.322 also qualifies on the existing Opus Messages alias:
six calls pass a client-owned tool, arithmetic/result retention, manual
compaction **6088→947 tokens**, cache reuse and **five exact signed-thinking
replay observations**. Warm/post-compaction cache reads are 5146/3139 tokens.
The native replay observer follows the pinned SDK's signature replacement rule.

See [configuration and limitations](docs/LITELLM-NATIVE-RESPONSES.md) and
[the Opus qualification receipt](docs/evidence/20261112-native-responses-opus.json).
The observation covers client-to-gateway traffic. These bounded no-I/O tools and
manual/local compaction checks do not qualify full repository editing, real
automatic-threshold compaction, every client/model or invoice accuracy.

## Earlier managed-conversion client baseline — 2026-11-12

The CLI-default branch is merged into `master`. Real Claude Code 2.1.322 and
Codex 0.160.0 also pass their bounded workflows through the existing
LiteLLM 1.109.0 managed Han routes, using `claude-haiku-5-5-han`.

- **Claude Code / Messages:** a client-owned MCP tool executes once; manual
  compaction reduces 6645→1010 tokens; its tool result survives; warm/post-compact
  cache reads are 5741/3766. Five signed-thinking replay observations match
  actual earlier returned blocks without content/signature mismatches.
- **Codex / Responses:** five requests pass get_goal, local compaction and two
  follow-ups. Reported cached tokens are 0/12705/0/2321/12341.
- **Remaining Responses fidelity gap:** the compact stream's reasoning
  `output_item.done` lacks `encrypted_content` and differs from the completed
  snapshot. Installed LiteLLM builds done items without that field and assembles
  final reasoning separately. The original observer did not retain the final
  field separately, so absence from the whole response is unproven. Codex signed
  reasoning replay through managed conversion is **not qualified**.

The gateway and installed clients were unchanged. Observations cover the
client-facing gateway wire; the gateway-to-Han raw wire was not captured.
These are no-I/O tool and manual-compaction tests, not repository editing or
automatic-threshold qualification. See [the client receipt](docs/evidence/20261112-master-litellm-clients.json).

## Earlier HTTP thinking progress-update compatibility — 2026-11-12

Explicit `thinking.display: "updates"` now supplies its required public
`thinking-display-updates-2026-08-18` beta automatically on native Messages.
The Responses adapter accepts the same option under `anthropic.thinking` or
`x-claude-proxy-native-options` for known adaptive model policies. Existing beta
flags are retained; native system/history bytes and signed-state replay remain
unchanged. See [usage and limits](docs/MODEL-COMPATIBILITY.md#progress-update-display).

This fixes the missing-feature-beta400 and the adapter's previous local rejection
of updates. A real official CLI request with only the updates feature beta
removed returned400 through the existing proxy and200 with the expected reply
through a temporary patched candidate. The separately reproduced
**system-content-dependent upstream429**
remains relevant to explicit HTTP mode. Historical tests passed **209/209 on Linux** and **208 plus one Linux-only
skip on Windows**, before the CLI-default rollout. See the
[verification receipt](docs/evidence/20261112-thinking-updates-beta.json).

## Current model compatibility — 2026-11-11

The dynamic upstream catalogue includes **Fable 5.2, Haiku 5.5, Sonnet 5.5 and
Opus 5.5**. The HTTP backend preserves native IDs/options; CLI mode supports the
bounded SDK control subset in its contract. The Responses
adapter now selects adaptive thinking for verified modern models instead of
injecting a legacy token budget, accepts their 128,000-token output limit, and
maps supported effort labels directly to native effort. Thinking-off and forced
tool choices follow each model's actual contract.

See [model defaults, examples and migration limits](docs/MODEL-COMPATIBILITY.md).
The registry describes request compatibility; account access still comes from
the upstream catalogue and provider. Existing legacy/unknown model behavior and
the authentication-only CLI remain available. Optional client manifests include
[Fable 5.2](integration/clients/profiles/metadata.fable-5-2.example.json) and
[Haiku 5.5](integration/clients/profiles/metadata.haiku-5-5.example.json).

The CLI-auth Linux image passes **205/205** backend tests and is deployed to Han
with its existing login/state preserved. LiteLLM has the two new `-han` aliases.
The first direct HTTP checks returned upstream **HTTP429** without a specific
cause. Subsequent **2026-11-12 real Claude Code 2.1.322 tests through LiteLLM's
managed `/v1/messages` succeeded on all four latest `-han` models**. Fable 5.2
also passed resumed follow-up and exact client-side signed-thinking replay;
the latter follow-up reported 3326 cache-read tokens. Generic HTTP still returned
429, so arbitrary-client/Responses acceptance is not established by these runs.
See [rollout evidence](docs/evidence/20261111-current-models.json) and
[actual-client evidence](docs/evidence/20261112-han-managed-client-tests.json).

## Earlier integrated improvements — 2026-11-06

- Usage statistics now aggregate fresh input, cache writes, cache reads and
  output by period/model. Complete totals, known subtotals and missing usage
  remain distinct; the dashboard shows cache-inclusive totals and coverage.
  This does not repair LiteLLM spend/budget accounting or estimate an invoice.
- An [opt-in profile generator](integration/clients/profiles/README.md#generate-an-isolated-ordinary-coding-profile)
  supplies a native-model catalog and isolated launch configuration without
  modifying either client. Unknown context limits remain explicitly unverified.
- Actual Claude Code completes a seven-request **Read → failing shell test →
  edit two files → passing test** loop against a local scripted provider, with
  exact thinking/signature replay. The earlier Codex shell+patch+follow-up chain
  preserved state over seven requests, but actual execution was denied by this Windows
  client's read-only policy: it is **not** a successful coding-task result.

These source and test features are integrated with container authentication and
automatic refresh. The workflow evidence below uses a scripted provider;
automatic compaction and ordinary live-provider coding remain open. The combined
source passes **189/189 Linux backend tests** and **112/112 pure client tests**;
the admin typecheck, production build and three dashboard SSR scenarios pass.
Actual Codex catalog parsing and the Claude coding loop were rerun successfully;
Codex shell/edit execution remains unqualified in this Windows environment.
See [acceptance and remaining work](docs/ACCEPTANCE.md) and
[integration evidence](docs/evidence/20261106-master-integration.json).

## Latest verified authentication update — 2026-11-05

Container login and automatic refresh are implemented and deployed on the
isolated Han service, using unmodified official Claude Code **2.1.318** for
authentication and the native relay for model traffic.

- Optional `CLAUDE_AUTH_EMAIL` prefills the official browser login. The user
  returns the final OAuth callback code to the same running CLI terminal.
- Opt-in `CLAUDE_AUTH_AUTO_REFRESH=true` checks at startup and every minute,
  invoking the official CLI within three minutes of token expiry. Login,
  logout and refresh share a cross-process lock. Temporary failures use bounded
  retry delays; a revoked login requires authentication again.
- A verified same-account refresh preserves the persistent login-session
  binding used by Responses reasoning capsules. New requests wait for an
  ongoing refresh to finish before selecting their credential.
- **181 Linux backend tests passed**, together with five official-CLI fixture
  cases and five coordinator cases. A real account's background timer rotated
  both tokens and advanced expiry without a manual refresh command or model
  prompt. A pre-refresh **synthetic** thinking capsule restored unchanged.

These authentication checks establish refresh and local state continuity;
model acceptance and real provider-signed thinking were outside this rollout.
See the [login and refresh guide](docs/CONTAINER-AUTH.md) and
[verification receipts](integration/auth/README.md#linux-deployment-and-live-timer-verification).

## Earlier protocol and client verification — 2026-10-23

The test backend was updated to core commit `4969a63` with self-contained **`ccpr2`**
reasoning state. OpenCode may omit public reasoning IDs without losing the
authenticated native thinking/signature blocks. Existing `ccpr1` history remains
readable with its original IDs. See [migration/rollback limits](docs/RESPONSES-ADAPTER.md).

- Actual OpenCode Read + same-session follow-up passes against the local fake
  provider. Its one new real `.7` request still receives Anthropic's third-party
  plan-usage **400**; that is not fixed by the replay-format improvement.
- Actual Claude Code through `.7`: Read, resumed conversation and signed-state
  replay pass (3 Haiku requests); cache reads **4,626 / 4,858** tokens observed.
- Actual Codex through `.7`: tool, local compaction and two subsequent turns pass
  (5 Haiku requests); cache reads **6,941 / 7,423** tokens observed. This uses a
  limited test catalog, not certification of all ordinary coding tools.
- Stock LiteLLM cancellation passes on both local protocol chains. Error-hop and
  cache/usage diagnostics distinguish unreported values from zero or free usage.

In that protocol rollout, only `test-claudemock` was replaced; LiteLLM and client sources were not changed.
The dashboard source was built locally, **not deployed** with the backend-only
image. Use the [client connection profiles](integration/clients/profiles/README.md)
and [no-inference connection diagnostic](integration/clients/check_gateway_connection.py).
See [current acceptance](docs/ACCEPTANCE.md) and [measured evidence](docs/VERIFICATION.md).
Cache hits establish observed reuse, not invoice savings or measured quality.
The fresh gateway audit still records zero tokens/spend and no cache counters
on these pass-through routes; use the proxy/provider observations, not those
zeros, when assessing consumption.

## Native Messages preservation contract

- JSON request bytes and upstream response/SSE bytes are forwarded unchanged, including unknown fields, thinking/signatures, redacted thinking, tool results, `is_error`, cache markers and TTLs. The proxy does not rename models or inject a system prompt.
- `anthropic-*`, content type, accept, caller user-agent, request IDs and idempotency headers are forwarded, except hop-by-hop headers. Proxy caller credentials are **replaced**, not passed upstream. The default Anthropic API version is added if absent. OAuth mode adds the OAuth beta flag. Explicit thinking display `updates` adds its public feature beta in either authentication mode; no Claude Code identity or system-prompt emulation is added.
- No redirect following, retry, signature repair, or removal of thinking on errors. HTTP errors and SSE error events remain upstream errors.
- Backpressure and cancellation propagate to the upstream HTTP request. Administrative cancellation is supported. A configurable total request deadline prevents orphaned connections.
- Bounded observers read usage and safe diagnostics separately from transport. Cache read/write and 5-minute/1-hour creation counts remain distinct. Missing or incomplete usage and unknown billed USD are **not zero**. Encoded responses remain byte-identical; usage is unknown if the observer cannot decode them. Large observation buffers are abandoned without stopping delivery.
- History records upstream status, allowlisted error types/codes, request ID, Retry-After, quota headers and authentication kind. It never stores raw provider error messages, tokens or conversation bodies in new records. A bare 429 is `unknown_429`, not proof of quota exhaustion. Timeout, cancellation and incomplete streams remain distinct.
- The relay cannot force an upstream prompt-cache hit or a coding client to replay opaque reasoning blocks. Native preservation removes relay-side loss; it does not prove billing savings or answer-quality improvements.

JSON requests are limited to 10 MiB. Compressed request bodies are rejected, not silently decoded/re-encoded. Headers/framing are not promised byte-identical: hop-by-hop headers and content length are managed by HTTP transport; response payload bytes are preserved.

The optional Responses endpoint translates protocols; it does **not** claim byte preservation. It preserves the exact original thinking/signature/redacted blocks inside authenticated encrypted reasoning items, restores them on replay, and preserves tool/text order. Capsules are supplied both when each item completes and in the full completed response. Changed, expired or foreign capsules fail explicitly rather than losing thinking silently. See the [supported subset, security model and configuration](docs/RESPONSES-ADAPTER.md).

## Authentication and subscription limitation

The upstream credential is selected once per request. The default
`UPSTREAM_AUTH_SOURCE=configured` uses this order:

1. Admin database credential (`claude_oauth_token`, retained storage key).
2. `CLAUDE_CODE_OAUTH_TOKEN` environment variable.
3. `ANTHROPIC_API_KEY` environment variable.

Database credentials starting with `sk-ant-oat` and the OAuth environment variable use `Authorization: Bearer`. API keys use `x-api-key`. There is no fallback to another credential after failure. A database override must be explicitly removed before an environment credential takes effect.

The standard CLI image includes official Claude Code login inside
the container; the explicit **`cli-auth` image target** offers authentication
with HTTP inference. Both use a separate persistent auth volume and a live
credential-file adapter. `UPSTREAM_AUTH_SOURCE=claude_cli` reads only that CLI store, with no
database or environment credential fallback. The [container login workflow](#container-login-and-automatic-refresh)
below covers setup and opt-in refresh. A configured setup-token or API key uses
the precedence above; automatic CLI refresh applies only to CLI-auth mode.

`claude setup-token` output can still be provided through a private container environment file in configured mode. **Accepting credentials does not establish that Anthropic will accept them for every model/client on this native HTTP path.** Earlier isolated tests observed differences between minimal requests and official Claude Code requests; see [verification and limitations](docs/VERIFICATION.md). Login inside a container does not change the subscription usage boundary. Rejections remain visible; there is no automatic paid-key fallback or Claude Code caller impersonation.

The proxy API key given to LiteLLM, the admin secret, and the upstream credential are three different secrets. Database upstream credentials are stored in plaintext in the mounted volume; protect the volume and backups. New history records retain operational metadata only, never request/reply bodies or raw upstream error text. Historical rows are preserved by migration, so old data may still exist.

A subsequent same-host comparison confirmed that **unmodified official Claude
Code through this native test relay** also succeeds on Opus 5.5, with a real
2031-token cache read; raw probes immediately before/after still returned 429.
This narrows the difference to request/client context, without identifying the
provider's exact rule. It does not establish arbitrary-client OAuth eligibility
or the deployed LiteLLM path. The [test-only shape observer](integration/diagnostics/README.md)
records no system text, tokens or thinking/signature content.

## Container login and automatic refresh

The `docker-compose.cli-auth.yml` overlay targets the `app` service in
`docker-compose.yml`. Start that backend with its persistent data and auth volumes:

```sh
cp .env.example .env
# Edit .env privately: set ADMIN_API_SECRET and optional CLAUDE_AUTH_EMAIL.
# Set CLAUDE_AUTH_AUTO_REFRESH=true to enable background refresh (default false).
# For Responses, also set RESPONSES_ENABLED=true and a durable RESPONSES_STATE_KEY.
docker compose --env-file .env -f docker-compose.yml -f docker-compose.cli-auth.yml up -d --build app

docker compose --env-file .env -f docker-compose.yml -f docker-compose.cli-auth.yml exec app claude-auth login
docker compose --env-file .env -f docker-compose.yml -f docker-compose.cli-auth.yml exec app claude-auth status
```

Open the official URL printed by `login`, complete sign-in, and paste the final
**OAuth callback code** into that same terminal when prompted. An email sign-in
code belongs on the website. Once login completes, the relay picks up credentials
from the auth volume without a restart. The commands above start only `app`,
available on the Docker network at port `3456`; configure the published port or
network connection for your separate LiteLLM deployment. This overlay uses a
different service name from the standalone `compose.adapter.yml` profile below.

| CLI-auth setting | Behavior |
| --- | --- |
| `UPSTREAM_AUTH_SOURCE` | The `cli-auth` image selects `claude_cli`; the normal image defaults to `configured` |
| `CLAUDE_CONFIG_DIR` | Defaults to `/home/node/.claude` in the CLI image; persist its separate auth volume |
| `CLAUDE_AUTH_EMAIL` | Optional login-email prefill; keep the actual address in private runtime configuration |
| `CLAUDE_AUTH_AUTO_REFRESH` | Default `false`; `true` enables startup/minute checks and refresh near expiry |

For an already running CLI-auth container, use
`docker exec -it <container> claude-auth login`.
The helper also supports `status`, `refresh` and `logout`.
`status` reads local files only; `refresh` performs the same due check as the
background worker. Inspect `auth_refresh` in `/health` for state, last success
and retry timing. Local readiness does not prove provider/model acceptance.

Keep the data volume, auth volume and Responses state key across container
replacement. Coordinated same-account refresh preserves reasoning continuity.
Enabling/disabling refresh, explicit login/logout or an external credential
replacement requires a fresh Responses conversation. The
[lifecycle guide](docs/CONTAINER-AUTH.md#credential-selection-and-lifecycle)
also documents the token-save/session-commit crash limit.

## Standalone Docker deployment with a configured credential

`compose.adapter.yml` runs only this backend; LiteLLM remains a separate container/host. It uses a read-only filesystem, non-root user, dropped capabilities, and a writable data volume.

```sh
cp .env.adapter.example .env
# Edit .env privately: LAN bind IP, admin secret, upstream URL and ONE credential.
docker compose --env-file .env -f compose.adapter.yml up -d --build
```

| Variable | Meaning |
| --- | --- |
| `PROXY_BIND_IP` | Required local/LAN interface to bind |
| `PROXY_PORT` | Host port; default `13456` |
| `ADMIN_API_SECRET` | Required dedicated admin secret |
| `ANTHROPIC_BASE_URL` | Trusted upstream root or `/v1` URL; default `https://api.anthropic.com` |
| `ANTHROPIC_API_KEY` | Optional upstream API key |
| `CLAUDE_CODE_OAUTH_TOKEN` | Optional setup-token input; acceptance depends on upstream/model/request |
| `UPSTREAM_TIMEOUT_MS` | Total deadline, including streaming; default `300000` |
| `RESPONSES_ENABLED` | Optional Responses adapter; default `false` |
| `RESPONSES_STATE_KEY` | Separate base64 32-byte secret, required when Responses is enabled |
| `RESPONSES_DEVELOPER_MESSAGE_MODE` | `reject` (default) or experimental `hoist`; moves late developer text to top-level system, with scoped replay guards; see [contract and limits](docs/RESPONSES-ADAPTER.md#optional-developer-instruction-hoisting) |
| `OLLAMA_URL` | Optional existing embeddings backend |

Only use a trusted upstream URL: the configured credential is sent there. Plain LAN HTTP is unencrypted; use firewall restrictions and TLS where appropriate. `AUTH_DISABLED` remains a local-development option; the adapter Compose file fixes it to `false`.

Provision a proxy key with authenticated `POST /api/admin/keys`, body `{"name":"litellm"}` and `Authorization: Bearer <ADMIN_API_SECRET>`. Store the returned key securely; the database retains only its hash. Other admin routes manage keys, active tasks, request history and the upstream credential. The optional Next.js dashboard is provided by the full Compose profiles, not the adapter profile.

## LiteLLM setup

```yaml
model_list:
  - model_name: claude-native
    litellm_params:
      model: anthropic/<your-authorized-native-model-id>
      api_base: http://YOUR_PROXY_HOST:13456
      api_key: os.environ/CLAUDE_PROXY_API_KEY
litellm_settings:
  drop_params: false
router_settings:
  num_retries: 0
  fallbacks: []
```

Put the **proxy key** in the LiteLLM container, not the Anthropic credential. The Anthropic Messages deployment above uses the root API Base; do not append `/v1/messages`. Model aliases belong in LiteLLM. `GET /v1/models` here reads the upstream catalog rather than advertising hardcoded model families or access guarantees.

**Do not patch LiteLLM for this project.** The earlier patch installer and patch-dependent suites have been withdrawn; their passing results were not evidence for stock LiteLLM. The configuration above uses LiteLLM's normal provider transformation and is not a lossless contract. For a fidelity-first Messages client, evaluate the stock [pass-through path and HTTP verification](integration/litellm/README.md). Pass-through is a different gateway route with different routing/accounting behavior, not a transparent fix for Chat/Responses conversions. Production gateway settings are not changed by this repository.

For Codex on LiteLLM 1.109.0, use a separate **native Responses model deployment** pointing to the proxy-owned Responses adapter: `openai/claude-opus-5-5`, API base `http://YOUR_PROXY_HOST:13458/v1`, and public alias `claude-opus-5-5-responses-han`. The client uses the standard gateway `/v1/responses` endpoint. See the [configuration example](integration/litellm/native-responses.example.yaml) and [routing/state contract](docs/LITELLM-NATIVE-RESPONSES.md). This avoids the Anthropic-backed Responses-to-Chat conversion without patching LiteLLM or requiring a custom Enterprise endpoint. Earlier custom `/claude-responses` deployments remain a distinct route; their configuration and history do not qualify the new alias. Gateway spend/budget behavior still needs separate acceptance.

Client requirements:

- Messages clients must replay original assistant content blocks and tool results, including signatures, in order.
- Chat clients must retain and replay LiteLLM's `thinking_blocks`; `reasoning_content` alone is not signed thinking state.
- Responses clients must retain and replay reasoning items including `encrypted_content`, not just visible output text. The new adapter is stateless and rejects `previous_response_id` persistence.
- Do not silently switch the backend/account/model for a signed-history conversation. The relay has one configured upstream credential, but it cannot enforce the gateway's routing choices.
- Disable gateway/client retries or lossy fallbacks if testing exact-once upstream behavior. A relay's no-retry guarantee does not control a caller's retries.

Endpoints here:

| Endpoint | Behavior |
| --- | --- |
| `POST /v1/messages` | Default CLI inference; explicit HTTP backend provides raw JSON/SSE relay |
| `POST /v1/messages/count_tokens` | HTTP: native count relay; CLI:501 because the CLI expands context |
| `GET /v1/models` | Native upstream model catalog, with query parameters |
| `POST /v1/embeddings` | Optional existing Ollama embeddings adapter |
| `GET /health` | Local DB/config/task/Ollama diagnostic, **not** a provider-auth probe |
| `/api/admin/*` | Separate admin-authenticated management |
| `POST /v1/responses` | New opt-in stateless adapter with authenticated signed-state replay |
| `/v1/chat/completions` | Removed/unsupported here; normal LiteLLM conversion is not fidelity-certified |

## Historical migration from the original SDK branch

Read [the migration notes](docs/ADAPTER-PATCH.md) before replacing an existing service. Back up the database/volume and keep the previous image/configuration. Do not use `down -v` on an upgrade.

The [isolated Docker lifecycle check](integration/deployment/README-lifecycle.md) exercises
native image upgrades, container re-creation, signed-state key continuity,
rollback and backup restoration using fresh synthetic volumes with networking disabled. It does not
replace or back up a running deployment. The [operating checklist](docs/ADAPTER-PATCH.md#native-only-update-and-rollback-checklist)
separates that rehearsal from an authorized service cutover.

- The earlier native-HTTP migration removed the original SDK execution and server-tool grants. The current default restores genuine CLI inference with caller-executed tools and a bounded native-history adapter; internal Chat translation and proxy-managed cache TTLs remain removed. See [the current CLI contract](docs/CLI-INFERENCE.md).
- API keys, configured credentials and request history are retained. Token/cost columns become nullable transactionally; new cache fields are added.
- Keys with old non-null `monthly_budget_usd`, `system_prompt` or `cache_ttl_seconds` fail with **409**. Move budget enforcement to LiteLLM and system/cache settings to caller requests, then clear those fields through `PATCH /api/admin/keys/:id` using `null`. The dashboard offers clear-only migration actions. New non-null values are rejected.
- Built-in-tool grants left in old database rows are inert. Native TPM limits are best-effort observed-token windows, not prepaid reservations or financial budget enforcement. Unknown usage and simultaneous requests can exceed a requested limit; use the gateway for policy enforcement.

## Development and evidence

The [functional verification status](docs/ACCEPTANCE.md) distinguishes implemented
protocol support from actual gateway/client qualification and production readiness.

```sh
npm ci
npm test
cd admin
npm ci
npm run build
```

Backend tests use real loopback HTTP, in-memory SQLite and synthetic credentials. They cover native raw fidelity, Responses translation, authenticated opaque replay, tool/text order, beta/auth separation, no retry/redirect, cancellation, usage/cache counters, safe diagnostics, legacy configuration guards and migration. No real provider or subscription calls are needed. The separate LiteLLM checks exercise the unmodified FastAPI HTTP gateway against a fake upstream; see their own instructions and scope.

Passing offline tests demonstrates transport mechanics, not provider eligibility, billing savings or universal coding-client compatibility. Separate live evidence was obtained on an isolated `test-claudemock` Docker deployment; existing production services were not replaced. See [recorded verification results](docs/VERIFICATION.md) for the distinction between offline, live relay and gateway checks.

The earlier corrected 2026-10-06 candidate passed **149/149 Docker regressions** and a
three-call real Haiku Responses sequence: signed reasoning/tool output, replay
after developer hoisting, and identical replay. Cache reads were 0 → 5503 → 5651
tokens; fresh input was 10 → 5 → 5. This fixes the earlier native metadata
compatibility failure. That probe did not replace the existing service. Actual `.7`
gateway/client sessions were subsequently tested below, not as part of this direct
probe; see [the measured result and limits](docs/VERIFICATION.md#metadata-compatibility-fix-and-live-responses-replay-2026-10-06).

The `.64:13457` **test-claudemock** service subsequently received that exact
image with Responses and developer hoisting explicitly enabled for testing.
The existing relay key, provider credential, volume and 21 history rows were
preserved. Native rollback and re-upgrade with the same durable state key both
passed local route/startup checks. Other containers and `.7` were unchanged;
see [the earlier deployment and native rollback](docs/VERIFICATION.md#test-service-update-and-native-rollback-2026-10-06).

The gateway owner subsequently deployed both authenticated `.7` pass-through
routes with `forward_headers: true`, preserving all 24 existing model records,
four keys and LiteLLM `1.103.1`. A malformed native-options header reaches the
Responses relay and is rejected before inference. This establishes routing and
dynamic header delivery, not actual-client/provider acceptance or spend accuracy.
See [gateway deployment and rollback](docs/VERIFICATION.md#shared-gateway-routes-2026-10-06).

### Actual shared-gateway results (2026-10-06; OpenCode comparison 2026-10-07 KST)

**Claude Code 2.1.289 and Codex 0.160.0 both completed real Haiku multi-turn
tests through `.7`**, using a separate 24-hour key restricted to the two routes.
Neither client nor LiteLLM source was modified. The proxy converts Codex Responses
to native Messages; LiteLLM pass-through avoids a second, lossy conversion.

- Claude Code: real file Read, resumed follow-up, exact signed thinking replay,
  and cache reads of **4,628 / 4,865 tokens**. The client omits `tool_use.caller`
  on replay; tool IDs/names/inputs, text and ordered block types remain exact.
- Codex: no-I/O tool round trip, actual manual compaction and two follow-ups.
  Opaque reasoning replay and provider acceptance pass. With an eligible fixed
  prefix, cache reads are **6,911 / 7,505 tokens**; short inputs had no cache hit.
  A separate Linux run also **created and updated a real fixture file** through
  `apply_patch=validated`: four Haiku requests, exact final bytes and tool results,
  with opaque reasoning replay preserved.
- OpenCode: one native and one Responses request were each rejected by the
  provider with HTTP 400 and a third-party plan/extra-usage restriction.
  Switching routes alone did not resolve rejection. Separately, offline
  Responses replay preserved ciphertexts but omitted reasoning IDs, which the
  then-current `ccpr1` format required. The later `ccpr2` update supports ID-less
  replay; the provider rejection is a separate finding. See the
  [earlier comparison](integration/clients/README-live-opencode-responses.md) and
  [current replay format](docs/RESPONSES-ADAPTER.md).
  No spoofing, retry or paid fallback was used.
- LiteLLM generic pass-through logs record **zero tokens/spend and no provider
  cache usage**, even for these real requests. This is missing accounting, not
  free usage. Gateway model allowlists also do not enforce the body model here.
  The relay supports its own model ACL, but the current shared key has none
  configured; Haiku-only test scope was enforced by the harness.

An empty tool-argument stream bug was fixed in `f5031f3`; **152/152 local backend
regressions** passed for that revision. That image was deployed to **test-claudemock only**, preserving
its volume, keys and state key. See [current image, evidence and rollback](docs/VERIFICATION.md#actual-shared-gateway-clients-2026-10-06)
and the [client profiles](integration/clients/README.md).

These are bounded profiles, not universal coding-client certification. Test-only
`apply_patch=validated` is enabled and bounded Linux file editing now passes
with user-approved, test-container-only namespace support. General shell and
long repository editing sessions are not covered by that fixture.
The historical synthetic split-signature defect claim was
[corrected against official SDK semantics](docs/VERIFICATION.md#signature-oracle-correction-2026-10-06).
Subscription acceptance is not a general provider entitlement or a measured
billing/quality guarantee. These tests updated only `test-claudemock`; production
was unchanged. Git branch integration is separate from a production rollout.

## Source map

```text
src/routes/anthropic.ts       native endpoint validation
src/services/nativeRelay.ts  HTTP bytes, credentials, cancellation and lifecycle
src/routes/responses.ts      gated optional Responses endpoint
src/services/responses*.ts   strict translation, stream lifecycle and AEAD state
src/authCommand.ts           serialized official CLI login/logout/refresh
src/services/claudeCli*.ts    live CLI credentials and persistent session binding
src/services/authRefresh*.ts background refresh scheduling and safe status
src/services/usageObserver.ts bounded side-channel usage observation
src/services/upstreamDiagnostics.ts allowlisted, bounded error/header observation
src/services/historyService.ts / src/db/  metadata and migrations
admin/                       optional administration UI
tests/                       loopback native relay regression tests
integration/litellm/          stock gateway verification and configuration notes
integration/clients/          actual CLI synthetic compatibility checks
integration/auth/             isolated official CLI probes and live refresh receipts
integration/deployment/       isolated image/state/rollback qualification
```

MIT for this repository; dependencies retain their own licenses and terms.
