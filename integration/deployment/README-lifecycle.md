# Isolated Docker lifecycle fixture

This synthetic qualification uses two **already local**, exact Docker image IDs. It never builds or pulls images, contacts a provider, publishes a port, reads existing containers/data, or operates on production resources. Run it on the Docker host; the script does not SSH or change the Docker context.

```sh
python3 integration/deployment/lifecycle_smoke.py \
  --baseline-id sha256:12d35112176de03ab3d1e2ae46a91a8ca6a98168478c98fd6aaf37fcb9b85fc3 \
  --candidate-id sha256:8e7e8f474262dde1ed995ddb99c7b4086c26e15ad2c41b1ea3f8bb8eaed989aa
```

Baseline is the qualified `0ca7575` image; candidate is the qualified `98d26fe` image. Tags are documentary only and are never executed. The IDs are a closed qualified pair, not defaults permitting an arbitrary image or approval for service replacement. Docker CLI access is required and consequential: audit the fixture before running it.

The first seven phases share one fresh opaque-named, owner-labelled local volume.
An eighth phase restores the seed backup into a second fresh volume:

1. Baseline: provision active/revoked synthetic API keys and an exact model ACL through the actual admin HTTP API; save a successful native history row.
2. Baseline re-creation: verify the same key/ACL/revocation/history and another native request.
3. Candidate upgrade: mint streamed Responses output containing signed nonempty thinking, signed-empty thinking, redacted thinking, and text. Native SSE uses fragmented signature events and seven-byte UTF-8/CRLF wire chunks. Require identical sealed reasoning items in done/completed events.
4. Candidate re-creation: replay the persisted output under the same state key/principal/model/upstream scope, and compare the exact ordered native assistant blocks. No tools are offered or run.
5. Changed state key: require `409 invalid_reasoning_state` before any fixture provider call or new history row.
6. Baseline rollback: require native Messages success and Responses `404`, without provider contact for the unsupported route.
7. Candidate re-upgrade using the original state key: require exact original state replay again.
8. Backup restore: mount the original synthetic volume read-only; copy only the completed seed backup into a new volume, with overwrite prohibited. Verify its byte digest before opening, integrity/foreign keys, the original key/model/revocation/history, and a new signed-state replay using separately retained configuration/client history. Expect one restored row, not the six rows in the newer source DB; five post-backup rows are deliberately absent. One new successful request brings the restored history to two. Source backup, live DB and private fixture file hashes must remain unchanged.

Each phase verifies persisted key policy, revoked-key rejection, exact original history row preservation, no stored prompt/response/preview, exact usage/cache/TTL counters and unknown price, and exact history/provider counts (no hidden retries). After seed, `db.backup()` makes a synthetic SQLite snapshot; a separate read-only connection checks its integrity and row count. The final restore phase tests this exact backup/image pair, not existing production data or arbitrary older schema migrations. A state key and client history are restored separately from the synthetic private fixture file; the DB itself does not contain them. No post-backup revocation/settings reconciliation is automated.

The Node helper imports the image's actual `/app/dist/app.js` and database bootstrap, then hosts app and fake Anthropic on fixed container-loopback ports. It does **not** execute `dist/server.js`. Each phase is a fresh container/process, not `docker restart`; migration/startup runs repeatedly. Network is `none`; there are no host-published ports or bind mounts. Runtime is UID/GID 1000, read-only rootfs, dropped capabilities, no new privileges, bounded PID/memory/CPU, and a small noexec/nosuid/nodev tmpfs. The restore phase alone has two volume mounts, with distinct source/target identities and a read-only source. The orchestrator checks mounted-volume ownership before execution and inspected runtime settings afterward.

Only the synthetic volumes store generated local API credentials/state key/capsules. Reports never include those values, bodies, signatures, exception text, or arbitrary app/Docker logs. Each Node phase has a 20-second deadline; Docker phase commands have a 35-second deadline, other commands 15 seconds, with 64KiB aggregate stdout/stderr bounds. Phases are not automatically retried. Exit zero requires all phases **and cleanup** to pass. `backup_restore_qualified` reports only the bounded synthetic restoration described above.

Cleanup only removes exact created names after verifying owner/kind labels and exact container image identity. No list/prune/glob cleanup is used. Cleanup refusal/failure produces `remaining_resources` with exact opaque names and exit one. Do not blindly remove listed resources: independently inspect the owner labels first. Failed cleanup can leave synthetic credentials on the retained volume; treat it as sensitive until safely removed.

Local non-Docker checks:

```sh
node --check integration/deployment/lifecycle_phase.mjs
python3 -m unittest discover -s integration/deployment -p 'test_*.py'
```

Limits: this is direct synthetic HTTP qualification, not an actual client/LiteLLM or paid-provider session, deployment approval, production backup restore, crash recovery, in-flight drain, graceful termination, rate-limit continuity, or high availability. Rate-limiter windows and task tracking are in memory and reset on re-creation. Migrations in the two images are currently identical, so repeated startup/rollback checks do not prove future schema reversibility. Capsule TTL is one hour for this fixture; expiry, foreign principals/models/upstreams, corrupt volumes and live key rotation are outside its bounded lifecycle cases. The same upstream credential/origin is intentional for state binding. Real signing/entitlement/provider acceptance is not established by synthetic signatures.

The 2026-10-05 `.64` host execution passed all eight phases and cleanup; seven guard tests passed locally and on the host. See [the exact images](../../docs/VERIFICATION.md#isolated-docker-lifecycle-qualification) and [restoration evidence/result hash](../../docs/VERIFICATION.md#fresh-volume-backup-restoration-extension). The earlier seven-phase capture is retained separately. These rehearsals do not authorize a service cutover or make future image pairs compatible.
