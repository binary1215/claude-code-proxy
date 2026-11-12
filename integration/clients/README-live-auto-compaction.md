# Genuine Claude Code automatic compaction

`claude_auto_compact_live.mjs` is an independent, genuine Agent SDK 0.3.322 /
Claude Code 2.1.322 consumer. It exercises **client-owned automatic compaction**
through the existing native Messages model alias. It never submits a manual
compact command, changes the client/SDK source, rewrites a model request or
response, or inflates provider usage/count-token results.

The test uses the official `settings.autoCompactWindow: 100000` and
`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=10`. The smaller percentage is a **test-only
trigger threshold**, not a claim that the model has a smaller context window.
The receipt records the SDK-reported threshold and context using the official
`getContextUsage({detail: 'summary'})` control, separately from the requested
percentage and observed compaction boundary. The SDK display may not incorporate
the percentage override: the actual Opus run reported82904 there while an auto
boundary occurred at24472 tokens. That summary combines the last real response
usage with local estimates; separately recorded SSE counters are the actual
counters the gateway returned. Missing counters stay null.

This is not proof of longevity at an unchanged, default full model window.
Client automatic compaction, Codex local automatic compaction and the Han CLI
backend's own automatic compaction are three separate tests.

## Inputs and execution

Install the isolated dependencies in `integration/cli-backend` if the selected
runtime image does not already contain them. Use the pinned official CLI. Send
the gateway key only through stdin from the existing authorized credential
owner; never put it in arguments, source, or the receipt.

Supply these exact public source files from the selected revision in a separate
read-only context mount, retaining their relative paths:

- `integration/cli-backend/worker.mjs`
- `integration/cli-backend/history.mjs`
- `src/services/cliSessions.ts`

Example non-secret arguments:

```sh
node /app/integration/clients/claude_auto_compact_live.mjs \
  --base-url http://192.168.0.7:4000 \
  --model claude-opus-5-5-han \
  --canonical-model claude-opus-5-5 \
  --cli-path /usr/local/bin/claude \
  --context-dir /source-context \
  --context-file integration/cli-backend/worker.mjs \
  --context-file integration/cli-backend/history.mjs \
  --context-file src/services/cliSessions.ts
```

The `--base-url` is the gateway origin. A passive localhost observer forwards
the genuine client's native `/v1/messages` requests and SSE bytes unchanged.
It accepts the configured public model alias and canonical model ID, rejecting
other models. The caller-owned MCP fixture reads only the explicit source list
(at most 128,000 bytes), supplies it once with a remembered fixture code/value,
and does not run project tools. No secret-directory scan occurs. The receipt
records source paths, sizes and hashes, not source content.

Run in an isolated consumer container with fresh cwd/config under tmpfs and no
production auth volume. Keep the operating Han and LiteLLM settings unchanged.
The overall watchdog is 900 seconds and the maximum is 12 external Messages
requests, including genuine client-generated compaction model requests. Normal
short user turns age the source/tool history out of the CLI's protected recent
rounds. A skipped PreCompact attempt alone is not success.

## Evidence and result meaning

The test requires actual SDK PreCompact/PostCompact hooks with `trigger: auto`
and a genuine `compact_boundary` with `trigger: auto`. It then checks retention
of the tool-returned code/value, a computed checksum, and three real exported
source identifiers, followed by another cached inference. It never puts the
remembered target values or source identifiers into those retention prompts.

- `functional_pass`: genuine tool execution, expected replies and retained data.
- `automatic_compaction_pass`: genuine automatic hooks/boundary, no manual trigger.
- `ok`: both of the above; absent compaction is an honest unsuccessful auto test.
- `qualification_pass`: automatic compaction plus actual positive warm/post-cache
  counters and nonvacuous signed-thinking/redacted-block replay observation.

Thinking and signatures are hashed in memory and compared with later actual
client-to-gateway assistant blocks. The receipt contains no raw thinking,
signature, summary, response text, key or raw error. If none was emitted,
signed-replay coverage is null and remains unqualified. The gateway-to-Han
transport is outside this observer's scope.

## Separately exercising the proxy backend

`integration/cli-backend/helpers.mjs` deliberately copies only a small environment
allowlist, so adding `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` to the proxy container alone
does not pass it to its real CLI subprocess. Do not change operating settings
or add a production feature solely for this test.

An isolated test entrypoint can import the unchanged exported `CliWorker` and
the genuine SDK `query`, supply the same stdin IPC wrapper as `worker.mjs`, and
use its existing `queryFactory` seam only to add the documented environment
variable to `options.env`. Use the existing `CLAUDE_CLI_AUTO_COMPACT_WINDOW=100000`
and `CLAUDE_CLI_WORKER_PATH` for that isolated container. The broker, live session
registry, transcript importer, private upstream forwarder, genuine SDK/CLI and
actual provider accounting stay unchanged. Record that this is an explicitly
configured test entrypoint, not verification of the operating default window.

Official references: [Claude Code environment variables](https://code.claude.com/docs/en/env-vars),
[Agent SDK TypeScript reference](https://platform.claude.com/docs/en/agent-sdk/typescript).
