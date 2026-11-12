# CLI inference and context management

Genuine Claude CLI inference is the default. The source default and normal Docker
build select `CLAUDE_INFERENCE_BACKEND=cli`. The full image includes the pinned
Agent SDK0.3.322 and official CLI2.1.322. Login and automatic token refresh remain
in the HTTP process; the inference worker receives only a scoped loopback nonce.

```text
Client -> unchanged LiteLLM -> Messages / Responses facade
  -> genuine Agent SDK / CLI -> private native HTTP forwarder -> provider

CLI MCP tool intent -> client tool_use / function_call -> client executes
caller result -> exact native call ID -> CLI continues
```

The CLI owns its actual request and system preset. Caller system text is appended
through the SDK option. Built-in file, shell, web and agent tools are removed;
only caller-declared tools are registered in an owned MCP server. No captured
official prompt is transplanted into ordinary HTTP requests. The backend never
automatically switches models, accounts or inference backends after rejection.

## Defaults and operation

```sh
docker build -t claude-proxy:cli .
# Development outside Docker:
npm ci
npm run install:cli
npm run build
npm start
```

An explicit HTTP deployment remains available:

```sh
docker build --target http -t claude-proxy:http .
# Also select CLAUDE_INFERENCE_BACKEND=http in the process/container environment.
```

The `cli-auth` target is a separate HTTP/auth-only image. The
[docker-compose.cli-auth.yml](../docker-compose.cli-auth.yml) login overlay now
selects the full default image while retaining the existing Claude auth store
and refresh settings. Keep the data volume, auth volume, API keys and Responses
state key when replacing a production container.

[compose.cli.yml](../compose.cli.yml) can run a separate CLI facade through an
existing authorized HTTP relay. Use the [private environment template](../.env.cli.example);
its relay URL/key stay private. Stop that validation facade before changing its
upstream relay into another CLI facade, to avoid unintended nested inference.

## Conversation continuity

Exact visible caller history reuses a live CLI session. JSON key order, string
content normalization, direct-tool caller defaults, null toolsets and empty
citations have equivalent history representations. Signatures, substantive
metadata, block order, tool IDs and original arguments are retained.

When controls, tools or history change, or a worker has expired/restarted, the
complete caller-supplied native history can seed a new CLI session. The importer
preserves user/assistant roles, thinking/signatures/redacted blocks and completed
tool pairs. It does not turn the conversation into a textual user prompt.
Historical tools are renamed to their deterministic MCP transport names and
arguments are wrapped, but those tools are not registered merely because they
appear in history. A guarded private continuation triggers the resumed inference.
The forwarder removes its exact nonce and associated CLI-generated
`No response requested.` assistant row on every replay. Those are resume
bookkeeping, not caller history: forwarding them would incorrectly mark the
caller's last request as answered. The current caller input appears only once.

This importer uses the SDK's alpha `SessionStore.load` resume transport and a
**pinned internal CLI transcript-entry format**. It is not an officially stable
arbitrary-history API. Keep the CLI/SDK versions matched and rerun the actual-CLI
tests before upgrading. Imported mode requires local SDK transcript writes:
these stay in the owned temporary runtime directory, and the directory is
deleted when its worker closes. The default directory is under `/tmp` in Docker,
which the supplied Compose files mount as tmpfs. Ordinary live sessions use
`persistSession:false`; the relay history DB never stores conversation content.

Completed tool results must be imported with their calls. Otherwise the CLI can
substitute an interrupted-call result. Normal live tool waits resume by exact
native IDs, including identical parallel calls and caller errors. A successfully
imported continuation retires a matching old pending worker whose calls were
already completed, so scope changes do not accumulate abandoned tool waits.

At the worker limit, the least-recently used idle worker can be evicted even if
it is waiting for a caller-owned tool. That tool runs in the client; its pending
worker is a history cache, not an active inference request. The next complete
history imports the actual result and original signed blocks. Busy workers and
active upstream calls are never evicted. `cli_capacity`503 therefore means all
slots have active requests, rather than idle tool waits filling the pool.

Native per-message `role:system` text stays at its conversation position; it is
not moved to top-level system or demoted to user content. The pinned importer
uses system-role attachment carriers and the private HTTP forwarder restores
the caller's original text blocks/cache markers and per-message effort. Carrier
markers never belong in the provider prompt. New system turns import the full
history; an unchanged system prefix can continue on its existing live worker.
CLI compaction replaces its transcript and can discard imported attachment
rows. After that replacement, the forwarder explicitly reattaches active caller
system instructions after the new summary. Expired caller text stays omitted;
the compacted prompt position and cache prefix can change.

`clear_at:next_user_message` is resolved against **caller** user messages. The
SDK adds its own resume/compaction helper users, so copying that field literally
would expire an active caller instruction too early. The forwarder sends active
text with `clear_at:never` for that call; after a later caller user it omits the
expired text, retaining an independent output-config control where present.
This is a semantic CLI adaptation, not a byte-preserving native transport.
Expiring text changes the rendered cache prefix. `never`/default lifetimes and
cache blocks remain unchanged; per-message tool additions/removals are outside
this text-only system-message contract.

## Caching and compaction

