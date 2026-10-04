# Bounded request-shape comparison

This opt-in, **test-only** observer compares an unmodified official Claude Code
request with a minimal raw request. It is not a production gateway, OAuth login
service, CLI backend, request rewriter or client-identity emulator.

Build the relay first (`npm run build`). The executable requires
`DIAGNOSTIC_LIVE_OPT_IN=1`, `CLAUDE_CODE_OAUTH_TOKEN` and a dedicated
`DIAGNOSTIC_PROXY_KEY` in private process/container environment. Credentials must
never be passed as command-line values, committed or pasted into logs.

The live runner binds an ephemeral port on **127.0.0.1 only**, forwards directly
to `https://api.anthropic.com/` or to the specifically authorized test relay
`http://192.168.0.64:13457/`, and permits at most 12 requests with a 60-second
per-request upstream deadline. Run only in an isolated temporary container,
without published ports, project mounts or persistent Claude sessions. Fixed
test destinations are intentional; changing them requires reviewing the scope.

Routes are `/direct/v1/messages`, `/relay/v1/messages`, the corresponding
`messages/count_tokens` routes, and `/v1/models` under each prefix. Requests
must present the exact diagnostic OAuth bearer credential. Competing `x-api-key`
or `Connection: authorization` is rejected. Direct requests retain the bearer;
the relay route substitutes the separate test-proxy key. The actual proxy then
selects its configured upstream credential. Verify it matches before comparison.

The observer does not inject system text, beta flags, user-agent or other client
identity. It retains body bytes, forwards response bytes, strips only HTTP
hop-by-hop framing, and does not retry or follow redirects. Actual official CLI
calls use only `ANTHROPIC_BASE_URL` to select a route while retaining normal
OAuth login. Do not copy captured official request content into another client.
The CLI still owns its internal retries and model transitions; count observed
requests and reported model usage rather than assuming one invocation is one call.

Authenticated `POST /_control/phase` accepts only `raw_before`,
`official_direct`, `official_relay`, or `raw_after`. The recommended comparison
is sequential, on one host/account/model, with a short synthetic prompt and
raw probes bracketing the two CLI routes. Stop and remove only owned temporary
containers afterward; compare existing service identity/image/start time.

## What may be recorded

- Closed enums, presence bits, byte lengths and counts: known fields, known
  model IDs/families, beta allowlist, message/block types, signature presence,
  tool count, thinking type/budget, and cache-marker type/TTL.
- Bounded response diagnostics and usage from the production passive observers.
- Unknown names/values are never emitted; only unknown counts are retained.
  Prompt text, tool names/schema, metadata values, tokens, signatures, opaque
  payloads, query values, content hashes and raw error messages are not logged.
- The summary is limited to 10 MiB input, 32 messages, 32 blocks per array,
  256 total blocks, 64 tools, 16 system blocks and depth 2. Truncation is explicit;
  sampled cache-marker counts are not necessarily the entire request's count.

No logs does not mean no exposure: the observer must briefly handle credentials
and request bytes in memory to forward them. Protect the host and Docker access.
The fixed test relay uses LAN HTTP, so that hop is not encrypted. Keep reports
private even though content is excluded. Shape differences can suggest a cause;
they cannot identify an undocumented provider-side eligibility rule.

## Offline checks

```sh
npm run build
node --test tests/shape-observer.test.mjs tests/diagnostic-transport.test.mjs
```

The imported server's `offline: true` mode permits only HTTP loopback fake
upstreams. Tests cover unchanged input/output, credential isolation, safe
reporting, request limits, timeout/cancellation and adversarial secret strings.
See [verification](../../docs/VERIFICATION.md) for actual observations and limits.
