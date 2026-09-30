# LiteLLM backend adapter patch

Base: `MehdiMohseni82/claude-code-proxy` commit
`4e2ce72ff9b7ed114780656ab4bcdeff55d0cd3f`.
Local branch: `codex/litellm-adapter-hardening`.

## Execution scope

Download, patch, and verify locally. No Claude authentication, live model calls,
remote deployment, or changes to an installed LiteLLM gateway were performed.
The subscription path remains research-only. No supplied credentials are stored
in this repository. Publishing this patch does not establish deployment readiness.

## Changes

- API authentication is fail-closed when no proxy keys have been provisioned.
  `AUTH_DISABLED=true` remains an explicit upstream escape hatch; the adapter
  Compose file fixes it to false.
- Server-side tools are disabled by default with `ALLOW_SERVER_SIDE_TOOLS=false`.
  The SDK receives `tools: []` even on plain-text requests. User-defined caller
  tools still use MCP interception and return calls to the client for execution.
- Legacy server-side tools require BOTH `ALLOW_SERVER_SIDE_TOOLS=true` and a
  key's built-in-tool grant. The server-tool mapping path now checks both too.
  The provided Compose never enables this legacy path.
- Request history retains metadata for existing statistics/budget code, but
  storage discards prompt previews, prompts, responses, and arbitrary errors.
  Error fields contain an allowlisted category only. Metadata is not a duplicate
  conversation history. SQLite settings/token persistence is preserved.
- Active tasks expose an empty prompt preview; error console logs contain fixed
  event names/status/types only. Raw errors may still be returned to the
  authorized caller for LiteLLM handling; this patch is not an output-redaction
  service.
- SDK `persistSession: false` requests no CLI session transcript persistence
  (supported by pinned SDK 0.1.77). This is not a universal SDK telemetry/cache
  audit. Error-classification text is bounded and transient in memory.
- Runtime image uses the `node` user. A separate API-only Compose publishes on
  an explicit LAN address and adds a read-only root filesystem, /tmp tmpfs,
  dropped capabilities, no-new-privileges, and an init process.
- `/v1` authentication, budget checks, and rate limits run once before route
  dispatch, rather than twice for Messages / three times for Embeddings.
- OpenAI plain-text streaming emits a classified SSE error and closes on SDK
  failure instead of leaving an already-started response open. After headers
  have been sent, HTTP status cannot be changed; clients must inspect SSE errors.
- Docker build context excludes environment files and local verification logs.

## Verification contract

`npm ci` then `npm test` (Node 22.3+ with experimental module mocks; local
verification uses Node 24). Tests use in-memory SQLite and a mocked Agent SDK;
only an ephemeral loopback HTTP listener is opened and closed. No real OAuth,
Anthropic, Ollama, or LiteLLM request is required.

Check fresh-install authentication, admin key bootstrap, both API key headers,
revocation, plain text, SDK tool/session settings, both server-tool entry paths,
caller parallel tools and IDs, follow-up tool results, buffered SSE,
failure classification, metadata-only persistence, active-task previews, and
synthetic token storage. Mocked SDK results verify our adapter mechanics only,
not Claude model behavior or installed client compatibility.

## Recorded local verification (2026-09-30)

- `npm ci`: successful; native SQLite dependency installed.
- `npm test` on Windows / Node 24.18.0: TypeScript build and **19/19 tests pass**.
  Includes plain-text SSE termination, upstream SSE errors, single rate-limit
  accounting, and legacy global opt-in still requiring the API-key grant.
  Both OAuth-style and API-key-style synthetic credentials reach only the
  corresponding mocked SDK environment variable, never request history.
- `git diff --check`: successful.
- `docker compose -f compose.adapter.yml config --quiet`: successful using a
  synthetic admin secret and explicit LAN bind IP.
- Docker image build/runtime: **not performed**; local Docker Linux-engine pipe
  is unavailable. No daemon was started and no remote host was modified.
- Temporary HTTP test listeners were closed; spawned npm/test processes exited.
- `npm audit --omit=dev`: **3 vulnerable production packages remain** (low 1,
  moderate 2). Upstream lockfile/dependency versions were not blindly upgraded:
  `body-parser` ([advisory](https://github.com/advisories/GHSA-v422-hmwv-36x6)),
  `qs` ([advisory](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g)),
  `uuid` ([advisory](https://github.com/advisories/GHSA-w5hq-g745-h8pq)).
  These need a bounded dependency update and repeat verification before
  production readiness is claimed. Audit detections are not proof that each
  affected code path is reachable in this adapter.

SDK module mocks are an experimental Node test feature; they do not start the
Claude CLI and do not validate the actual SDK's subprocess behavior. No login,
live subscription request, LAN call, or LiteLLM E2E was made.

## Later deployment (not performed)

Use `compose.adapter.yml` rather than upstream's full nginx/admin/certbot stack.
Set `PROXY_BIND_IP=<proxy-host-LAN-IP>`, `PROXY_PORT=13456`, and a dedicated
`ADMIN_API_SECRET` outside version control. The API key is provisioned through
the authenticated `/api/admin/keys` endpoint before any `/v1/*` request works.
The admin API remains on the same authenticated listener; it is not network-hidden.
The caller's key must never be the Claude token.

LiteLLM is on another host: use `http://<proxy-host-LAN-IP>:13456`, not a Docker service
name. The intended provider is `anthropic/claude-sonnet-4-6`; inspect and test
LiteLLM's actual `api_base` joining and Responses conversion before registration.
Proxy `/health` is a configuration/liveness report, not proof of Claude auth.

Existing volumes containing historical conversations are NOT scrubbed. This
patch prevents new writes; old data needs a separately authorized cleanup. Old
root-owned data volumes require deliberate permission migration before using
the non-root image. Do not delete or reset credential volumes.

## Known limitations retained from upstream

- No OAuth login or access/refresh-token lifecycle manager was added.
- Tool histories are reconstructed as text, not a native conversation resume.
- Tool-path SSE is buffered rather than token-by-token streaming.
- `tool_choice`, token limits/sampling options, multimodal inputs, and thinking
  are not fully supported. Some unsupported fields are ignored by upstream.
- No native `/v1/responses`; LiteLLM conversion and each real client require E2E.
- Policy eligibility of an SDK subscription proxy is not established by these
  tests. Official SDK subscription usage and credential-intermediation rules
  must be considered separately.

Local Docker daemon availability, image build/non-root SDK execution, and LAN
reachability must be verified before claiming deployment readiness.