CLI owns cache markers and context rendering. Verify actual
`cache_read_input_tokens` and `cache_creation_input_tokens`; repeatable request
format alone is not proof of a cache hit. Caller cache TTLs are not a literal
transport guarantee in CLI mode. A changed/compacted prefix can cause a cache
miss, followed by cache hits as its new context is reused.

The backend enables genuine CLI automatic compaction. Pre/PostCompact hooks
coordinate the private forwarder, and a confirmed `compact_boundary` distinguishes
an actual compact from a skipped/failed attempt. Recent rounds can be protected;
a PreCompact event alone does not prove that compaction ran. Idle/precomputed
compaction is disabled so internal model calls belong to an active caller turn.
The optional `CLAUDE_CLI_AUTO_COMPACT_WINDOW` sets the SDK's documented policy
window (100000–1000000 tokens); unset keeps the model's own setting.

Client-side local compaction is also supported: its summary request may retain
the previous signed/tool history while removing current tools. The resulting
summary starts a fresh context, and subsequent assistant/thinking/tool history
continues from it. Codex local compaction uses ordinary Responses calls; this
does not implement the separate OpenAI `/responses/compact` endpoint.

Compaction can make multiple real model requests. Client response usage describes
the **current inference context** so client context estimates are not inflated.
The admin request history sums actual model calls, including internal compaction.
Failed/cancelled inference retains known compaction subtotals as partial usage.
SDK cumulative result counters are not added again. Compression is a model
summary, not a guarantee of perfect semantic retention.

## Protocol controls and limits

- Native Messages and enabled Responses support JSON/SSE, caller tools and opaque
  thinking replay. Responses still requires its persistent state key and the
  existing explicit developer-hoist/apply_patch modes where needed.
- Effort can change through the SDK's live settings. Changed output ceilings,
  instructions or tool definitions can use the native-history import path.
- Explicit `thinking.display:updates` uses the public native display option and
  required beta in the private forwarder. The SDK's option union does not yet
  contain this value, so its normal display default is selected first; internal
  compaction keeps its own rendering policy.
- Native `thinking_delta.estimated_tokens` progress is kept separately in
  Responses `anthropic_metadata.thinking_progress`, including its cumulative
  per-frame estimate. It is not reasoning text, a signature or billable usage;
  provider `usage.output_tokens` remains authoritative.
- Forced tool choice, serial-only tool choice, sampling/stop overrides and native
  server-tool types remain HTTP-backend capabilities.
- Caller results support text and base64 images. CLI/MCP can resize, shorten or
  spill large output. Arbitrary byte-exact large tool output is unqualified.
- CLI `count_tokens` remains501: raw caller counting would understate the expanded
  CLI context. The explicit HTTP backend retains its native endpoint.
- Capacity defaults to8 workers and idle TTL to3600 seconds. A caller must supply
  its full valid history for import; opaque Responses capsules must still be
  valid for the current model/principal/authentication/prefix scope.

## Verification

Run the historical HTTP regression suite with its explicit backend:

```sh
npm test
npm run test:cli
```

The CLI tests use the genuine pinned SDK/CLI against a scripted loopback provider.
They cover role/signature/tool preservation, JSON/SSE, native import after
compaction/control changes/restart, completed tool-result import, repeated
scope-changing tool cycles, automatic and manual compaction, and separate wire
context versus complete internal-call accounting. These tests do not measure
provider cache behavior or coding quality.

The [CLI-default release receipt](evidence/20261112-cli-default-compaction.json)
records the deployed image, real native/Codex client results, observed cache
reads and real manual compaction, separately from scripted automatic compaction.
The earlier optional-backend results remain historical in
[20261112-cli-inference.json](evidence/20261112-cli-inference.json).

The [managed LiteLLM client receipt](evidence/20261112-master-litellm-clients.json)
adds actual Claude Code tool/cache/compact/signed replay and Codex functional
tool/compact/follow-up checks. Native signed replay passed on the client-facing
wire. Managed Responses has an observed done/completed state inconsistency, so
Codex signed-state fidelity is not qualified by its functional pass.

The subsequent [native Responses model qualification](evidence/20261112-native-responses-opus.json)
uses Opus5.5 and the supported OpenAI Responses provider configuration. Actual
Codex passes item-done/final equality and exact signed-state replay in a genuine
post-compaction follow-up, with positive cache reads. This changes gateway model
routing, not the CLI backend image or LiteLLM/client source. See
[deployment instructions](LITELLM-NATIVE-RESPONSES.md).

The later [real Opus project and automatic-compaction qualification](OPUS-PROJECT-AUTO-COMPACTION.md)
passes actual file editing and follow-up tests in both required clients through
LiteLLM. It separately observes native-client auto compaction, two Codex auto
compactions with successful editing afterward, and same-session backend auto
compaction with real usage accounting. Test-only lowered thresholds make these
bounded cases reproducible; unchanged full-window longevity remains untested.
That trial also found and fixed idle pending-tool capacity exhaustion.

Primary interfaces: [Agent SDK](https://code.claude.com/docs/en/agent-sdk/typescript),
[sessions](https://code.claude.com/docs/en/agent-sdk/sessions),
[custom tools](https://code.claude.com/docs/en/agent-sdk/custom-tools),
[CLI context management](https://code.claude.com/docs/en/agent-sdk/skills#compact-history-with-compact),
[caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).
