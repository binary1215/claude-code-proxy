# Optional genuine CLI inference

The user-selected architecture keeps the HTTP relay as the default and adds a
separate opt-in CLI backend. `CLAUDE_INFERENCE_BACKEND=cli` changes inference for
Messages and enabled Responses. Model discovery still uses the configured HTTP
upstream. This is a state-owning adapter, with different capabilities from the
literal native HTTP relay.

## Components

```text
Coding client -> unchanged LiteLLM -> CLI backend HTTP facade
  -> official Claude Agent SDK/CLI -> private loopback native HTTP forwarder
  -> authorized upstream (or the existing HTTP relay) -> provider

CLI MCP tool intent -> HTTP tool_use/function_call -> calling client executes
caller tool_result -> exact native call ID -> CLI continues its own history
```

The SDK owns genuine CLI instructions and model requests. Caller system text is
appended using the documented preset/append option. The backend does not copy a
captured official prompt into ordinary HTTP requests. Built-in CLI file, shell,
web and agent tools are removed. Only caller-declared tools are exposed through
an owned in-process MCP server; their implementations wait for caller results.

A PreToolUse hook attaches the native call ID outside the original argument
schema. The MCP transport unwraps original arguments at the client boundary and
returns the real caller result, including `isError`. Identical parallel calls
are correlated by IDs, not names or execution order. Actual native stream events
carry thinking/signatures; per-block SDK assistant envelopes are not accumulated
as if each were a complete reply.

Provider credentials stay in the HTTP process. Each worker gets only a scoped
random loopback credential. The forwarder resolves current upstream credentials
for every model call using the existing refresh path. A caller turn permits one
configured-model request; CLI attempts to retry, fall back or run another model
are not forwarded. There is one history/usage row per external request, with no
duplicate internal-relay accounting. Conversation content is not written to the
relay history DB. SDK transcript persistence is disabled.

## Container setup

Build the explicitly selected image with matching pinned versions:

```sh
docker build --target cli-inference --build-arg CLAUDE_CODE_VERSION=2.1.322 -t claude-proxy:cli .
```

The optional package pins Agent SDK0.3.322, Anthropic SDK1.8.0, MCP SDK1.32.2 and
Zod4.6.7 in a separate lockfile. Default HTTP images do not install these packages.
The optional image selects the installed official CLI executable explicitly.

Use [compose.cli.yml](../compose.cli.yml) with a private copy of
[.env.cli.example](../.env.cli.example). `CLAUDE_RELAY_URL` and
`CLAUDE_RELAY_API_KEY` may point at the existing authorized HTTP relay. Its login
and refresh continue to be managed there; this arrangement needs no shared auth
volume. Keep the underlying provider account unchanged while a CLI conversation
is live, and start fresh conversations after changing accounts or backend mode.
The optional service has its own data volume and proxy keys, provisioned through
the existing authenticated admin API. A separate upstream container is an
operator choice, not an automatic routing fallback.

## Session and protocol limits

- Both native Messages and the existing Responses conversion are supported,
  including SSE, caller tools and opaque thinking replay. Caller history must
  match a live session after JSON-key/string normalization and equivalent native
  defaults (direct-tool caller, null toolset and empty citations). A different
  principal, model, instruction prefix, tool schema, thinking configuration or
  maximum output setting starts a different scope. Caller history is never
  silently substituted with an unrelated CLI session.
- The initial request starts a fresh user conversation. Arbitrary old assistant
  histories cannot be imported into a new CLI process through the public SDK.
  Idle sessions expire after3600 seconds by default. At capacity, the oldest
  idle session without a pending caller tool is released. Pending/active work is
  not evicted to admit another session. Capacity defaults to8 and is configurable.
- Restart, eviction, expiry, branching, changed prefixes or caller compaction
  produce409 when the supplied history has no matching live session. There is
  no transcript database or automatic history reconstruction. This does not
  qualify automatic coding-client compaction or restart recovery.
