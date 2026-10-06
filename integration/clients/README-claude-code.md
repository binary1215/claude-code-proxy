# Actual Claude Code native-chain smoke

This bounded check runs the official, unmodified Claude Code CLI through **stock LiteLLM 1.103.1 custom pass-through → the current built native relay → a loopback fake Anthropic Messages endpoint**. It never uses a real provider credential, account, project conversation or provider request. No production deployment, gateway-source patch, client patch, signature repair, paid fallback or identity emulation is involved.

## Pinned executable provenance

No existing local Claude Code CLI was found in PATH or the inspected standard locations. For this task, the following official npm packages were downloaded into a new task temp directory, their published SHA-512 integrity was verified, and they were extracted without running installation scripts or making a global installation:

- [`@anthropic-ai/claude-code@2.1.289`](https://registry.npmjs.org/@anthropic-ai%2fclaude-code/2.1.289): `sha512-RQWjAlalf9aomgI3JaXDCdFPvmNVnRdjwMtYk5L+Lw1NWxCxbhY5T9F+w1xukqvJh/I2rR2+3hICZxhk0al1nA==`.
- [`@anthropic-ai/claude-code-win32-x64@2.1.289`](https://registry.npmjs.org/@anthropic-ai%2fclaude-code-win32-x64/2.1.289): `sha512-t6PwcRoMIeuNPbnkf9bFxdUv3xBgUSnk1yRU3r8b5CjovwzV1zUY/talE4rgGAvcTwmndirtWOny/3LPf6Ju+w==`.
- Actual native `claude.exe` SHA-256: `bcc6d9117aec30ad9414490302a25414359c871f5647e32e49b055c92bf84e0b`.
- Isolated `--version`: `2.1.289 (Claude Code)`. Official npm `latest` was also `2.1.289` on the read-only 2026-10-05 check. No other version was installed or run.

The wrapper package's small `bin/claude.exe` is a placeholder, not the native executable. Use the verified platform package's actual `claude.exe`. The test does not rewrite either package.

## Reproduction

Build the current relay first. Use the existing pristine `litellm[proxy]==1.103.1` Python environment from [the gateway audit](../litellm/README.md), an existing Node runtime and the pinned official native CLI:

```powershell
& '/path/to/stock-venv/Scripts/python.exe' integration/clients/claude_code_smoke.py `
  --claude /path/to/verified/native/claude.exe --signature-events single `
  --output /new/task/temp/single-evidence

& '/path/to/stock-venv/Scripts/python.exe' integration/clients/claude_code_smoke.py `
  --claude /path/to/verified/native/claude.exe --signature-events split `
  --output /new/task/temp/split-evidence
```

Both commands use the same two cases: signed-nonempty reasoning plus Read; and signed-nonempty, signed-empty, redacted reasoning plus Read. `single` sends one complete `signature_delta` per thinking block and is the default qualification path. All modes send SSE in seven-byte transport fragments, including Unicode and signature bytes. The official [streaming documentation](https://platform.claude.com/docs/en/build-with-claude/streaming) describes a signature event immediately before block-stop; splitting an event's bytes and inventing separate events are distinct tests.

Optional `--signature-events replacement` sends two complete synthetic signature values and expects the last one. This follows assignment semantics in the pinned official [TypeScript SDK](https://github.com/anthropics/anthropic-sdk-typescript/blob/d49bdab458000bcdffe77bd84b03293f31824fb3/src/lib/MessageStream.ts) and [Python SDK](https://github.com/anthropics/anthropic-sdk-python/blob/18f25547f20cf5f01da69ac611e700e3bc9ebf21/src/anthropic/lib/streaming/_messages.py). Text/thinking and tool JSON fragments still append. Repeated full values are an SDK-assembly control, not a claim that real providers normally emit them.

`split` retains the historical two-part synthetic input solely as a **non-normative observation**. It does not require concatenation: SDK assembly uses the last event value, even when the fixture chose to make that value only a suffix. Its `state_subset_pass` and `strict_qualification_pass` are null; it exits zero only after observation completion, not as a fidelity qualification. `split_concat_matches_observed` and `split_sdk_last_event_matches_observed` show the separate raw comparisons. The legacy `split_signature_preserved` field is null, never a failed normative check.

For `single` or `replacement`, strict mode exits nonzero unless the state subset and whole-body semantic equality both pass. `--observe-only` permits zero after a complete diagnostic observation without changing those fields. Every invocation needs a new output directory outside the repository. `--node` selects an existing Node executable when it is not on PATH.

## Isolation and evidence

The harness constructs the child environment without inherited provider/account credentials or settings, uses a new home/config/state/workspace, sets `CLAUDE_CONFIG_DIR`, disables user/project settings sources, memory instructions, hooks, marketplace autoinstall, telemetry, update and nonstream fallback, and disables session persistence. Only `Read` is offered; it is approved only for the one-line generated `fixture.txt`, under `dontAsk` permissions. MCP configuration is empty and strict. It does not use permission bypass. See the official [CLI reference](https://code.claude.com/docs/en/cli-reference) and [environment controls](https://code.claude.com/docs/en/env-vars).

The existing test-only relay bootstrap starts the actual built app with an in-memory database and freshly generated relay/admin credentials. Claude Code calls a noncolliding `/claude-native/v1/messages` stock route; the authenticated stock route replaces the gateway credential with the relay credential, and the relay uses only the synthetic fake-provider key. Claude Code never calls the Responses adapter. An observer checks request objects/bytes, unchanged beta headers, response SSE bytes, ordered replay and exactly two inference requests per hop. Thirteen selected installed gateway-source identities are checked before and after; this does not hash the entire package.

All listeners and inference targets are loopback; an explicit rejecting proxy blocks incidental child requests. This is **configuration-level isolation, not an OS-enforced network/filesystem sandbox**. Processes are stopped after each bounded run. Synthetic wire/event logs remain in the new external evidence directory, with generated credentials redacted. No existing authentication file is intentionally loaded or inspected. No actual cache hit, real signature acceptance, entitlement, provider quota, billing or deployed `.7` behavior is established.

## Actual observations on 2026-10-05

| Historical result | Single signature event, seven-byte framing | Two partial-value events, same framing (non-normative) |
| --- | --- | --- |
| Both cases: successful real Read round trip and exact final result | Yes | Yes |
| Ordered signed-nonempty/signed-empty/redacted/tool replay | Exact | Last signature event value replayed, consistent with SDK replacement; other listed state preserved |
| Provider response SSE bytes and beta headers across the chain | Exact | Exact |
| Gateway/relay credential reaches fake provider | No | No |
| Selected stock source files modified | No | No |
| Whole client request body semantics | **Not exact: stock removes `metadata`** | Same metadata loss |

The single-event run supplies positive **state-subset** evidence, not full fidelity or achievement of the whole project goal. Native `metadata` is present in both actual client requests but absent at the fake provider; all other request fields are equal. Stock's reserved metadata handling [pops that field](https://github.com/BerriAI/litellm/blob/580bde9a2d148714889ec1c04a9872819e78a778/litellm/proxy/pass_through_endpoints/pass_through_endpoints.py#L579-L588). Request wire bytes also differ and are reported separately; they are not conflated with semantic preservation.

In the historical split-event run, the client's next request contains the second event value for **both** thinking blocks. The observer sees the same value before LiteLLM and after the native relay, with unchanged delivered SSE. The old oracle incorrectly assumed these event values must concatenate. The official SDK replacement rule explains the observed result, so it **does not establish a Claude Code defect or signature-loss bug**. The relay did not repair or reinterpret the synthetic values. This observation proves neither real-provider multi-event behavior nor cryptographic validity.

Current metrics separate `state_subset_pass`, `whole_body_semantic_exact`, `strict_qualification_pass` and the non-normative split observations. Historical artifacts and their old booleans remain unchanged, including older `full_tested_fidelity:false`; the incorrect concatenation interpretation is corrected here, not by rewriting evidence. Previously passing single-event state results are unaffected.

The original local evidence directories were `claude-code-single-5a478164c16748eda05968d11c4611b7` and `claude-code-chain-f5c178e1177640aa9d88e99cf00b034f` under the task temp root. Each contains both cases, the complete synthetic request/SSE observations, client result events and unchanged source identities. No real provider call was added to resolve either negative result.

An independent historical rerun in single-event observation mode is recorded in `claude-code-chain-final-single-20261005`: both cases again preserve the tested state subset, while whole-body semantics remain unequal solely because stock removes `metadata`. Its saved fields are `observation_completed:true`, `state_subset_pass:true`, `whole_body_semantic_exact:false`, and `split_signature_preserved:null`. Neither the split case nor actual clients were rerun for this oracle correction; local syntax/pure-source checks do not create new client evidence.
