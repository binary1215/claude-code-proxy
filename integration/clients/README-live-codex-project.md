# Real Codex project work through native Responses

`codex_project_live.py` runs an existing, unmodified **Codex0.160.0** Linux
app-server against the prepared `claude-opus-5-5-responses-han` alias on the
existing LiteLLM `/v1/responses` endpoint. It uses the pinned ordinary Codex
prompt and offers normal `unified_exec` and freeform `apply_patch` together.
The generated catalog describes this isolated test profile, not official model
capability metadata.

The caller must prepare a supported Linux sandbox environment. The earlier
[Linux patch preflight](README-live-codex-patch.md) describes the observed
container namespace requirements. This harness does not install clients,
change security profiles, deploy services or modify client/gateway sources.

## Run

Supply the existing gateway key only in a named process environment variable.
The prompt file is a read-only input, pinned to Codex source revision
`a956835d020762cb2b570053af06f643a11c0ecc`, SHA256
`ac8ae107a0d72fe3476b430afb161ea4e67da2e446d778aefc44828160559807`.
The existing profile generator documents how to obtain this stock prompt.

```sh
python3 -B codex_project_live.py --live --codex /opt/codex/bin/codex \
  --stock-prompt /fixtures/stock-codex-prompt.md \
  --model claude-opus-5-5-responses-han \
  --gateway-base-url http://192.168.0.7:4000/v1 \
  --gateway-key-env CODEX_PROJECT_GATEWAY_KEY \
  --output /tmp/codex-project-live-new
```

The runner imports only standard-library modules and the existing sibling
`codex_patch_live_smoke.py` and `generate_client_profiles.py`. Put these files
beside the runner or mount the integration directory read-only. Output must be
a new system-temporary directory. No normal client home or project is copied.
The actual workspace-write sandbox is requested with approval policy `never`;
there is no sandbox bypass or automatic approval. The caller creates the
gateway model before starting this runner.

## Actual project and acceptance

The runner creates a tiny Python invoice project with `billing.py`, `display.py`,
an immutable supplied test file and README. It independently confirms that the
original project fails. The model must read the project, run the failing tests,
repair both source files and run the tests successfully. The first turn ends
with `CODEX_PROJECT_FIXED`.

Before the same-thread follow-up, the caller adds a second supplied test file.
The new requirements are a fixed discount clamped at zero, and an optional
currency-symbol argument while retaining old behavior. Both source files must
change again and the actual client must rerun the tests. The runner independently
runs all tests after both phases and verifies the supplied tests were preserved.
The follow-up ends with `CODEX_PROJECT_EXTENDED`.

A final model marker is insufficient. The safe report records real app-server
command/file-change observations, failing and successful test execution, source
file changes, independent test exits, protected-test equality and both turn
statuses. It records test/patch ordering separately; it does not require an
exact model patch or a fixed number of tool calls. Planning remains the model's.

The request observer forwards unchanged bodies/SSE once to the existing gateway,
without retries or redirect handling. Its budget is **18 requests total**,
at most12 for the initial work and6 for the follow-up. Uncertain outcomes consume
their slot. HTTP/stream idle timeout is100 seconds; initial/follow-up turn waits
are570/270 seconds. The operator should also bound the outer container lifetime.
RPC observation inherits the existing5MiB/1500-event and1MiB stderr bounds.

## Genuine automatic compaction

Optionally add `--auto-compact-token-limit N`. This sets only Codex's supported
run-local `model_auto_compact_token_limit`; the harness never sends
`thread/compact/start`, changes usage counters or claims a fake model window.
See the [official OpenAI configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

Start with a baseline project run to measure real request usage, then choose a
bounded threshold for a separate new run. A configured threshold is not proof
that compaction happened. The report counts actual `contextCompaction` start and
completion events and checks for a successful real test command afterward.
`automatic_compaction_qualified` requires these observations plus both completed
project phases. A successful edit run without automatic compaction remains a
project success with automatic compaction unqualified. This test does not fill
the model's advertised maximum context window or qualify arbitrary long work.

## Evidence and retention

`codex-project-live.json` retains fixed diagnostics, booleans, counts, statuses
and numeric provider/cache counters. Reasoning IDs and opaque state are compared
in memory across done/final snapshots and actual later inputs. A cache marker is
not a hit, and absent reasoning cannot qualify signed replay. Compaction may
legitimately remove earlier reasoning; replay observations check exact known
items actually sent, rather than demanding that all old items survive forever.

Raw request bodies, model patches, SSE, RPC events, provider error text, stderr
and credentials are not exported. The actual temporary source files and Codex's
own isolated session history remain under output; that history can naturally
contain prompts, replies, tool results and opaque state. Keep it private.
The harness closes its owned client and listener. The operator owns the outer
container, namespace profiles and their cleanup. Gateway internal attempts and
the gateway-to-relay wire are not observed here.

Pure local verification, without a client or provider:

```sh
python3 -B -m unittest discover -s integration/clients -p test_codex_project_live.py
```
