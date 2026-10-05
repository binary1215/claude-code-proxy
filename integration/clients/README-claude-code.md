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

Both commands use the same two cases: signed-nonempty reasoning plus Read; and signed-nonempty, signed-empty, redacted reasoning plus Read. `single` sends one complete `signature_delta` per thinking block; `split` sends two separate `signature_delta` events. **Both** send the SSE in seven-byte transport fragments, including Unicode and signature bytes. The official [streaming documentation](https://platform.claude.com/docs/en/build-with-claude/streaming) describes a signature event immediately before block-stop; event splitting and transport fragmentation are distinct tests.

Strict mode exits nonzero unless both the tested state subset and whole-body semantic equality pass. The default is the split-event stress test. `--observe-only` permits exit zero after a complete diagnostic observation, including a negative fidelity result; it never changes the report's fidelity fields. Every invocation needs a new output directory outside the repository. `--node` selects an existing Node executable when it is not on PATH.

## Isolation and evidence

The harness constructs the child environment without inherited provider/account credentials or settings, uses a new home/config/state/workspace, sets `CLAUDE_CONFIG_DIR`, disables user/project settings sources, memory instructions, hooks, marketplace autoinstall, telemetry, update and nonstream fallback, and disables session persistence. Only `Read` is offered; it is approved only for the one-line generated `fixture.txt`, under `dontAsk` permissions. MCP configuration is empty and strict. It does not use permission bypass. See the official [CLI reference](https://code.claude.com/docs/en/cli-reference) and [environment controls](https://code.claude.com/docs/en/env-vars).

The existing test-only relay bootstrap starts the actual built app with an in-memory database and freshly generated relay/admin credentials. Claude Code calls a noncolliding `/claude-native/v1/messages` stock route; the authenticated stock route replaces the gateway credential with the relay credential, and the relay uses only the synthetic fake-provider key. Claude Code never calls the Responses adapter. An observer checks request objects/bytes, unchanged beta headers, response SSE bytes, ordered replay and exactly two inference requests per hop. Thirteen selected installed gateway-source identities are checked before and after; this does not hash the entire package.

All listeners and inference targets are loopback; an explicit rejecting proxy blocks incidental child requests. This is **configuration-level isolation, not an OS-enforced network/filesystem sandbox**. Processes are stopped after each bounded run. Synthetic wire/event logs remain in the new external evidence directory, with generated credentials redacted. No existing authentication file is intentionally loaded or inspected. No actual cache hit, real signature acceptance, entitlement, provider quota, billing or deployed `.7` behavior is established.

## Actual observations on 2026-10-05

| Result | Single signature event, seven-byte framing | Two signature events, same framing |
| --- | --- | --- |
| Both cases: successful real Read round trip and exact final result | Yes | Yes |
| Ordered signed-nonempty/signed-empty/redacted/tool replay | Exact | Thinking text/order/redacted/tool preserved, signatures lose first fragment |
| Provider response SSE bytes and beta headers across the chain | Exact | Exact |
| Gateway/relay credential reaches fake provider | No | No |
| Selected stock source files modified | No | No |
| Whole client request body semantics | **Not exact: stock removes `metadata`** | Same metadata loss |

The single-event run supplies positive **state-subset** evidence, not full fidelity or achievement of the whole project goal. Native `metadata` is present in both actual client requests but absent at the fake provider; all other request fields are equal. Stock's reserved metadata handling [pops that field](https://github.com/BerriAI/litellm/blob/580bde9a2d148714889ec1c04a9872819e78a778/litellm/proxy/pass_through_endpoints/pass_through_endpoints.py#L579-L588). Request wire bytes also differ and are reported separately; they are not conflated with semantic preservation.

In the split-event run, the actual client's next request already contains only the second signature fragment for **both** thinking blocks. The observer sees that loss before LiteLLM; the fake receives the same thinking blocks, and the delivered SSE is unchanged. This locates the observed split-signature loss at the client boundary. The native relay does not strip, repair, combine, substitute or retry the broken signature. This result does not prove real Anthropic normally emits multiple signature events, nor cryptographic validity of the synthetic values.

Final metrics deliberately separate `state_subset_pass`, `whole_body_semantic_exact` and `split_signature_preserved`. The older diagnostic artifacts used a generic `full_tested_fidelity:false`; the current harness avoids presenting a subset result as whole-outcome success.

The original local evidence directories were `claude-code-single-5a478164c16748eda05968d11c4611b7` and `claude-code-chain-f5c178e1177640aa9d88e99cf00b034f` under the task temp root. Each contains both cases, the complete synthetic request/SSE observations, client result events and unchanged source identities. No real provider call was added to resolve either negative result.

An independent rerun of the final harness in single-event observation mode is recorded in `claude-code-chain-final-single-20261005`: both cases again preserve the tested state subset, while whole-body semantics remain unequal solely because stock removes `metadata`. Its final fields are `observation_completed:true`, `state_subset_pass:true`, `whole_body_semantic_exact:false`, and `split_signature_preserved:null`. The earlier split-event observation was not rerun after the reporting-field refactor.
