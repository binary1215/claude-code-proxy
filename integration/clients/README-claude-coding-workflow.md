# Claude Code multi-file coding workflow

`claude_coding_workflow.py` runs the actual pinned Claude Code **2.1.289** through
pristine stock LiteLLM **1.103.1**, the built native relay, and a scripted loopback
Anthropic fixture. It does not call a real provider or use an existing login.

Build the backend, then use the existing stock gateway Python environment:

```powershell
python integration/clients/claude_coding_workflow.py `
  --claude 'C:/tools/claude.exe' --node 'C:/tools/node.exe' `
  --bash 'C:/Program Files/Git/bin/bash.exe' `
  --output "$env:TEMP/claude-coding-new-evidence"
```

`--bash` selects an existing Windows Git Bash installation; it does not install
anything or change permissions. The output directory must be new, inside the
system temporary directory, and outside this repository. The harness creates
its own Claude configuration and three-file fixture. The stock system prompt
and normal tool definitions remain; the isolated settings permit Read/Edit on
the fixture and only the exact local test command. No global configuration,
remote deployment, host security profile, or client source is changed.

The scripted provider requests:

1. Read two buggy source files.
2. Run the test in the real Bash tool and observe its failing exit.
3. Edit both source files with the real Edit tool.
4. Rerun the test successfully, then return a final marker.

Acceptance requires seven HTTP requests, the matching six tool results, actual
failure then success markers, exact final bytes of both sources and the
unchanged test, and an independent Node test run. It also checks six signed,
signed-empty and redacted-thinking replays and equality of the client-sent
`messages` with what reaches the synthetic provider. A final marker alone cannot
pass. Process and loopback server cleanup runs on completion; OS-enforced egress
isolation and termination of arbitrary descendant processes are not claimed.

## Observed 2026-10-24

The Windows loopback run passes the coding workflow and all six reasoning checks.
All seven requests returned 200. The 13 guarded stock LiteLLM source files were
unchanged. Stock Claude Code adds `replace_all:false` to Edit inputs when absent:
the non-text replay equality check, excluding cache-control, is therefore false
after the first Edit. That narrow default addition is reported separately from
exact thinking/signature preservation; no other tool-input changes are accepted.
The proxy/gateway did not change those client-sent message arrays.

This is real local tool execution driven by a deterministic fake model, **not**
real-model planning quality, provider entitlement, cache billing, automatic
compaction, resumed sessions, or deployment qualification. Evidence summary:
[20261024 coding workflows](../../docs/evidence/20261024-coding-workflows.json).
