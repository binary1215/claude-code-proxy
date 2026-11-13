# claudemock

claudemock exposes Claude inference through Anthropic Messages and a bounded OpenAI Responses interface, with a separate LiteLLM gateway in front. The default backend uses the genuine Claude CLI through the Agent SDK; client tools execute in the calling client.

This repository was renamed from `binary1215/claude-code-proxy` to [binary1215/claudemock](https://github.com/binary1215/claudemock). It is a fork of [MehdiMohseni82/claude-code-proxy](https://github.com/MehdiMohseni82/claude-code-proxy).

```text
Claude Code / Messages ─┐
Codex / Responses ─────┼─> separate LiteLLM ─> claudemock
Other compatible tools ┘                         │
                                      Agent SDK / Claude CLI
                                                 │
                                      private HTTP forwarder
                                                 │
                                           Claude provider
```

The standard image pins **Agent SDK 0.3.322 and Claude CLI 2.1.322**. An explicit HTTP backend remains available for native forwarding. A provider rejection does not trigger an automatic backend, model, or account switch.

## Supported interfaces

| Endpoint | Behavior |
| --- | --- |
| `POST /v1/messages` | Anthropic Messages; streaming and client-tool continuation |
| `POST /v1/responses` | Opt-in Responses adapter; streaming, function tools, authenticated replay state |
| `POST /v1/responses/compact` | Opt-in standalone compaction using the CLI backend; JSON response |
| `POST /v1/messages/count_tokens` | Native forwarding in HTTP mode; `501` in CLI mode |
| `GET /v1/models` | Upstream model catalog |
| `POST /v1/embeddings` | Optional Ollama integration |
| `GET /health` | Local status inspection, not a successful-inference probe |
| `/api/admin/*` | Proxy keys, settings and usage administration |

This is not full OpenAI API compatibility. Chat Completions, stored Responses, `previous_response_id`, background Responses, and inline `context_management` are unsupported. Supported content and tool types differ by backend; consult the [CLI contract](docs/CLI-INFERENCE.md) and [Responses contract](docs/RESPONSES-ADAPTER.md) before choosing a client.

## Docker quickstart: configured credentials

Use this profile when providing an upstream API credential or an official `claude setup-token` result. Docker Compose builds the image locally.

```sh
git clone https://github.com/binary1215/claudemock.git
cd claudemock
cp .env.adapter.example .env
```

Edit the private `.env` file:

| Setting | Value |
| --- | --- |
| `PROXY_BIND_IP` | This proxy host's LAN address, reachable from LiteLLM |
| `PROXY_PORT` | `13456`, or the desired published port |
| `ADMIN_API_SECRET` | A dedicated randomly generated administration secret |
| `ANTHROPIC_BASE_URL` | Usually `https://api.anthropic.com` |
| `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` | Your upstream credential |
| `CLAUDE_INFERENCE_BACKEND` | `cli` (default) |
| `PROXY_BUILD_TARGET` | `default` (includes the CLI worker) |
| `RESPONSES_ENABLED` | `true` for Responses clients or standalone compaction |
| `RESPONSES_STATE_KEY` | A persistent, separate 32-byte random key in canonical base64; required when Responses is enabled |

Generate independent secrets, for example with `openssl rand -base64 32`. Keep `.env`, tokens, database files and authentication stores out of Git. Preserve the Responses state key across restarts so clients can replay previously issued state.

```sh
docker compose -f compose.adapter.yml up -d --build
docker compose -f compose.adapter.yml ps
curl http://YOUR_PROXY_HOST:13456/health
```

This profile runs service `claude-proxy`, publishes container port `3456` on the selected address/port, and persists `/app/data` in `claude-proxy-data`. The health check does not send a model request.

Provision a **proxy API key** through `POST /api/admin/keys`, authenticated with `Authorization: Bearer <ADMIN_API_SECRET>` and JSON body `{"name":"litellm"}`. Save the returned key privately; only its hash is retained. Use this proxy key in LiteLLM. The upstream credential and administration secret are not client API keys.

For an explicit CLI-free native relay, set both `CLAUDE_INFERENCE_BACKEND=http` and `PROXY_BUILD_TARGET=http`, then rebuild. Standalone Responses compaction is unavailable on that backend.

## Container login and automatic refresh

For persistent login managed by the official CLI, use the main Compose file with its authentication overlay instead of the quickstart profile above:

```sh
cp .env.example .env
# Edit ADMIN_API_SECRET and any desired Responses settings in .env.
# Optional: set CLAUDE_AUTH_EMAIL and CLAUDE_AUTH_AUTO_REFRESH=true.
docker compose -f docker-compose.yml -f docker-compose.cli-auth.yml up -d --build app
docker compose -f docker-compose.yml -f docker-compose.cli-auth.yml exec app claude-auth login
docker compose -f docker-compose.yml -f docker-compose.cli-auth.yml exec app claude-auth status
```

This starts service `app` and adds the persistent `claude-auth` volume. The profile exposes port `3456` internally; connect LiteLLM through an appropriate Docker network or publish the app port in your deployment configuration for a separate host. The overlay targets `app` and cannot be applied directly to `compose.adapter.yml`.

The login command prints an official authorization URL. Complete browser sign-in, then paste the final OAuth callback code into the same waiting terminal. `CLAUDE_AUTH_EMAIL` only prefills the email address. An email sign-in code belongs on the official website, not in the CLI callback prompt.

The overlay selects `UPSTREAM_AUTH_SOURCE=claude_cli`, which reads the CLI authentication store without falling back to database or environment credentials. The alternative `configured` mode selects a stored database credential first, then `CLAUDE_CODE_OAUTH_TOKEN`, then `ANTHROPIC_API_KEY`.

`CLAUDE_AUTH_AUTO_REFRESH=true` enables the background refresh coordinator for `claude_cli` mode. It uses the official CLI exchange when credentials become due. `claude-auth refresh` invokes the same due check manually; `claude-auth status` inspects local state without making an inference request.

Persist application data and the authentication volume. Managed refresh for the same account can preserve replay continuity; a new login, account change or external credential replacement may require a fresh conversation. See the [authentication and refresh lifecycle](docs/CONTAINER-AUTH.md) for commands and recovery. Container login does not change provider access rules or guarantee acceptance of every client/model workflow.

## Connect a separate LiteLLM gateway

Register distinct Messages and Responses routes. Messages uses the proxy root as its API base; the OpenAI Responses provider uses `/v1`.

```yaml
model_list:
  - model_name: claudemock-opus-messages
    litellm_params:
      model: anthropic/claude-opus-5-5
      api_base: http://YOUR_PROXY_HOST:13456
      api_key: os.environ/CLAUDE_PROXY_API_KEY
  - model_name: claudemock-opus-responses
    litellm_params:
      model: openai/claude-opus-5-5
      api_base: http://YOUR_PROXY_HOST:13456/v1
      api_key: os.environ/CLAUDE_PROXY_API_KEY
    model_info:
      mode: responses
      supported_endpoints: ["/v1/responses"]
```

Set `CLAUDE_PROXY_API_KEY` in the LiteLLM environment to the proxy key created above. Clients use their own LiteLLM key and the corresponding registered model alias. Adapt the upstream model ID to your account's available models; a catalog entry alone is not proof of inference access.

Keep the exact bases above to avoid `/v1/v1/messages`. The Responses route uses LiteLLM's native OpenAI Responses provider rather than converting Responses through an Anthropic Chat Completions route. No LiteLLM or client source patch is required for this configuration.

The existing LiteLLM **1.109.0** deployment was verified with Responses and its standard `/v1/responses/compact` route. See the [gateway guide](docs/LITELLM-NATIVE-RESPONSES.md), [configuration example](integration/litellm/native-responses.example.yaml), and [client profiles](integration/clients/profiles/README.md). Their deployment-specific aliases and ports are examples, not required names.

For a bounded acceptance test, disable retries and cross-model fallbacks so requests can be attributed to one route. The compact test harness offers `--litellm-no-retries`; its LiteLLM-only request fields should not be sent directly to claudemock.

## Context, thinking, caching and compaction

The caller owns conversation history and executes its own tools. The CLI backend reuses a matching live session. When the caller supplies changed, compacted or restarted history, a version-pinned resume adapter can import native roles, completed tool results and supported signed thinking blocks. Worker sessions are not a durable conversation database.

Responses replay state preserves supported native thinking and redacted-thinking blocks inside authenticated opaque capsules. Return these items unchanged with the conversation. The proxy does not invent signatures, repair altered thinking or silently discard it to force a request through.

Three compaction flows are distinct:

1. **CLI automatic compaction** manages the genuine CLI session as its context grows.
2. **Client-local compaction** asks for a summary and sends a replacement history; the adapter supports the qualified client flow.
3. **Standalone `/v1/responses/compact`** summarizes supplied history through the CLI and returns a canonical replay window containing authenticated compacted state and retained context.

For standalone compaction, replace old conversational input with the **entire returned `output` array**, then append the next input. Keep item order and resend top-level `instructions` on later requests. Do not extract a visible summary or turn opaque state into a prompt. The [compaction guide](docs/RESPONSES-COMPACTION.md) includes a complete request/replay example and limits.

Replay requires the same supported model, proxy principal/account scope and state key within the configured TTL. Compact output can be used after a proxy restart without the original live worker. Changing account or state policy can invalidate earlier capsules.

Codex **0.160.0** uses local compaction for the tested custom-provider configuration; adding the standalone endpoint does not automatically make that client call it. Client support must be evaluated separately from endpoint support.

Caching is performed by the provider. Keeping compatible history and reporting cache usage helps inspect reuse, but does not guarantee a cache hit or establish an invoice amount. CLI internal compaction usage is tracked separately from the context reported on the wire. A very short history may become larger after compacting it.

## Configuration and boundaries

| Setting | Default / purpose |
| --- | --- |
| `UPSTREAM_TIMEOUT_MS` | `300000` |
| `CLAUDE_CLI_MAX_SESSIONS` | `8` live worker sessions |
| `CLAUDE_CLI_SESSION_TTL_SECONDS` | `3600` |
| `RESPONSES_ENABLED` | `false`; explicit opt-in |
| `RESPONSES_STATE_TTL_SECONDS` | `604800` (7 days) |
| `RESPONSES_MAX_OUTPUT_TOKENS` | `8192` |
| `RESPONSES_DEVELOPER_MESSAGE_MODE` | `reject`; optional `hoist` moves supported developer instructions to the leading system context |
| `RESPONSES_APPLY_PATCH_MODE` | `reject`; optional `validated` accepts the pinned Codex patch grammar and checks completed output |

`validated` is output validation, not constrained decoding. Developer relocation changes instruction placement; it is an explicit compatibility choice. Details and unsupported cases are in the [Responses adapter contract](docs/RESPONSES-ADAPTER.md).

The request body limit is 10 MiB; decoded compaction state has a separate 7 MiB limit. CLI mode has bounded message, tool and control support. HTTP mode preserves native payloads according to its relay contract; CLI and Responses paths translate protocol concepts and are not byte-for-byte native forwarding. See [native relay behavior](docs/ADAPTER-PATCH.md) and [model-specific behavior](docs/MODEL-COMPATIBILITY.md).

New request history records contain operational metadata rather than conversation bodies, opaque replay capsules or raw provider errors. Existing databases can still contain historical rows and configured upstream credentials; protect their volumes and backups. The optional admin dashboard is a separate service and is not started by either minimal app command above.

## Verified behavior and remaining coverage

The latest qualification used Claude Opus 5.5 through an unchanged LiteLLM 1.109.0 gateway. The [2026-11-13 evidence](docs/evidence/20261113-responses-compact.json) records:

- **299 Linux checks passed:** 63 CLI/worker checks and 236 HTTP/state/admin checks.
- Six live HTTP 200 responses covering a tool call, tool result, compact, replay, a second compact and cold replay.
- The original conversation was discarded after compaction; exact project and tool-ledger facts were recovered from the returned window.
- After restarting the proxy, cold replay succeeded with zero live CLI sessions beforehand.
- The first wire window shrank from 24,869 to 3,444 JSON bytes. A later short window grew slightly, from 3,909 to 3,976 bytes.
- The two replay requests reported 2,862 and 3,001 input tokens, including 1,653 cache-read tokens each.

The live compact fixture emitted no pre-compaction reasoning item, so it does **not** establish live signed-thinking preservation across compact. Exact signed and redacted-thinking replay is covered by scripted tests. These results qualify the tested model, route and client versions, not every API feature or coding client.

See the [compact test report](docs/RESPONSES-COMPACTION.md), [Opus project editing and automatic compaction evidence](docs/OPUS-PROJECT-AUTO-COMPACTION.md), [acceptance record](docs/ACCEPTANCE.md) and [verification guide](docs/VERIFICATION.md) for detailed procedures and historical limits.

## Upgrades and the repository rename

For an existing clone:

```sh
git remote set-url origin https://github.com/binary1215/claudemock.git
git fetch origin
```

The repository rename does not require renaming runtime services, package identifiers, containers or volumes. Those identifiers remain compatible with existing deployments.

If you also rename a local checkout directory, retain the deployment's existing Docker Compose project name: Compose may otherwise select different prefixed volumes. Preserve the application database, authentication store and Responses state key. Do not use `docker compose down -v` as an upgrade step. Follow the [deployment lifecycle guide](integration/deployment/README-lifecycle.md) for backups, rollout and rollback.

## Development

Use Node.js 22 and install the CLI worker dependencies separately:

```sh
npm ci
npm run install:cli
npm test
node --test --test-concurrency=1 integration/cli-backend/*.test.mjs
```

These checks use local fixtures rather than live provider inference. `npm run test:cli` is also available; the explicit serial command keeps fixture memory use bounded. The optional admin app has its own `npm ci` and `npm run build` under `admin/`. Live client and gateway checks are opt-in; see the [client test guide](integration/clients/README.md).

| Path | Responsibility |
| --- | --- |
| `src/` | HTTP routes, authentication, native relay, Responses translation and replay state |
| `integration/cli-backend/` | Genuine CLI worker and client-tool broker |
| `integration/clients/` | Client profiles and acceptance harnesses |
| `integration/litellm/` | Separate gateway configuration examples |
| `admin/` | Optional administration dashboard |
| `docs/` | Contracts, operating guides and qualification evidence |

MIT for this repository; dependencies retain their own licenses and terms. See the [Codex-derived grammar notice](licenses/CODEX-NOTICE.md) for its attribution and license.
