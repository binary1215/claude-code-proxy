# OpenCode native Anthropic client smoke

This test runs the **unmodified official OpenCode CLI** against an in-process loopback fake Anthropic Messages provider. It uses no real provider credential, account, project, or model call. It does not install anything globally.

This document retains the original **direct** baseline. The separate
[stock-gateway/native-relay chain harness](README-opencode-gateway.md) adds
signed-empty controls and distinct multiple-signature-event stress cases. Its
findings must not be retroactively attributed to this older direct test.

## Pinned client and source

Verified on 2026-10-05:

- Official repository: [anomalyco/opencode](https://github.com/anomalyco/opencode).
- Release: [v1.18.34](https://github.com/anomalyco/opencode/releases/tag/v1.18.34).
- Tag source commit: `aec0b9a6d8898f68f923aaf08b7306d931fd9d76` (the tag ref, not the release API's `target_commitish`).
- Asset: `opencode-windows-x64-baseline.zip`.
- Published and locally verified SHA-256: `f89ab2720050780a450e3cf3e48ac3f0409235b46b6c548c69aa2b7051d716f4`.
- Harness runtime: Windows, Node.js `v24.19.0`; the downloaded executable supplies its own client runtime.

The source bundles the [Anthropic AI SDK provider](https://github.com/anomalyco/opencode/blob/aec0b9a6d8898f68f923aaf08b7306d931fd9d76/packages/opencode/src/provider/provider.ts#L148-L151), with [native Anthropic beta defaults](https://github.com/anomalyco/opencode/blob/aec0b9a6d8898f68f923aaf08b7306d931fd9d76/packages/opencode/src/provider/provider.ts#L211-L217). Its [same-model reasoning replay carries provider metadata](https://github.com/anomalyco/opencode/blob/aec0b9a6d8898f68f923aaf08b7306d931fd9d76/packages/opencode/src/session/message-v2.ts#L366-L379). These are source facts; the executable smoke below supplies the actual wire evidence.

## Reproduce on Windows

Use an existing Node runtime. Download only the pinned official asset into a new task temp directory:

```powershell
$opSmokeDir = Join-Path ([IO.Path]::GetTempPath()) ('opencode-smoke-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $opSmokeDir | Out-Null
$opSmokeZip = Join-Path $opSmokeDir 'opencode-windows-x64-baseline.zip'
Invoke-WebRequest 'https://github.com/anomalyco/opencode/releases/download/v1.18.34/opencode-windows-x64-baseline.zip' -OutFile $opSmokeZip
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $opSmokeZip).Hash.ToLowerInvariant() -ne 'f89ab2720050780a450e3cf3e48ac3f0409235b46b6c548c69aa2b7051d716f4') { throw 'Unexpected official asset digest' }
Expand-Archive -LiteralPath $opSmokeZip -DestinationPath (Join-Path $opSmokeDir 'bin')
node integration/clients/opencode_smoke.mjs --binary (Join-Path $opSmokeDir 'bin/opencode.exe')
```

The harness requires `--version` to equal `1.18.34`, creates a separate temp fixture/home/config/cache/state/DB, and builds the child environment without inheriting authentication or user settings. All tool permissions default to deny; only the exact generated fixture can be read. The first request is checked to expose **only `read`**. The provider is hardwired to the local fake endpoint with a clearly synthetic API key.

Updates, external model fetch, plugins, external skills, LSP downloads, compaction, snapshots, sharing, Claude Code configuration, and project configuration are disabled. An explicit loopback rejecting proxy and npm registry block incidental startup fetches. This is application-level isolation, **not an OS network/filesystem sandbox**; the script is intended for this pinned, inspected official binary, not arbitrary executables. Client-generated artifacts remain in the reported temp directory; no request/header capture or client stdout is written to the repository.

## Observed result

Actual pinned-binary run passed in approximately nine seconds with exactly two `POST /v1/messages` requests:

- Fake SSE delivered in seven-byte chunks, including split Unicode, signature and tool-input JSON.
- Next-turn assistant history contained exactly the ordered `thinking → redacted_thinking → tool_use` blocks, with thinking text, signature, redacted-thinking data, tool ID/name/input preserved.
- OpenCode added exactly `cache_control: {type: "ephemeral"}` to the replayed `tool_use`; the strict expected-content assertion includes this observed client-side addition rather than ignoring it.
- The real built-in `read` tool read the one-line synthetic fixture; its matching successful `tool_result` appeared in the next request.
- Parsed client JSON events contained exactly the final text marker, no error event, and the two successful `step_finish` reasons `tool-calls → stop`; the final event was `step_finish` and the client exited successfully.
- Only `read` was exposed; one offline npm-registry request and one official-release proxy attempt were rejected. Neither was forwarded.

Failures exit nonzero and print bounded counts/flags; synthetic-only tool error/stderr may be retained inside the isolated temp directory for diagnosis. There is a 60-second run deadline and a 1MiB fake-provider request bound.

This is **direct-client → fake Anthropic** evidence, not a stock LiteLLM, relay-chain, billing, real signature validity, arbitrary unknown-block, signed-empty-text separator, cancellation, persistence-across-processes, or real upstream entitlement test. The signature/data are synthetic; the test checks the specified round-trip subset, not cryptographic acceptance. OpenCode itself is not a byte-transparent client: it generates requests through an SDK, adds the observed cache marker, [changes empty text separators around signed reasoning](https://github.com/anomalyco/opencode/blob/aec0b9a6d8898f68f923aaf08b7306d931fd9d76/packages/opencode/src/session/message-v2.ts#L266-L287), and changes reasoning replay when switching models. Keep the same provider/model for this fidelity fixture.

## Pinned source cross-check

The pinned client's [reasoning filter](https://github.com/anomalyco/opencode/blob/aec0b9a6d8898f68f923aaf08b7306d931fd9d76/packages/opencode/src/provider/transform.ts#L182)
retains empty reasoning when signature or redacted metadata exists. The
[Anthropic prompt converter](https://github.com/vercel/ai/blob/85464f4e2026d9fc0274424c0171a25742836411/packages/anthropic/src/convert-to-anthropic-messages-prompt.ts#L601)
then restores signed thinking even with empty text. Empty reasoning is therefore
not categorically lost by this pinned native-client path.

For multiple signature SSE events, the [SDK emits each signature in metadata](https://github.com/vercel/ai/blob/85464f4e2026d9fc0274424c0171a25742836411/packages/anthropic/src/anthropic-messages-language-model.ts#L2267),
while [OpenCode replaces that metadata](https://github.com/anomalyco/opencode/blob/aec0b9a6d8898f68f923aaf08b7306d931fd9d76/packages/opencode/src/session/processor.ts#L294).
This explains the chain fixture's last-fragment-only stress result. The
[official streaming contract](https://platform.claude.com/docs/en/build-with-claude/streaming#thinking-delta)
describes a signature event before block-stop and explicitly a single signature
for omitted thinking. Multiple signature events are not the same test as one
event split across network writes, and the stress result is not proof that
production Anthropic routinely emits that shape. The native relay does not
rewrite SSE or fabricate missing client history to conceal the result.
