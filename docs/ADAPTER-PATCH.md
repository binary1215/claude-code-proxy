# Native relay migration (breaking change)

This supersedes the historical SDK adapter implementation. The SDK execution path, SDK-dependent tool bridge, host-tool execution, Chat-to-prompt translator and SDK error-text classifier have been deleted. All generation uses the configured native HTTP upstream, not a legacy compatibility mode. A separately enabled [new Responses adapter](RESPONSES-ADAPTER.md) translates stateless client requests without restoring any SDK/CLI backend.

## Before deploying

1. Back up the existing SQLite database consistently (stop the service or use SQLite's backup API), including the active data volume. Keep the previous image and private configuration for rollback. Do not delete the volume.
2. Verify your upstream's permitted authentication independently. Setup-token environment input is retained, but native acceptance of subscription credentials is **not established** by offline tests. Do not assume removal of the SDK preserves subscription behavior.
3. Configure `ANTHROPIC_BASE_URL` and one upstream credential. DB credential overrides still win. Native HTTP upstream failures are returned unchanged, without SDK fallback or paid-key failover.
4. Keep clients behind the separate LiteLLM gateway. Native generation/count/models and existing Ollama embeddings remain available. For Codex, explicitly enable the new Responses adapter and a separate stock pass-through route. Normal LiteLLM Chat/Responses conversion is not full-fidelity certified; there is no proxy Chat endpoint.
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

## Native-only update and rollback checklist

The rule above concerns a schema-changing migration, especially the removed SDK
branch. An update from native `0ca7575` to candidate `98d26fe` is a narrower case:
the migration, key-service and history-service sources are unchanged. That source
comparison is not, on its own, a restore test or permission to replace a service.
Use the [isolated Docker lifecycle check](../integration/deployment/README-lifecycle.md)
before a separately authorized cutover. Never roll back into the deleted SDK/CLI
backend to obtain subscription compatibility.

1. Record the **exact target** container ID, immutable image ID, source revision,
   Compose file/project/service, named volume, bound interface/port and private
   configuration location. Do not dump the container environment into logs.
   Retain the old local image; do not rely on a mutable tag or rebuild to recover
   it. Confirm that no other service shares the target data volume.
2. Quiesce incoming work and wait for the authenticated task list to drain before
   stopping the selected service. This application does not implement a durable
   in-flight task queue or a graceful rollout orchestrator. Do not treat a stopped
   container as evidence that interrupted provider work completed or was unbilled.
3. Back up configuration and all required secrets privately, including the
   **unchanged Responses state key** if already enabled. The state key is not
   stored in SQLite. A new key on every container creation invalidates prior
   reasoning capsules. Their replay also requires the same relay key, model,
   upstream URL, provider credential/auth kind and original reasoning item ID.
   Preserve `RESPONSES_STATE_TTL_SECONDS` too: expiry is evaluated against the
   current server setting, not a TTL embedded in the capsule.
4. Make and integrity-check a consistent SQLite backup. This application enables
   WAL: copying a live `proxy.db` alone is not a safe backup. Use SQLite's backup
   API, or stop all writers and preserve the complete database/sidecar set as one
   consistent snapshot. Test restoration in a **new** isolated volume rather than
   overwriting the current one. [SQLite backup API](https://www.sqlite.org/backup.html),
   [WAL precautions](https://www.sqlite.org/wal.html).
5. Replace only the selected test service with the qualified immutable image and
   deliberate configuration. Preserve the existing volume, admin secret, relay
   keys and provider credential. Do not enable Responses or validated apply-patch
   implicitly, change account/model, or run `down -v`, volume pruning or a stack-wide
   update. Container/image export alone does not back up mounted volumes.
   [Docker volume backup](https://docs.docker.com/engine/storage/volumes/).
6. Check local health, admin authentication, existing relay-key authentication,
   revoked-key rejection, model restrictions and old history before admitting
   client work. `/health` is only a local diagnostic, not provider eligibility or
   a gateway end-to-end check. Use separately approved bounded provider probes
   for that next acceptance gate; do not repair a rejection through fallback.
7. If rollback is needed, stop/quiesce the candidate first. For the **exact tested
   native pair only**, an in-place rollback may retain the newer history when
   schema and runtime compatibility were actually verified. Otherwise restore the
   old image/configuration plus its consistent backup into a new volume. Preserve
   the candidate volume for diagnosis; restoring an older snapshot would omit
   later logs, key revocations and settings, which require explicit reconciliation
   before traffic resumes. Never silently resurrect a revoked credential.
8. Recheck the same authentication/model/history controls and the target image ID
   after rollback. Native `0ca7575` has no Responses route: rolling back the image
   restores native service, **not Codex availability**. Keep the original state key
   privately for a later re-upgrade; do not discard client history or strip
   thinking to make the older endpoint accept it.

The SQLite history holds metadata, not resumable conversation bodies. Clients must
retain their own history. Per-key RPM/TPM windows and active-task tracking are
process-local and reset on restart; persisted key limits survive, but consumed
window counters do not. This checklist does not establish crash recovery,
zero-downtime replacement, free-gateway spend enforcement or provider authorization.
