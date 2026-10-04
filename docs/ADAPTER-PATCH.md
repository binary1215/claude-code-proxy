# Native relay migration (breaking change)

This supersedes the historical SDK adapter implementation. The SDK execution path, SDK-dependent tool bridge, host-tool execution, Chat-to-prompt translator and SDK error-text classifier have been deleted. There is one HTTP generation path, not a compatibility mode.

## Before deploying

1. Back up the existing SQLite database consistently (stop the service or use SQLite's backup API), including the active data volume. Keep the previous image and private configuration for rollback. Do not delete the volume.
2. Verify your upstream's permitted authentication independently. Setup-token environment input is retained, but native acceptance of subscription credentials is **not established** by offline tests. Do not assume removal of the SDK preserves subscription behavior.
3. Configure `ANTHROPIC_BASE_URL` and one upstream credential. DB credential overrides still win. Native HTTP upstream failures are returned unchanged, without SDK fallback or paid-key failover.
4. Move OpenAI Chat/Responses clients to the separate LiteLLM gateway. The proxy now exposes only native generation/count/models, plus the unrelated existing Ollama embeddings endpoint.
5. Move budgets to LiteLLM; place system prompts and cache controls in client/gateway requests. Clear old non-null key fields with the admin API:

```json
{"monthly_budget_usd":null,"system_prompt":null,"cache_ttl_seconds":null}
```

6. Re-run the proxy tests and stock LiteLLM HTTP suite, then test each real coding client's replay behavior before rollout. Do not install the withdrawn LiteLLM source patch. Preserve reasoning payloads across tool turns. Do not route signed history to a different backend account silently.

## Stored data

The SQLite migration retains API keys, settings and history. It transactionally rebuilds the old request-log table to permit unknown input/output/cost (`NULL`), then adds separate cache read/write/TTL counts and `usage_complete`. Historical numbers remain historical numbers; they are not reinterpreted as newly verified billing. Existing full prompt/response columns and rows are retained, but new records leave their content null. Backups and old rows may contain earlier data.

Removed key-setting columns may remain as inert/migration metadata so upgrading does not silently erase user data. They do not enable legacy execution. Non-null budget/system/cache settings explicitly block requests until an administrator migrates and clears them. New settings of those types are rejected. Built-in-tool grants have no runtime consumer or UI control.

## Operational limits

- Unknown billed USD remains null. The proxy does not calculate provider/account prices or enforce dollar budgets.
- Per-key RPM/observed-token TPM and model allowlists remain. TPM is best effort, not a preflight reservation. Count-token requests do not add generation usage to the TPM window.
- A side-channel parser observes up to 4 MiB JSON or 1 MiB per SSE line/event; it discards its observation buffer if exceeded while transport continues. Compressed upstream bytes are forwarded without decoding or inferred usage.
- New logs contain operational metadata only. Failure text is reduced to an allowlisted category. DB upstream credentials remain plaintext, not encrypted.
- Safe diagnostics are added as nullable fields; old rows remain unknown. A separate 64 KiB JSON/SSE-event observer records only validated status/type/code/request-ID/retry/quota/auth metadata. Raw error messages and request/reply bodies are not retained. Generic 429 remains `unknown_429`; headers are observations, not a quota or entitlement verdict.
- Midstream errors, missing terminal SSE events, client disconnects, administrative cancellation and timeouts do not fabricate a complete successful usage record. No transport retry is performed.
- Docker files remain non-root and SDK-free. Local Node tests and admin builds do not prove a Docker image build, live OAuth eligibility, real cache hits or production LAN behavior.

Rollback requires restoring the prior image/configuration and the consistent pre-migration database backup as a unit. Do not point older code at a migrated database and assume schema compatibility.
