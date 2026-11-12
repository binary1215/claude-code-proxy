# Bounded live Claude Code project editing

`claude_project_live.mjs` runs the unchanged official **Agent SDK 0.3.322 / Claude
Code 2.1.322** against the existing `.7` gateway, using
`claude-opus-5-5-han` on `/v1/messages`. This is a real coding-tool workflow in a
new temporary project. It does not modify a host project, deploy a relay, change
gateway/client settings, or read provider credentials.

The operator must prepare the existing gateway alias and an appropriately
scoped **gateway client key** before invoking the live test. This harness does
not create keys or inspect the gateway's model configuration. The model IDs in
responses may be the public alias or canonical `claude-opus-5-5`; gateway-to-Han
traffic remains outside the observer's view.

## Project and acceptance

The harness creates dependency-free `src/amounts.mjs`, `src/order.mjs`, and a
`node:test` suite under a new container-temporary workspace.

1. The actual client reads the source/tests and runs the initially failing
   tests. It uses built-in `Edit` on **both source files**, fixes currency
   rounding, percentage discounts, quantities and order totals, and reruns the
   tests successfully.
2. The harness adds a new acceptance case for fixed discounts. The **same CLI
   session** observes the new failure, updates both source files again, and
   passes the expanded suite.

The prompt supplies requirements and filenames, not a completed patch. The
model uses genuine built-in `Read`, `Edit`, and `Bash`; source reads may use
`Read` or `cat` through `Bash`. No MCP replacement tool
edits files on its behalf. Test runs use:

```sh
node --test --test-reporter=tap tests/order.test.mjs
```

SDK hooks record successful reads/edits and TAP failure/pass counts from real
Bash results. A failed hook never counts as a successful read, edit, or passing
test. A Bash source read counts only when a `cat` argument identifies a known
source file and the successful command's stdout contains that file's complete
pre-call contents. A command mentioning a filename alone is insufficient.
Each phase requires a failed run before its first edit, changes
to both source hashes, and an observed passing client test run. A separate
process then runs the unchanged acceptance suite as an independent oracle.
Modifying acceptance tests cannot produce a passing receipt.

## No-model fixture check

This validates the synthetic project's initial failure, repair acceptance, and
new-feature failure/pass transition without importing the SDK or making network
requests:

```sh
node integration/clients/claude_project_live.mjs --self-test
```

This result qualifies only the fixture/oracle. It is not evidence that a model
or gateway completed the coding workflow. Running without `--self-test` or
`--live` returns an error before contacting a model.

## Live container invocation

Use the already prepared immutable client image:

```text
sha256:34b5f1b91a24f1d2148b4d52ec37550eccf100e7567fd968931502e14a88b870
```

Place the nonsecret harness in an operator-owned location with mode `0644`.
Pass the gateway client key through stdin from the coordinating process. Do not
put it in a shell command, Docker argument, mounted file, or saved report. Mount
only the harness, read-only, into the image's existing SDK directory:

```sh
timeout --signal=TERM --kill-after=5s 615s docker run --rm -i \
  --network bridge --read-only --log-driver none \
  --tmpfs /tmp:rw,nosuid,size=256m \
  --mount type=bind,src=/ABSOLUTE/OPERATOR/PATH/claude_project_live.mjs,dst=/app/integration/cli-backend/claude_project_live.mjs,readonly \
  --entrypoint node \
  sha256:34b5f1b91a24f1d2148b4d52ec37550eccf100e7567fd968931502e14a88b870 \
  /app/integration/cli-backend/claude_project_live.mjs --live
```

The invocation above consumes its inherited stdin. It deliberately contains no
credential expression. The coordinating process owns secure key delivery and
the explicit decision to run live inference. No host workspace or production
authentication volume is mounted. The image root is read-only; the workspace,
client home/config and temporary files are all inside `/tmp` and removed after
the attempt. The harness checks installed SDK/CLI versions before model access.

Built-in reads stay inside the fixture workspace, edits target its two source
files, and Bash permits ordinary project browsing and the Node test runner.
Routine pipelines, `cd` to the fixture, `|| true`, Node version/syntax checks,
and fixture-local Node inspection (`-e`/`--eval` or a single heredoc) are
supported. Inspection may import the fixture modules and use `console`, but
explicit environment access, external imports, networking and process launch
remain outside the test profile. Network/install/auth commands, paths outside
the fixture and shell writes are also outside its scope.

A rejected command returns an ordinary tool denial with supported alternatives;
it does **not** terminate the test. The client can recover with another tool
call within the original request/time budget. The receipt records only the
fixed rejection reason and recognized command family, never the raw command.
The prompt documents the available runtime and recommended test command. No
host permission or client source is changed. This bounded command policy is a
test convenience, not a general shell/JavaScript security sandbox.

## Bounds and receipt

The client is limited to **16 observed model request attempts**, with a
**600-second watchdog** and a **615-second outer timeout**. Attempts are counted
before forwarding; uncertain outcomes consume their slot. Client retries and
fallbacks are disabled, and the observer never replays a failed request or
follows a redirect. These observations do not establish whether the existing
gateway/provider retries internally. No self-retry starts a second live run.

The JSON receipt contains phase booleans, test exit/failure counts, tool counts,
tool completion flags, known command families (such as `cat` or `node_test`),
and fixed error categories for failed tools. These distinguish, for example,
a missing executable/path, permission failure, and an observed failing test
without persisting the underlying error text. Unknown failures remain
`tool_error`; classification is diagnostic evidence, not a root-cause claim.
An interrupted phase retains the same safe tool diagnostics. It also records
known relative fixture paths, source hashes, HTTP/model observations, cache
counters and signed-thinking hashes. It omits keys, raw prompts/replies, tool
inputs/output, file contents and opaque reasoning state. Exceptions and CLI
stderr are reduced to fixed error codes. `functional_pass: true` requires both
actual editing phases and their independent acceptance checks. Reasoning/cache
observations are separate and do not invent a failure when a successful model
reply contains no new thinking. A cache counter is reported only when present;
no counter means no measured cache result.

This project test does not itself force or qualify long-session automatic
compaction. That is a separate live scenario.
