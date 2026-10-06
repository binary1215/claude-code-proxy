# Claude Code Proxy — native relay and opt-in Responses adapter

A native Anthropic HTTP relay, forked from [MehdiMohseni82/claude-code-proxy](https://github.com/MehdiMohseni82/claude-code-proxy). **This branch removes the Claude Agent SDK/CLI execution backend.** It is a breaking transport change, not an SDK upgrade.

```text
Claude Code / Messages -> stock LiteLLM pass-through -> native /v1/messages
Codex / Responses     -> stock LiteLLM pass-through -> opt-in /v1/responses
                                                        -> Anthropic HTTP upstream
```

No automatic SDK fallback, tool execution, invented thinking, conversation storage, or provider/account failover is included. The caller owns conversation history and executes its client tools. Upstream-native server-tool definitions are forwarded on the native route; they are not executed on the proxy host. The new [Responses adapter](docs/RESPONSES-ADAPTER.md) is disabled by default and supports a deliberately bounded client-tool subset.

## Native Messages preservation contract

- JSON request bytes and upstream response/SSE bytes are forwarded unchanged, including unknown fields, thinking/signatures, redacted thinking, tool results, `is_error`, cache markers and TTLs. The proxy does not rename models or inject a system prompt.
- `anthropic-*`, content type, accept, caller user-agent, request IDs and idempotency headers are forwarded, except hop-by-hop headers. Proxy caller credentials are **replaced**, not passed upstream. The default Anthropic API version is added if absent. OAuth mode adds the OAuth beta flag, but no Claude Code identity or system-prompt emulation.
- No redirect following, retry, signature repair, or removal of thinking on errors. HTTP errors and SSE error events remain upstream errors.
- Backpressure and cancellation propagate to the upstream HTTP request. Administrative cancellation is supported. A configurable total request deadline prevents orphaned connections.
- Bounded observers read usage and safe diagnostics separately from transport. Cache read/write and 5-minute/1-hour creation counts remain distinct. Missing or incomplete usage and unknown billed USD are **not zero**. Encoded responses remain byte-identical; usage is unknown if the observer cannot decode them. Large observation buffers are abandoned without stopping delivery.
- History records upstream status, allowlisted error types/codes, request ID, Retry-After, quota headers and authentication kind. It never stores raw provider error messages, tokens or conversation bodies in new records. A bare 429 is `unknown_429`, not proof of quota exhaustion. Timeout, cancellation and incomplete streams remain distinct.
- The relay cannot force an upstream prompt-cache hit or a coding client to replay opaque reasoning blocks. Native preservation removes relay-side loss; it does not prove billing savings or answer-quality improvements.

JSON requests are limited to 10 MiB. Compressed request bodies are rejected, not silently decoded/re-encoded. Headers/framing are not promised byte-identical: hop-by-hop headers and content length are managed by HTTP transport; response payload bytes are preserved.

The optional Responses endpoint translates protocols; it does **not** claim byte preservation. It preserves the exact original thinking/signature/redacted blocks inside authenticated encrypted reasoning items, restores them on replay, and preserves tool/text order. Capsules are supplied both when each item completes and in the full completed response. Changed, expired or foreign capsules fail explicitly rather than losing thinking silently. See the [supported subset, security model and configuration](docs/RESPONSES-ADAPTER.md).

## Authentication and subscription limitation

The upstream credential is selected once per request, in this order:

1. Admin database credential (`claude_oauth_token`, retained storage key).
2. `CLAUDE_CODE_OAUTH_TOKEN` environment variable.
3. `ANTHROPIC_API_KEY` environment variable.

Database credentials starting with `sk-ant-oat` and the OAuth environment variable use `Authorization: Bearer`. API keys use `x-api-key`. There is no fallback to another credential after failure. A database override must be explicitly removed before an environment credential takes effect.

`claude setup-token` output can still be provided through a private container environment file. **Accepting the token as configuration does not establish that Anthropic will accept it for every model on this native HTTP path.** In an isolated test, Haiku accepted signed thinking/tool replay and produced a real cache hit, while minimal Opus/Fable requests returned a bare 429. The same credential worked for Opus in unmodified official Claude Code. These observations do not establish the server's rejection rule or authorize arbitrary subscription-token intermediation. No token refresh/login service, browser automation or Claude Code impersonation is included. Rejections remain visible; there is no automatic paid-key fallback. See [verification and limitations](docs/VERIFICATION.md).

The proxy API key given to LiteLLM, the admin secret, and the upstream credential are three different secrets. Database upstream credentials are stored in plaintext in the mounted volume; protect the volume and backups. New history records retain operational metadata only, never request/reply bodies or raw upstream error text. Historical rows are preserved by migration, so old data may still exist.

A subsequent same-host comparison confirmed that **unmodified official Claude
Code through this native test relay** also succeeds on Opus 5.5, with a real
2031-token cache read; raw probes immediately before/after still returned 429.
This narrows the difference to request/client context, without identifying the
provider's exact rule. It does not establish arbitrary-client OAuth eligibility
or the deployed LiteLLM path. The [test-only shape observer](integration/diagnostics/README.md)
records no system text, tokens or thinking/signature content.

## Standalone Docker deployment

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

Put the **proxy key** in the LiteLLM container, not the Anthropic credential. Use the root API Base in LiteLLM; do not append `/v1/messages`. Model aliases belong in LiteLLM. `GET /v1/models` here reads the upstream catalog rather than advertising hardcoded model families or access guarantees.

**Do not patch LiteLLM for this project.** The earlier patch installer and patch-dependent suites have been withdrawn; their passing results were not evidence for stock LiteLLM. The configuration above uses LiteLLM's normal provider transformation and is not a lossless contract. For a fidelity-first Messages client, evaluate the stock [pass-through path and HTTP verification](integration/litellm/README.md). Pass-through is a different gateway route with different routing/accounting behavior, not a transparent fix for Chat/Responses conversions. Production gateway settings are not changed by this repository.

For Codex, use a separate stock pass-through route to the **new proxy-owned Responses adapter**, bypassing LiteLLM's lossy Responses transformation. [Configuration and rollout limits](docs/RESPONSES-ADAPTER.md) include explicit route authentication, relay model restrictions, state-key persistence and caller-requested native cache/thinking options. This path uses exact native model IDs, not managed-model aliases. Gateway spend/budget behavior still needs separate acceptance.

Client requirements:

- Messages clients must replay original assistant content blocks and tool results, including signatures, in order.
- Chat clients must retain and replay LiteLLM's `thinking_blocks`; `reasoning_content` alone is not signed thinking state.
- Responses clients must retain and replay reasoning items including `encrypted_content`, not just visible output text. The new adapter is stateless and rejects `previous_response_id` persistence.
- Do not silently switch the backend/account/model for a signed-history conversation. The relay has one configured upstream credential, but it cannot enforce the gateway's routing choices.
- Disable gateway/client retries or lossy fallbacks if testing exact-once upstream behavior. A relay's no-retry guarantee does not control a caller's retries.

Endpoints here:

| Endpoint | Behavior |
| --- | --- |
| `POST /v1/messages` | Native raw JSON/SSE relay |
| `POST /v1/messages/count_tokens` | Native count request relay |
| `GET /v1/models` | Native upstream model catalog, with query parameters |
| `POST /v1/embeddings` | Optional existing Ollama embeddings adapter |
| `GET /health` | Local DB/config/task/Ollama diagnostic, **not** a provider-auth probe |
| `/api/admin/*` | Separate admin-authenticated management |
| `POST /v1/responses` | New opt-in stateless adapter with authenticated signed-state replay |
| `/v1/chat/completions` | Removed/unsupported here; normal LiteLLM conversion is not fidelity-certified |

## Migration from the SDK branch

Read [the migration notes](docs/ADAPTER-PATCH.md) before replacing an existing service. Back up the database/volume and keep the previous image/configuration. Do not use `down -v` on an upgrade.

The [isolated Docker lifecycle check](integration/deployment/README-lifecycle.md) exercises
native image upgrades, container re-creation, signed-state key continuity,
rollback and backup restoration using fresh synthetic volumes with networking disabled. It does not
replace or back up a running deployment. The [operating checklist](docs/ADAPTER-PATCH.md#native-only-update-and-rollback-checklist)
separates that rehearsal from an authorized service cutover.

- SDK/CLI and server-side tool grants, internal Chat translation, injected system prompts and proxy-managed cache TTLs are removed, not hidden behind a mode flag.
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

### Actual shared-gateway results (2026-10-06)

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
- OpenCode: one native request was rejected by the provider with HTTP 400 and a
  third-party plan/extra-usage restriction. No spoofing, retry or paid fallback.
- LiteLLM generic pass-through logs record **zero tokens/spend and no provider
  cache usage**, even for these real requests. This is missing accounting, not
  free usage. Gateway model allowlists also do not enforce the body model here.
  The relay supports its own model ACL, but the current shared key has none
  configured; Haiku-only test scope was enforced by the harness.

An empty tool-argument stream bug was fixed in `f5031f3`; **152/152 local backend
regressions** pass. The image is deployed to **test-claudemock only**, preserving
its volume, keys and state key. See [current image, evidence and rollback](docs/VERIFICATION.md#actual-shared-gateway-clients-2026-10-06)
and the [client profiles](integration/clients/README.md).

These are bounded profiles, not universal coding-client certification. Codex
`apply_patch` remains disabled on this test service, native clients have known
synthetic split-signature limitations, and subscription acceptance is not a
general provider entitlement or a measured billing/quality guarantee. Production
and `master` have not been replaced.

## Source map

```text
src/routes/anthropic.ts       native endpoint validation
src/services/nativeRelay.ts  HTTP bytes, credentials, cancellation and lifecycle
src/routes/responses.ts      gated optional Responses endpoint
src/services/responses*.ts   strict translation, stream lifecycle and AEAD state
src/services/usageObserver.ts bounded side-channel usage observation
src/services/upstreamDiagnostics.ts allowlisted, bounded error/header observation
src/services/historyService.ts / src/db/  metadata and migrations
admin/                       optional administration UI
tests/                       loopback native relay regression tests
integration/litellm/          stock gateway verification and configuration notes
integration/clients/          actual CLI synthetic compatibility checks
integration/deployment/       isolated image/state/rollback qualification
```

MIT for this repository; dependencies retain their own licenses and terms.
