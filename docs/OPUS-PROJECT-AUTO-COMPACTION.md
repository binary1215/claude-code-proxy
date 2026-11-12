# Opus project editing and automatic compaction

The native Responses work was merged and pushed to `master` at `98f6885`.
The follow-up qualification uses **Opus 5.5**, unchanged Claude Code and Codex
clients, and the existing LiteLLM gateway. The completed evidence establishes
real project editing in both clients, automatic compaction in both clients,
and separate proxy backend automatic compaction. The requested bounded cases
are complete; unchanged default full-window longevity remains unverified.

The [aggregate evidence](evidence/20261112-opus-project-long-session.json)
contains the measured counters, source/image hashes, completed checks, failed
attempts and remaining work. It contains no credentials, model text, thinking,
signatures or private workspace paths.

## Qualification snapshot

| Case | Result | Measured behavior |
| --- | --- | --- |
| Codex actual project baseline | Passed | Six gateway requests; source reads, failing tests, repair of two files, passing client and independent tests, then a same-conversation feature extension touching both files again |
| Claude Code client automatic compaction | Passed | Six gateway requests; genuine automatic boundary 24,472 -> 1,656 tokens; retained tool/source/calculation state and subsequent cache reads |
| Proxy CLI backend automatic compaction | Passed separately | Six actual provider calls in one live backend session; genuine automatic boundary 24,032 -> 1,383; retained state and correct internal usage accounting |
| Claude Code first project attempt | Failed | Five HTTP 200 replies followed by HTTP 503 `cli_capacity`; no completed project phase |
| Codex lowered-threshold project attempt | Not qualified | Three HTTP 200 replies and a correct two-file repair; a harness false negative stopped the run before follow-up or automatic compaction |
| Codex corrected automatic project trial | Passed | Nine HTTP 200 replies, two genuine automatic compactions, subsequent source edits and successful tests; both project phases and independent oracles passed, signed replay and cache reads qualified |
| Claude Code project after capacity fix | Initial repair passed; follow-up incomplete | Read 3/Edit 2/Bash 5 in the completed phase; a test-only Bash guard stopped the follow-up. Ten attempts, nine recorded HTTP 200 statuses, one unknown outcome |
| Claude Code corrected project trial | Passed | Seven HTTP200 replies; initial repair and same-session feature extension both edit two files and pass real client tests plus independent oracles; 16 exact signed replays and positive cache reads |

The automatic-compaction passes use a documented **test-only lowered
threshold**. They do not establish longevity at the unchanged default full model
window. Client compaction, Codex compaction and backend compaction are distinct
boundaries; a pass at one boundary does not imply a pass at another.

## Actual project work

The [Codex project harness](../integration/clients/README-live-codex-project.md)
uses the genuine Linux Codex 0.160.0 app-server with normal shell and
`apply_patch`, the pinned ordinary Codex prompt, and the existing native
`/v1/responses` gateway route. Its isolated Python invoice project begins with
failing tests. Opus repaired both source files, then implemented a follow-up
fixed-discount/formatting feature in the same conversation. Both phases passed
the independent oracle and preserved the supplied tests. The workspace-write
sandbox remained enabled; no sandbox bypass was used.

The baseline made six successful requests. Actual input counts rose from 13,560
to 17,236. Cache reads were observed on later requests, and actual signed state
replay qualified. No automatic threshold was configured in that baseline, and
no automatic compaction occurred. Its project success must not be presented as
an automatic-compaction result.

The separate Codex automatic trial set the supported run-local threshold to
15,500, chosen from the baseline measurements. It repaired both files and passed
the independent tests in three successful requests. Its input counts reached
15,399. Inspection of the genuine private Codex history confirmed that the
initial command ran three tests with two failures, then ran `cat` after a
semicolon. The shell command's final exit code was zero. The observer incorrectly
required a nonzero aggregate command exit to recognize the test failure, causing
a false negative and stopping before the follow-up. No `contextCompaction` event
occurred. This is a test-observation defect, not an HTTP failure or evidence that
compaction itself failed. No thinking block was
observed in that attempt, so signed replay is unqualified rather than evidence
of a discarded block.

The [Claude Code project harness](../integration/clients/README-live-claude-project.md)
uses genuine built-in Read/Edit/Bash tools against an isolated Node project.
The first run did not finish a project phase. Five successful Bash-producing
model exchanges preceded the confirmed capacity error. Those exchanges alone
are insufficient evidence of successful editing. Their original Bash output
was not retained, so its cause or usefulness cannot be diagnosed retrospectively.

The revised harness accepts an actual successful `cat` source read when its
output matches the complete pre-call source. It also records tool completion
flags, command families and fixed error categories without exposing raw
commands/output. A separate network-disabled scripted-provider preflight proved
that the genuine built-in Bash can read files and run the Node tests in the
selected image. That preflight does not establish model coding quality.