- Maximum output is fixed for a session, up to the model's supported value.
  Effort can change through the documented SDK session-setting method. Forced
  tool choice, sampling overrides and stop-sequence overrides require the HTTP
  backend. `top_k` and serial-only `disable_parallel_tool_use:true` also require
  HTTP. Ordinary auto tool choice and initial `none` are supported.
- The pinned SDK accepts adaptive/enabled/disabled thinking and supported manual
  budgets, with display `summarized` or `omitted`. Explicit beta display `updates`
  is supported by the HTTP backend, but not this SDK option contract. CLI owns
  its internal cache markers and context rendering; it does not honor caller
  cache TTLs as a literal HTTP request would.
- Caller tool results support text and base64 images. Other result block types
  are not silently converted. CLI/MCP can normalize, resize or spill large tool
  outputs: successful text defaults to a50000-character spill threshold; this
  broker requests the documented500000-character ceiling. Error output can be
  shortened by CLI, so arbitrary byte-exact large-result replay is unqualified.
- `/v1/messages/count_tokens` returns501 in CLI mode: counting the raw caller
  payload would misrepresent the CLI-expanded context. The HTTP backend keeps
  its existing endpoint.

Relevant settings are `CLAUDE_CLI_SESSION_TTL_SECONDS`, `CLAUDE_CLI_MAX_SESSIONS`,
`CLAUDE_CLI_RUNTIME_DIR`, `CLAUDE_CLI_WORKER_PATH` and optional
`CLAUDE_CLI_EXECUTABLE`. These are operator settings, not request-supplied code.

## Validation

The worker's pure fake-SDK/MCP suite passes11 tests. A real pinned SDK/CLI against
a loopback scripted provider passes15 HTTP integration tests: native continuity,
Responses JSON/SSE and ID-less opaque replay, reversed identical parallel calls,
Responses function-tool round trips, error results, mixed tool results/instructions, invalid-result recovery, actual
128000 output setting, live effort change, independent identical histories,
429 preservation, disconnect cancellation and content-free single-row history.
Two private-forwarder tests verify same-session nonce continuity
through a synthetic OAuth refresh and cancellation while refresh is pending.
Four write tests cover cancellation while a connected client stops reading,
normal drain and close cleanup. The complete Linux Docker suite passes248/248
without provider network access. Windows verification passes247 tests with one
Linux-only helper skipped (244-test combined run plus four write tests).

The final experimental image also passed three real Haiku5.5 requests through
the existing Han HTTP relay: caller `demo_add(2,3)` intent, caller-computed result
`5` followed by the expected final reply, and a separate Responses SSE reply.
The continuation reported2772 cache-read tokens and106 cache-write tokens.
These simple requests emitted no thinking blocks; real signed-thinking replay
is not qualified by this run. The actual-CLI loopback suite verifies replay
using synthetic provider signatures. Actual OAuth-expiry turnover, production
coding clients, compaction and coding quality remain unqualified for this backend.

The live tests exposed two adapter issues that are now covered: nullable official
`context_management` response metadata and history matching of direct-tool
defaults omitted by Responses. Native bodies on the HTTP backend remain literal.
The default Docker target was separately checked to select HTTP and omit the SDK.
Han's operating image and startup time were unchanged, and temporary test
containers were removed. See the [sanitized verification receipt](evidence/20261112-cli-inference.json).

```sh
npm run build
node --test tests/*.test.mjs
npm --prefix integration/cli-backend ci
node --test integration/cli-backend/*.test.mjs
```

Official interface references: [Agent SDK](https://code.claude.com/docs/en/agent-sdk/typescript),
[custom tools](https://code.claude.com/docs/en/agent-sdk/custom-tools),
[streaming](https://code.claude.com/docs/en/agent-sdk/streaming-output),
[sessions](https://code.claude.com/docs/en/agent-sdk/sessions) and
[MCP limits](https://code.claude.com/docs/en/mcp).
