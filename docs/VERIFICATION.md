# Native relay verification — 2026-10-05

Environment: Windows, Node 24.19.0, Python 3.12.14, installed LiteLLM 1.103.1.
The proxy test DBs were in-memory. All provider transport tests terminated at
loopback fake upstreams using synthetic credentials. No live account token was
used, no production service was changed, and no provider bill was incurred.

| Check | Result |
| --- | --- |
| `npm test` (TypeScript build + native HTTP/SQLite tests) | 31/31 passed |
| `npm run build` in `admin/` | Next.js production build passed |
| `python integration/litellm/test_patch.py` | 4/4 passed |
| `python integration/litellm/test_transport.py` | 10/10 passed |
| `python integration/litellm/test_transport.py --via-proxy` | Same 10/10 passed through the real relay |
| `npm audit --omit=dev` in repository root | 0 reported vulnerabilities at verification time |
| `git diff --check` | Passed |

## What these checks establish

- Raw JSON/SSE/encoded-response fidelity, native thinking/signature/redacted and
  tool-result replay (including `is_error`), unknown fields, cache markers/TTLs.
- Separate caller/upstream credentials, beta forwarding, fixed endpoint/base URL
  normalization, no redirect following or relay-side retry.
- Cache read/write/TTL counts, cumulative usage handling, unknown versus zero,
  incomplete/error streams, non-authoritative bounded observation.
- Caller/admin cancellation, header/stream deadlines, upstream socket abort,
  task cleanup and exactly one terminal history update.
- Existing SQLite history/settings/key preservation, nullable usage migration,
  repeat migration, explicit removal of obsolete key settings.
- LiteLLM source-identity checks and fail-before-write guards; actual installed
  transport calls, not `mock_response` shortcuts.
- Chat/Responses thinking assembly without duplicate text, complete fragmented
  signatures, consecutive signed-empty blocks, opaque replay, tool IDs/arguments
  and selected cache metrics. The same cases pass through an authenticated real
  relay child with a provisioned proxy key distinct from the upstream dummy key.

Independent review also reproduced and verified fixes for false error status on
compressed/oversized observable streams, invalid credential lifecycle leakage,
short-credential preview disclosure, and old-schema migration integrity.

## What remains unverified or limited

- Real subscription OAuth acceptance, provider terms eligibility and token refresh.
- Real upstream cache hits, billed cost, subscription quota or model-quality gains.
- A production Docker image build/start and the deployed LiteLLM FastAPI
  router/authentication/database path. This host had no Docker command available.
- Every coding client's retention of thinking blocks/Responses encrypted content.
- Converted formats preserving original thinking/tool interleaving: they can
  regroup fields. Native Messages is the fidelity-first path.
- `previous_response_id` persistence, account affinity and provider failover.

Observed non-fatal warnings: Next.js workspace-root inference with two lockfiles;
upstream Pydantic `ReadOnly` notices during LiteLLM tests. LiteLLM itself is source
and version pinned; its transitive Python dependencies are not fully locked by
this repository. Re-run checks in the intended deployment environment.
