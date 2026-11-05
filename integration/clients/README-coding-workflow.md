# Combined coding-workflow qualification (offline)

`codex_coding_workflow.py` exercises the actual pinned **Codex 0.160.0** app-server,
pristine **LiteLLM 1.103.1** authenticated free pass-through, the actual built
Responses adapter, and a scripted loopback Anthropic endpoint. The proxy enables
the already implemented `RESPONSES_APPLY_PATCH_MODE=validated`; it never executes
the tools itself. No provider credentials or real inference are used.

Unlike the earlier patch-only fixture, this profile exposes **unified_exec and
freeform apply_patch together** and retains the exact stock Codex fallback prompt.
It does not replace the system prompt with a one-tool test instruction, claim GPT
capabilities for Claude, or modify either client or LiteLLM source. The opt-in
catalog comes from [the profile generator](profiles/README.md). This deterministic
fixture tests transport and actual client effects, not a real model's coding skill.

## Sequence and acceptance

The new temporary workspace contains two broken source files and an independent,
unchanged Python test. There are exactly seven model requests and five tool calls:

1. Shell reads `calculator.py` and `display.py`.
2. Shell runs `test_fixture.py`: expected failure marker and exit **3**.
3. One native tool call becomes a freeform patch updating both source files.
4. Shell reruns the unchanged test: expected success marker and exit **0**.
5. The client receives the first final answer.
6. A same-thread user follow-up calls the shell to rerun the test.
7. The client receives the follow-up final answer.

Every tool response includes synthetic signed thinking, signed-empty thinking,
and redacted thinking. The observer checks cumulative ciphertext/ID replay, exact
ordered native assistant blocks, and exact tool-result content and identifiers
at every request. Client execution notifications independently establish exit
codes `[0, 3, 0, 0]` and successful fileChange. The complete workspace file map
must equal the expected repaired sources plus the unchanged test. Final text,
client exit status, or a matching tool-result ID alone cannot produce success.

`transport_state_pass` and `functional_pass` are deliberately separate. The
script exits zero only on complete functional success. The scripted upstream
continues its bounded sequence even when a client tool returns a denial; this is
useful failure evidence and must not be interpreted as a completed coding task.

## Run

Build the application normally, then use the existing stock-LiteLLM Python, pinned
Codex executable, Node, and a generated catalog. No runtime is installed by the
harness. The output directory must be a **new system-temp child outside the repo**.

```powershell
& '<stock-litellm-python>' integration/clients/codex_coding_workflow.py `
  --codex '<codex-0.160.0-executable>' --node '<node-executable>' `
  --catalog '<generated-profile>/codex-home/models.json' `
  --output '<system-temp>/codex-coding-workflow-NEW-UNIQUE-NAME'
```

The source prompt hash must match the generator's pinned Codex source. The entry
must select the exact native model ID (default `claude-haiku-4-5-20251001`), enable
unified_exec/freeform patch, and have no implicit upgrade. The actual app-server
`model/list` response is checked as part of the current harness. To check only
catalog parsing, without inference, servers, or tool execution, add
`--catalog-check-only` and use a fresh output directory.

Pure acceptance-oracle tests:

```powershell
& '<stock-litellm-python>' -m unittest discover -s integration/clients `
  -p 'test_codex_coding_workflow.py' -v
```

Every run has a new client home and allowlisted environment; no existing user
authentication/settings are copied. The client requests `workspace-write`,
network access is disabled in its sandbox configuration, retries are zero, and
analytics/update/OTEL controls are disabled. Gateway and relay have distinct
fresh synthetic keys, which must not reach the fake Anthropic server. Captured
logs redact those keys. Thirteen relevant stock LiteLLM source identities are
checked before and after. This is not a whole-dependency or zero-egress attestation.

## Observed Windows result — 2026-10-24

Run `C:/Users/binary/AppData/Local/Temp/codex-coding-workflow-20261024-b/`:

- Seven requests at both hops; both actual core tool descriptors offered.
- All seven accumulated ciphertext, ordered native assistant, and tool-result
  content checks passed. Native signed-empty/redacted state was retained.
- Exact stock prompt hash
  `ac8ae107a0d72fe3476b430afb161ea4e67da2e446d778aefc44828160559807`;
  no model metadata fallback. Client reasoning was `{ "summary": "auto" }`, with
  **no effort field**; the native request retained enabled thinking, budget 1024.
- The effective Windows sandbox was **read-only**. Every `exec_command` was
  rejected by the local policy, and apply_patch reported that writing was blocked
  by the read-only sandbox. No command execution or file-change completion was
  observed; the fixture remained broken.
- Therefore **transport passed, functional coding failed**, and the process
  correctly returned **1**, despite both final markers and completed turn events.

No permissions were changed or bypassed, and denied tools were not rerun under
another execution mechanism. A separately usable, authorized workspace-write
runtime is still needed to qualify actual combined file/test effects. The earlier
bounded Linux patch-only test is not a substitute for this combined workflow.

The saved run predates the final tool-result-content report field and integrated
`model/list` check. Reanalysis of its retained observations with the final pure
oracle confirmed all seven tool-result contents exactly, without new model/tool
calls or rewriting the saved evidence. Separate read-only catalog check
`codex-coding-workflow-catalog-20261024-b/catalog-check.json` passed: actual Codex
listed only the native Haiku ID, no upgrade, and empty supported reasoning efforts.

The first development run (`...-20261024-a`) failed because an inherited synthetic
stream helper emitted the earlier Sonnet fixture model for a Haiku request. The
new helper emits the selected model and has a pure SSE regression test. That
discarded fixture error is **not** evidence of an adapter compatibility defect.

This does not qualify real provider acceptance, model coding quality, billing,
cache savings, deployed `.7`/`.64`, automatic compaction, restart/resume, arbitrary
shell commands, or a full normal repository session. These remain separate work.