The subsequent native project run completed the initial repair: three reads,
two real edits, an observed failing test before the edits, and passing client
and independent tests afterward. It reached the follow-up, where an ordinary
Bash tool denial was treated as a fatal harness error (`bash_outside_fixture`).
There were ten request attempts and nine recorded HTTP 200 statuses; the final
attempt's outcome is unknown. This is not another observed capacity failure.
The test harness was corrected to return ordinary tool denials to the client
for recovery and support fixture-local Node inspection. Actual host approval
policy is unchanged. Its next run passed in seven HTTP200 requests with no
tool denial: initial Read2/Edit2/Bash2 and follow-up Edit3/Bash2. Both phases
observed failing tests before edits and passing client/independent tests after
editing both source files. All supplied tests remained unchanged. Seven signed
thinking blocks yielded 16 exact replay observations, with no mismatch or
unrecognized block. Later cache-read counts included 10,527 and 12,341.

## The capacity defect found by the live test

The gateway owner confirmed the sixth native project request failed with
`cli_capacity`. At diagnosis the proxy reported zero active API tasks and eight
cached CLI sessions. The old capacity selection excluded every session with a
pending caller tool, even after its HTTP response had completed. Those tools
execute in the external client; an idle worker waiting for them is a reusable
history cache. Enough such histories could exhaust all slots and reject new work.

The fix evicts the least-recently used session only when it is not closed, not
busy, and has no active upstream request. A pending client-owned tool no longer
prevents eviction. When that conversation returns, the existing full-history
import path reconstructs its actual tool result and native state. Active
requests remain protected, and genuinely active overload still returns 503.

The regression uses the pinned genuine SDK/CLI with a scripted provider: more
pending histories than the configured capacity, then continuation of an evicted
history with its real tool-result ID and exact synthetic signed block. A second
case holds real upstream sockets open and proves active leases are not evicted.
The failure reproduced before the fix. The deployed compiled session module's
hash matches the reviewed candidate recorded in the evidence.

Final serial Linux checks passed **49 CLI tests, 222 HTTP tests and 5 admin tests**
(276 unique tests). An earlier parallel run had three failures and one cancelled
test. One known fixture issue awaited a client event buffered by the pinned
transport; the corrected regression observes the actual held provider socket.
The cause of the HTTP timeouts was not established, so host load remains a
hypothesis. An initial missing TypeScript test dependency was supplied only to
the isolated test environment. These mechanical checks support the fix; they
do not replace real client qualification.

## Automatic compaction and usage

The [native client automatic test](../integration/clients/README-live-auto-compaction.md)
observed genuine `trigger: auto` hooks and a compact boundary, without submitting
a manual compact command. It retained the tool-returned code/value, computed
checksum and exported source identifiers. Four returned signed thinking blocks
were observed again in later client requests with no mismatch. Warm/later cache
reads were 1,637 and 4,452 tokens. Observation covers client-to-gateway traffic;
it does not expose every internal gateway/provider request.

The [backend automatic test](../integration/clients/README-live-backend-auto-compaction.md)
ran independently with the real session registry, worker, private forwarder and
provider. It kept one live backend session throughout. Its warm cache read was
1,598 and its later cache read was 3,914. The selected tool/source/calculation
state survived, and caller-to-registry native block replay matched.

The backend test separately checked usage accounting. One caller turn performed
an internal compact request plus inference: administration usage summed 23,086
input tokens, while the response reported the inference's own 2 input tokens.
All observed counters matched the actual internal requests. Adding compaction
usage to the response's context count would incorrectly encourage more client
compaction, so those counters intentionally have different meanings.

Both automatic passes configured `autoCompactWindow=100000` plus the official
10% override. The SDK summary separately displayed 82,904 as its baseline
threshold; that display omitted the percentage override. Requested settings,
displayed threshold and actual boundary counts are recorded separately. No
fake count-token result, inflated provider usage, SDK patch or manual compact
command was used.

Positive cache counters show actual cache use. They do not establish invoice
accuracy, a universal input-cost multiplier, or equivalent coding quality on
every task. Retention checks establish the selected facts that were tested.

## Reproducibility and remaining work

The aggregate records the exact tested harness hashes. After the Codex project
baseline, the first reviewed revision changed four diagnostic details only:
integer exit-code validation in two checks, handling an additional parse error,
and preserving unknown cache counters as null. Its prompts and request flow
were unchanged. The first automatic trial used that reviewed revision. The
current revision additionally fixes recognition of anchored unittest failure
summaries after the observed false negative; its pure tests pass 12/12. Native
project diagnostics likewise have distinct first/revised hashes.

The corrected `codex-auto-02` run passed both project phases, with two actual
automatic compactions and successful file editing/tests afterward. Its nine
requests all completed with HTTP200. Cache reads and exact signed-state replay
qualified. The configured threshold remained 15,500 and no manual compact RPC
was sent. The final native `claude-project-03` run also passed both project phases.
Default full-window longevity remains a separate unverified case.
LiteLLM and Codex sources have not been modified for this work.
