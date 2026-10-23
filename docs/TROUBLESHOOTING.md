# Diagnose the rejecting hop and observed usage

The deployment has three independent authentication boundaries:
client → LiteLLM gateway → Claude proxy → configured Anthropic upstream.
An HTTP number alone does not identify which boundary rejected a request.
Neither the diagnostics nor the routes automatically retry, change credentials,
impersonate a client, or switch to paid usage.

## Read the evidence from the component that answered

| Observed evidence | Where to investigate | What it does not establish |
| --- | --- | --- |
| LiteLLM response `401` with `expired_key` | That gateway key's expiry; renew through the gateway administrator | Claude OAuth or proxy API key expiry |
| LiteLLM route-permission `403` | The exact requested path and key's permitted routes | Anthropic refusal or a client-wide ban |
| Proxy Responses response with `error.code`, for example `invalid_reasoning_state` | The adapter's request/state contract and client replay | A provider subscription restriction; validation may reject before any upstream request or history row |
| Proxy history `upstream_http_status` `401`/`403` | The configured upstream credential/permission response | LiteLLM's key or route policy |
| Proxy history `upstream_http_status: 400` and `upstream_diagnostic: third_party_plan_usage_restriction` | The upstream's refusal of that request's third-party plan/extra-usage path | Exhausted subscription allowance, the exact client-detection trigger, a guaranteed workaround, or permission for paid fallback |
| `unknown_429` | Allowlisted response headers, provider/account status and a bounded diagnostic investigation | Whether the cause is quota, rate limit or missing entitlement |

Gateway-rejected requests never reach the proxy, so their diagnostics cannot be
reconstructed from proxy history. A missing proxy row alone also does not prove
gateway rejection: local adapter validation, connectivity or logging problems
may explain it. Keep the client's response, exact route, test time and safe
request IDs together; do not copy keys, prompts, thinking or raw provider prose
into a public issue.

### Message classification is not a provider error code

The passive observer recognizes the previously observed plan-refusal wording
only in an observed HTTP `400` error with type `invalid_request_error`, when its
message contains all of: third-party, Claude, plan, extra usage and a billing/
draw wording. It stores the fixed local diagnostic
`third_party_plan_usage_restriction`, not that message. This intentionally narrow
heuristic can miss changed provider wording; unrecognized errors remain generic.
It does not identify why the provider classified a particular client request.

`upstream_error_code` separately retains only an allowlisted code actually
provided in `error.code` or `error.details.error_code`; absent or unrecognized
codes remain null. The observed upstream HTTP status is preserved. Body parsing
may be unavailable (for example compressed, too large or incomplete), which is
recorded in `upstream_body_observation`, not silently treated as a known cause.
Timeout/cancellation remains the final transport disposition when it supersedes
an already observed message classification.

New classification applies to newly observed requests. Historical rows cannot
be reclassified from stored prose because raw error messages are not retained.
There is no database migration or policy gate for this diagnostic addition.

## Usage and cache accounting

History shows provider-observed counters, not inferred input charges:

- **Fresh input**: native `input_tokens`, excluding cache read/write counters.
- **Cache write**: `cache_creation_input_tokens`; 5-minute and 1-hour fields are
  subsets, not extra tokens to add again.
- **Cache read**: `cache_read_input_tokens`.
- **Total input**: fresh + cache write + cache read, only when all three counters
  are known; otherwise `Unknown`.
- **Output**: native `output_tokens`, not a separately inferred thinking charge.
- **Usage complete**: a successful terminal response and valid input/output
  observations; individual cache counters can still be unknown.
- **Cost**: the recorded cost, or `Unknown`. Native relay usage does not provide
  an authoritative billed USD amount, so the proxy does not calculate one here.

Streaming counters are cumulative observations, not chunks to sum. Failed,
cancelled or truncated responses may retain partial usage. Missing counters are
null/`Unknown`, never assumed zero. An explicitly reported zero remains zero.

LiteLLM's custom pass-through routes may not populate its token/spend accounting
with these counters. A gateway total of zero does **not** establish free use,
nor does a cache-read counter prove the account's exact invoice or subscription
allocation. Use the provider's account/billing record for that determination.
The proxy history is observational evidence, not a billing statement.
