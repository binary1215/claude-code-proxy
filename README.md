# Claude Code Proxy — LiteLLM Backend Adapter

A standalone HTTP adapter built on the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript), forked from [MehdiMohseni82/claude-code-proxy](https://github.com/MehdiMohseni82/claude-code-proxy).

This fork's primary deployment is an API-only Docker container behind a **separate LiteLLM gateway**. It exposes OpenAI-compatible chat completions and Anthropic-style Messages; it is not a complete implementation of either provider's API.

```text
Client → LiteLLM gateway (separate container/host)
       → Claude Code Proxy → Agent SDK / bundled Claude Code → Claude
                          ↘ SQLite: keys, settings, request metadata
                          ↘ Ollama: optional embeddings backend
```

The dependency is pinned to **Agent SDK 0.3.285**, which packages **Claude Code 2.1.285**. Updating a host's global `claude` installation does not update the SDK bundled into an existing image.

## What this fork changes

- Authentication fails closed: a fresh database denies `/v1/*` until a proxy API key is provisioned.
- The adapter Compose file disables server-side tools, even if a key has the legacy built-in-tool grant. Plain text requests also receive `tools: []`.
- Caller-defined function tools are intercepted and returned to the caller for execution. This does not grant tools access to the proxy host.
- New request-history writes retain metadata and allowlisted error categories, not prompt previews, full prompts, full responses, or raw SDK diagnostics.
- SDK session transcript persistence is disabled through `persistSession: false`. This is not a universal audit of all SDK caches, telemetry, or runtime files.
- The image runs as `node`; the adapter profile uses a read-only root filesystem, writable data volume and `/tmp`, dropped capabilities, and `no-new-privileges`.
- `CLAUDE_CODE_OAUTH_TOKEN` can be supplied through a private Compose `.env` file. No interactive login service or token-refresh manager is included.

Subscription authentication being technically configurable does **not** establish permission to relay a subscription through a third-party gateway. Account eligibility and current provider terms need separate review. This is not an officially endorsed subscription gateway.

## Quick start: API-only Docker adapter

Prerequisites: Docker with Compose v2, an assigned host LAN address, and backend credentials you are authorized to use. Obtain a subscription token separately with the official `claude setup-token` workflow; do not run it through this proxy.

```bash
git clone --branch master https://github.com/binary1215/claude-code-proxy.git
cd claude-code-proxy

cp .env.adapter.example .env
chmod 600 .env
# Edit .env privately; fill in the values described below.

docker compose -p claude-code-adapter --env-file .env -f compose.adapter.yml config --quiet
docker compose -p claude-code-adapter --env-file .env -f compose.adapter.yml up -d --build
```

On Windows, use equivalent copy commands and restrict the file's ACL instead of `chmod`.

### Adapter environment

| Variable | Meaning |
|---|---|
| `PROXY_BIND_IP` | Required: an address actually assigned to the proxy host. Avoid wildcard/public exposure. |
| `PROXY_PORT` | Host port; defaults to `13456`. Container port is `3456`. |
| `ADMIN_API_SECRET` | Required: a dedicated random secret for `/api/admin/*`. |
| `CLAUDE_CODE_OAUTH_TOKEN` | Optional at startup: paste the official setup-token output privately. Required for subscription-backed calls unless a database credential takes precedence. |
| `OLLAMA_URL` | Optional: reachable Ollama base URL for embeddings. The adapter default is `http://127.0.0.1:11434` **inside the container**, not the host. |

`compose.adapter.yml` starts only the proxy, not LiteLLM, Ollama, nginx, certbot, or the Next.js dashboard. It fixes `AUTH_DISABLED=false` and `ALLOW_SERVER_SIDE_TOOLS=false`.

The volume is `claude-code-adapter_claude-proxy-data` with the project name above. Keep the same project name and volume when updating; changing them can create an empty database with different credentials. Back up data before upgrades. Existing root-owned volumes may need a deliberate ownership migration for the non-root image; do not delete the volume to solve a permission error.

Keep `.env`, tokens, keys, database backups, and deployment records outside Git. Do not print resolved Compose configuration or dump container environment variables after configuring real credentials. Docker administrators can inspect environment values: this is not secret encryption. Plain HTTP should stay on a trusted LAN; use TLS and appropriate access controls for other exposure.

### Provision a proxy API key

| Credential | Where it belongs |
|---|---|
| Claude OAuth token / Anthropic API key | Proxy backend configuration only |
| Proxy API key | LiteLLM's backend model entry, or a direct client of this proxy |
| Admin API secret | Proxy administration only; never a normal model credential |
| LiteLLM virtual key | Client → LiteLLM authentication; not this proxy's backend key |

Use the authenticated admin API to create a dedicated key. Replace these placeholders locally; **the response contains the newly generated raw key**, so keep it private and do not commit its output.

```bash
curl http://YOUR_PROXY_HOST:13456/api/admin/keys \
  -H 'Authorization: Bearer YOUR_PRIVATE_ADMIN_SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"name":"litellm-backend"}'
```

All `/v1/*` routes accept either `Authorization: Bearer YOUR_PROXY_API_KEY` or `x-api-key: YOUR_PROXY_API_KEY`. A new installation without a provisioned key returns 401 rather than allowing unauthenticated access. `/health` is unauthenticated; the admin API shares the listener but requires its own secret.

### Backend token precedence

The server chooses credentials in this order:

1. SQLite setting `claude_oauth_token`.
2. `CLAUDE_CODE_OAUTH_TOKEN` environment variable.
3. `ANTHROPIC_API_KEY` environment variable.

OAuth-prefixed credentials are forwarded as `CLAUDE_CODE_OAUTH_TOKEN`; other credentials are forwarded as `ANTHROPIC_API_KEY`. The server supports both, but the adapter Compose profile only forwards the OAuth variable. An API-key deployment needs an explicit Compose override forwarding `ANTHROPIC_API_KEY`, or deliberate admin configuration.

A stale database token overrides a new environment token. To switch to environment-only configuration, deliberately remove the database token through the authenticated `DELETE /api/admin/settings/token` endpoint. This does not remove the environment value. Changing `.env` requires **container recreation**, not just `docker restart`:

```bash
docker compose -p claude-code-adapter --env-file .env -f compose.adapter.yml up -d --force-recreate
```

Do not clear or replace an existing credential store without a backup. Token expiry and replacement are operator responsibilities; the proxy does not implement OAuth login or refresh.

## Connect the separate LiteLLM gateway

For an **Anthropic provider** model entry, use the proxy's root URL as `api_base`:

```yaml
model_list:
  - model_name: claude-sonnet
    litellm_params:
      model: anthropic/claude-sonnet-4-6
      api_base: http://YOUR_PROXY_HOST:13456
      api_key: os.environ/CLAUDE_PROXY_API_KEY
```

Set `CLAUDE_PROXY_API_KEY` privately **in the LiteLLM container's environment** to the provisioned proxy key, not the Claude token. If managing models in LiteLLM's UI, enter the equivalent provider/model, root API Base, and backend key fields. Do not store real keys in a public config file.

LiteLLM's Anthropic provider [automatically appends `/v1/messages`](https://docs.litellm.ai/docs/providers/anthropic#custom-api-base). With its normal suffix behavior, **do not append `/v1` or `/v1/messages` to `api_base`**:

```text
Correct: http://YOUR_PROXY_HOST:13456 → /v1/messages
Wrong:   http://YOUR_PROXY_HOST:13456/v1 → /v1/v1/messages
```

Use an address reachable from the LiteLLM container. On another host, `localhost` and a proxy-only Docker service name will not reach the proxy.

Direct OpenAI SDK clients use a different convention: their base URL is `http://YOUR_PROXY_HOST:13456/v1`. Direct Anthropic SDK clients use the root URL. Do not copy these settings interchangeably.

## Endpoints and models

| Endpoint | Implemented scope |
|---|---|
| `GET /health` | Liveness/configuration, database check, active-task count, token source, Ollama status |
| `GET /v1/models` | Static advertised model/alias list; **not** an account-entitlement query |
| `POST /v1/chat/completions` | Text chat, caller-defined tools, and SSE, with the limitations below |
| `POST /v1/messages` | Anthropic-style text Messages, caller-defined tools, and SSE; not full native API parity |
| `POST /v1/embeddings` | Ollama forwarding; needs a reachable Ollama service and pulled model |
| `/api/admin/*` | Authenticated key, task, history, and token administration |

There is no native `/v1/responses` endpoint. LiteLLM Responses conversion and individual client compatibility require separate testing.

Static mappings in [`src/models.ts`](src/models.ts):

| Client model | Backend model |
|---|---|
| `claude-sonnet-4-6` | Unchanged |
| `claude-opus-4-6` | Unchanged |
| `claude-haiku-4-5` | Unchanged |
| `gpt-4o`, `gpt-4`, `gpt-4-turbo` | `claude-sonnet-4-6` |
| `gpt-3.5-turbo` | `claude-haiku-4-5` |
| `text-embedding-ada-002`, `text-embedding-3-small`, `text-embedding-3-large` | `nomic-embed-text` through Ollama |
| Any unrecognized model ID | Passed through unchanged |

Newer Claude IDs, including Fable models, can be supplied as passthrough IDs even if absent from `/v1/models`. Passthrough is not validation: access depends on the backend, account, SDK/CLI version, and per-key model restrictions. This fork has not established live access to every model family.

## Tools, streaming, and data retention

- Caller tools return names, IDs, and arguments to the client; the client executes them and can submit results in a subsequent request.
- Tool histories are reconstructed as text, not a native resumed Claude conversation. Tool-path SSE is buffered; plain-text SSE forwards deltas.
- Server tools and `x-enable-builtin-tools` are denied with 403 in the adapter profile, before SDK dispatch. Legacy tool execution requires both a global opt-in and the API key's built-in-tool grant; it is outside the default configuration and its live execution is not validated here.
- New SQLite request rows preserve model/key metadata, timing, usage/cost, status, and allowlisted error categories. They discard conversation content. Active-task previews are empty; operational error logs omit raw diagnostics.
- Raw error details may still be returned to authenticated callers. This is not an output-redaction service; operators remain responsible for LiteLLM's own logging policy.
- Existing historical rows are not scrubbed. SQLite token settings are still retained. The upstream dashboard can display metadata, but new full-prompt/response fields will be empty.

Per-key rate limits, model restrictions, system prompts, budgets, and task cancellation remain available through the admin API. SDK-reported cost metadata is not proof of subscription billing or remaining subscription quota.

## Verification and operation

Basic probes do not invoke Claude:

```bash
curl http://YOUR_PROXY_HOST:13456/health

# Expect 401 without a proxy key.
curl -i http://YOUR_PROXY_HOST:13456/v1/models

# Expect 200 with a provisioned key.
curl http://YOUR_PROXY_HOST:13456/v1/models \
  -H 'Authorization: Bearer YOUR_PROXY_API_KEY'
```

`token_configured: true` only means a credential exists. `/health` returns HTTP 200 even when a reported subsystem is unavailable; inspect the JSON fields. An unreachable optional Ollama backend does not itself establish a Claude failure. A successful model listing does not establish Claude authentication or model access.

Recorded verification on **2026-09-30**:

- TypeScript build and mocked regression tests: **21/21 passed** on Windows and in an isolated Linux container.
- Docker image built; its packaged Linux executable reported **2.1.285 (Claude Code)** via `--version`, including after container replacement.
- Real SDK MCP registration was constructed offline, without a provider query.
- The deployed adapter passed health/authenticated model-list probes; unauthenticated requests returned 401 and disabled server tools returned 403. Existing secrets and the volume were preserved.
- No successful live Claude inference or LiteLLM inference E2E was established by these checks. Subscription eligibility and all-model compatibility remain unverified.
- The latest recorded production audit still reported three affected packages: `body-parser` (low), `qs` and `uuid` (moderate). These were not blindly upgraded as part of the SDK fix; rerun `npm audit --omit=dev` and assess reachability before broader deployment.

For future SDK updates, change the pinned dependency and lockfile, run tests, rebuild, and verify the **packaged executable** before replacing the service. Preserve the prior image/configuration and back up the volume for rollback. Use the same Compose project/volume. Never use `down -v` for an ordinary upgrade.

### Common failures

| Failure | Check |
|---|---|
| `Cannot POST /v1/v1/messages` | Remove `/v1` from LiteLLM's Anthropic `api_base`. |
| `claude_code_version_too_old` | Rebuild with a sufficiently new pinned SDK; a host-only CLI update is insufficient. This error maps to HTTP 400 `invalid_request_error`. |
| 401 from this proxy | Provision a key and check the proxy key, not the Claude token or LiteLLM client key. |
| Backend authentication failure | Check token expiry and database-over-environment precedence. |
| 403 for server tools | Expected in the adapter profile; remove the server-side tool request. |
| SSE error after HTTP 200 | Headers may already have been sent; inspect the SSE error, not just HTTP status. |

## Known compatibility limits

- No OAuth login/refresh manager, native Responses API, or guarantee of subscription eligibility.
- `tool_choice`, sampling options, and output-token limits are not fully enforced; some accepted fields are ignored by upstream code.
- Image/document inputs are not forwarded as native multimodal input; thinking requests are not fully supported.
- Caller-tool schemas and conversation reconstruction are intentionally limited; test actual clients before relying on complex workflows.
- Mocked tests validate adapter mechanics, not real model behavior or universal SDK/client compatibility.

## Local development and optional upstream services

Node.js 22+ is used for the runtime image. `npm test` requires a release supporting `--experimental-test-module-mocks` (recorded Docker tests used Node 22; Windows used Node 24).

```bash
npm ci
npm run build
npm test

# Configure real environment values privately, then start locally:
node --env-file=.env dist/server.js
```

The server does not automatically load `.env` for `npm start` or `npm run dev`; export the variables or use Node's `--env-file` above. A Compose `.env` is not automatically read by a directly launched Node process.

The dashboard under `admin/`, full-stack [`docker-compose.yml`](docker-compose.yml), and [`docker-compose.prod.yml`](docker-compose.prod.yml) are retained from upstream. They are optional, are **not** started by `compose.adapter.yml`, and their full-stack TLS/dashboard deployment was not revalidated by this adapter work. Install/administer those separately if needed, with matching admin secrets and restricted credentials.

For embeddings, run Ollama separately, pull `nomic-embed-text`, and configure an `OLLAMA_URL` reachable from the proxy container. No Ollama service is installed by the adapter profile.

## Source layout

```text
src/app.ts                 API middleware and routes
src/models.ts              Static model aliases and passthrough
src/routes/                Chat, Messages, embeddings, health, admin API
src/services/sdkBridge.ts  SDK invocation, auth forwarding, task/history tracking
src/services/toolBridge.ts Caller-tool MCP bridge
src/services/              Keys, settings, metadata, error classification
src/db/                    SQLite connection and migrations
tests/                     Mocked SDK regression tests
compose.adapter.yml        API-only Docker deployment
.env.adapter.example       Empty-secret adapter configuration template
admin/                     Optional upstream Next.js dashboard
docs/ADAPTER-PATCH.md       Patch details and historical initial verification notes
```

## License

MIT for this repository; SDK and other dependencies retain their own licenses and applicable terms.
