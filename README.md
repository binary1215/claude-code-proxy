# Claude Code Proxy — native Messages relay

A native Anthropic HTTP relay, forked from [MehdiMohseni82/claude-code-proxy](https://github.com/MehdiMohseni82/claude-code-proxy). **This branch removes the Claude Agent SDK/CLI execution backend.** It is a breaking transport change, not an SDK upgrade.

```text
Coding client (Messages / Chat Completions / Responses)
    -> LiteLLM gateway (separate container: aliases, conversions, budgets)
    -> this relay (native Messages only)
    -> configured Anthropic-compatible HTTP upstream
```

No automatic SDK fallback, tool execution, thinking reconstruction, conversation storage, or provider/account failover is included. The caller owns conversation history and executes its client tools. Upstream-native server-tool definitions are forwarded; they are not executed on the proxy host.

## Preservation contract

- JSON request bytes and upstream response/SSE bytes are forwarded unchanged, including unknown fields, thinking/signatures, redacted thinking, tool results, `is_error`, cache markers and TTLs. The proxy does not rename models or inject a system prompt.
- `anthropic-*`, content type, accept, caller user-agent, request IDs and idempotency headers are forwarded, except hop-by-hop headers. Proxy caller credentials are **replaced**, not passed upstream. The default Anthropic API version is added if absent. OAuth mode adds the OAuth beta flag, but no Claude Code identity or system-prompt emulation.
- No redirect following, retry, signature repair, or removal of thinking on errors. HTTP errors and SSE error events remain upstream errors.
- Backpressure and cancellation propagate to the upstream HTTP request. Administrative cancellation is supported. A configurable total request deadline prevents orphaned connections.
- A bounded observer reads usage separately from transport. Cache read/write and 5-minute/1-hour creation counts remain distinct. Missing or incomplete usage and unknown billed USD are **not zero**. Encoded responses remain byte-identical; usage is unknown if the observer cannot decode them. Large observation buffers are abandoned without stopping delivery.
- The relay cannot force an upstream prompt-cache hit or a coding client to replay opaque reasoning blocks. Native preservation removes relay-side loss; it does not prove billing savings or answer-quality improvements.

JSON requests are limited to 10 MiB. Compressed request bodies are rejected, not silently decoded/re-encoded. Headers/framing are not promised byte-identical: hop-by-hop headers and content length are managed by HTTP transport; response payload bytes are preserved.

## Authentication and subscription limitation

The upstream credential is selected once per request, in this order:

1. Admin database credential (`claude_oauth_token`, retained storage key).
2. `CLAUDE_CODE_OAUTH_TOKEN` environment variable.
3. `ANTHROPIC_API_KEY` environment variable.

Database credentials starting with `sk-ant-oat` and the OAuth environment variable use `Authorization: Bearer`. API keys use `x-api-key`. There is no fallback to another credential after failure. A database override must be explicitly removed before an environment credential takes effect.

`claude setup-token` output can still be provided through a private container environment file. **Accepting the token as configuration does not establish that Anthropic will accept a subscription token on this native HTTP path.** This implementation neither grants authorization under provider terms nor bypasses a provider rejection. No token refresh/login service, browser automation, Claude Code impersonation, or real subscription validation is included. If the upstream refuses a token, that failure is returned; the service does not switch to paid API billing automatically.

The proxy API key given to LiteLLM, the admin secret, and the upstream credential are three different secrets. Database upstream credentials are stored in plaintext in the mounted volume; protect the volume and backups. New history records retain operational metadata only, never request/reply bodies or raw upstream error text. Historical rows are preserved by migration, so old data may still exist.

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
| `CLAUDE_CODE_OAUTH_TOKEN` | Optional setup-token input; acceptance unverified |
| `UPSTREAM_TIMEOUT_MS` | Total deadline, including streaming; default `300000` |
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

For the audited LiteLLM `1.103.1`, apply the separately pinned [preservation patch and tests](integration/litellm/README.md). It addresses duplicated streaming thinking, fragmented signatures, signature-only thinking blocks, native beta forwarding, and strict opt-in native handling without destructive thinking removal/retry. It does not make every OpenAI conversion lossless or upgrade your running gateway automatically. Converted Chat/Responses may regroup thinking and tool blocks; exact native content ordering requires native Messages.

Client requirements:

- Messages clients must replay original assistant content blocks and tool results, including signatures, in order.
- Chat clients must retain and replay LiteLLM's `thinking_blocks`; `reasoning_content` alone is not signed thinking state.
- Responses clients must retain and replay reasoning items including `encrypted_content`, not just visible output text. `previous_response_id` persistence is a separate gateway concern, not implemented by this relay.
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
| `/v1/chat/completions`, `/v1/responses` | Removed/unsupported here; use LiteLLM |

## Migration from the SDK branch

Read [the migration notes](docs/ADAPTER-PATCH.md) before replacing an existing service. Back up the database/volume and keep the previous image/configuration. Do not use `down -v` on an upgrade.

- SDK/CLI and server-side tool grants, internal Chat translation, injected system prompts and proxy-managed cache TTLs are removed, not hidden behind a mode flag.
- API keys, configured credentials and request history are retained. Token/cost columns become nullable transactionally; new cache fields are added.
- Keys with old non-null `monthly_budget_usd`, `system_prompt` or `cache_ttl_seconds` fail with **409**. Move budget enforcement to LiteLLM and system/cache settings to caller requests, then clear those fields through `PATCH /api/admin/keys/:id` using `null`. The dashboard offers clear-only migration actions. New non-null values are rejected.
- Built-in-tool grants left in old database rows are inert. Native TPM limits are best-effort observed-token windows, not prepaid reservations or financial budget enforcement. Unknown usage and simultaneous requests can exceed a requested limit; use the gateway for policy enforcement.

## Development and evidence

```sh
npm ci
npm test
cd admin
npm ci
npm run build
```

Backend tests use real loopback HTTP, in-memory SQLite and synthetic credentials. They cover raw request/response and SSE fidelity, replay, beta/auth separation, no retry/redirect, cancellation, usage/cache counters, legacy configuration guards and migration. No real provider or subscription calls are needed. The LiteLLM suite exercises installed LiteLLM code against a fake upstream; see its own instructions and scope.

Passing these tests demonstrates transport mechanics, not real provider eligibility, actual cache hits/cost, universal coding-client compatibility, or production Docker/LAN readiness. This change has not been deployed by the implementation task. See [recorded verification results](docs/VERIFICATION.md).

## Source map

```text
src/routes/anthropic.ts       native endpoint validation
src/services/nativeRelay.ts  HTTP bytes, credentials, cancellation and lifecycle
src/services/usageObserver.ts bounded side-channel usage observation
src/services/historyService.ts / src/db/  metadata and migrations
admin/                       optional administration UI
tests/                       loopback native relay regression tests
integration/litellm/          version-pinned gateway patch and real-library tests
```

MIT for this repository; dependencies retain their own licenses and terms.
