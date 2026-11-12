# Genuine proxy backend automatic compaction

`backend_auto_compact_live.mjs` exercises the real proxy CLI session registry,
caller-tool broker, history matching, private upstream forwarder and pinned
official SDK/CLI against an actual Opus model. It tests **backend-owned automatic
compaction**. Client-side Claude Code and Codex compaction through LiteLLM are
separate qualification cases.

The isolated entrypoint `backend_auto_compact_worker.mjs` imports the production
`CliWorker` and delegates its existing `queryFactory` seam to the genuine SDK
`query`. It adds only the official `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=10` setting and
read-only hook/context observers. The registry, worker logic, provider requests
and actual usage counters remain unchanged. It never submits a manual compact
command or supplies invented token counts.

## Isolated execution

This is an explicitly enabled live test, not part of the automatic unit suite.
Build the selected proxy revision and install the pinned dependencies under
`integration/cli-backend`. Run the container layout under `/app`, with the
official CLI at `/usr/local/bin/claude`. Keep the operating process, settings,
database and session runtime out of the test container.

Mount exactly these selected public source files read-only under `/source-context`
**by basename**:

| Original file | Mounted file |
| --- | --- |
| `integration/cli-backend/worker.mjs` | `/source-context/worker.mjs` |
| `integration/cli-backend/history.mjs` | `/source-context/history.mjs` |
| `src/services/cliSessions.ts` | `/source-context/cliSessions.ts` |

The harness limits source input to 128,000 bytes and records hashes/sizes only.
It deliberately reads this fixed list rather than scanning a project or secret
directory. The receipt labels files by their original repository paths.

The test uses the existing credential resolver with an authorized official CLI
credential store mounted **read-only** at `/operating-auth`. No token is supplied
in command-line arguments, copied into a file or exported to the worker. The
HTTP parent reads the store in memory; the worker receives the normal scoped
loopback credential. This harness does not log in or refresh credentials.
Missing credentials fail the test instead of initiating authentication.

Use fresh writable tmpfs mounts for `/tmp`, `/app/data` and `/home/node/.claude`,
an otherwise read-only filesystem, the image's non-root user, no added Linux
capabilities, no published ports, and bounded memory/process resources. Do not
mount the operating database or session directories. Configure these non-secret
environment values only in the isolated test container:

```sh
BACKEND_LIVE_TEST_RUN=approved
DATABASE_PATH=:memory:
AUTH_DISABLED=true
UPSTREAM_AUTH_SOURCE=claude_cli
CLAUDE_CONFIG_DIR=/operating-auth
CLAUDE_AUTH_AUTO_REFRESH=false
ANTHROPIC_BASE_URL=https://api.anthropic.com
CLAUDE_INFERENCE_BACKEND=cli
CLAUDE_CLI_WORKER_PATH=/app/integration/clients/backend_auto_compact_worker.mjs
CLAUDE_CLI_RUNTIME_DIR=/tmp/backend-cli-runtime
CLAUDE_CLI_AUTO_COMPACT_WINDOW=100000
CLAUDE_CLI_EXECUTABLE=/usr/local/bin/claude
UPSTREAM_TIMEOUT_MS=180000
RESPONSES_ENABLED=false
```

Then run `node /app/integration/clients/backend_auto_compact_live.mjs`. The
entrypoint does not start an HTTP server. Preserve a unique start receipt before
launch, apply an outer container timeout, capture only its sanitized JSON report,
and remove only the uniquely owned test container on exit. Never automatically
retry a failed or uncertain live run. Raw SDK stderr, prompts, response text,
thinking, signatures and credential values do not belong in published evidence.

The watchdog is 900 seconds. The driver reserves room before new turns and
targets at most 12 actual provider calls. An SDK compaction may issue multiple
internal calls within one turn, so the receipt reports observed calls; the
post-turn count check is not a hard preflight cap on every internal request.

## What passing establishes

The model reads the three actual source files through one caller-owned tool
result, remembers a fixture code/value and solves a numeric problem. After
genuine automatic compaction it must retain that data, a derived checksum and
three exported source identifiers. The later prompts do not supply those
answers. The test checks a subsequent cached inference as well.

- `functional_pass`: expected tool behavior, replies and retained state.
- `automatic_compaction_pass`: genuine `trigger: auto` PreCompact/PostCompact
  hooks and compact boundary, no manual compaction, and one continuing backend
  session. Recovery into a fresh session cannot satisfy this condition.
- `cache_qualified`: positive actual warm and later cache-read counters.
- `ok`: functional and automatic-compaction qualification.

Returned native thinking/redacted blocks are hashed in memory and compared with
later caller histories submitted to the registry. This verifies caller-to-registry
preservation; it is not a second observer of provider-wire signatures. Counters
and booleans are published, never the blocks themselves. Zero emitted blocks
would give no signed-state coverage even if other checks passed.

Each round compares the registry's aggregate `turnUsage` against all actual
internal provider requests, including compaction. The native response's usage
must match its inference request alone. Including compaction usage in the wire
context count would spuriously trigger more client compaction. Missing counters
remain null rather than being invented as zero.

## Actual Opus result and limits

The [sanitized execution evidence](../../docs/evidence/20261112-opus-auto-backend.json)
records six actual Opus 5.5 provider calls in one live backend session:

- Genuine automatic boundary: **24,032 -> 1,383 tokens**, 22,649 dropped.
- Tool/source/calculation state retained; native blocks returned 2, replayed 4,
  zero mismatches at the observed boundary.
- Warm inference cache read 1,598; later cache read 3,914.
- A compaction-plus-inference turn accounted for 23,086 aggregate input tokens
  while the inference response reported its own 2 input tokens. All observed
  aggregate counters matched the actual internal requests.

This used `autoCompactWindow=100000` and the official 10% environment override.
The SDK context summary separately displayed its baseline threshold of 82,904;
that display did not incorporate the percentage override. The actual boundary
counts are measured separately. This controlled-threshold test does **not**
establish longevity at the unchanged default full model window.

The published driver is byte-identical to the executed driver. The published
worker changes only three import paths to run from `integration/clients`; its
runtime logic is identical. Evidence records both hashes and the no-model
packaging checks. The published layout was not used for an additional inference
run merely to retest those imports. The first preparation attempt failed before
reading credentials or starting a session because its context path layout did
not match; it made zero provider calls and is retained in the evidence.

Official references: [Claude Code environment variables](https://code.claude.com/docs/en/env-vars),
[Agent SDK TypeScript reference](https://platform.claude.com/docs/en/agent-sdk/typescript).
