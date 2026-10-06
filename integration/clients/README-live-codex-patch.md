# Linux Codex live patch smoke

This standalone Python 3 standard-library runner uses the existing official
**Codex 0.160.0** Linux binary. It needs no PyYAML, local LiteLLM, relay, Node,
or imports from other harnesses. Run it inside the isolated Linux test container
prepared by the operator. The harness does not install binaries, configure a
service, enable relay features, or read provider credentials.

Preflight the actual client's writing and sandbox behavior without a gateway
credential or remote inference:

```sh
python3 -B codex_patch_live_smoke.py --offline --codex /opt/codex/bin/codex \
  --output /tmp/codex-patch-offline-new
```

After the operator enables the relay's validated apply_patch mode and supplies
an existing gateway key in the named environment variable, use a separate run:

```sh
python3 -B codex_patch_live_smoke.py --live --codex /opt/codex/bin/codex \
  --gateway-key-env CODEX_PATCH_GATEWAY_KEY --output /tmp/codex-patch-live-new
```

Key options take variable **names**, never key values. No credential belongs in
command arguments or files. Offline mode never reads that variable. Output must
be a new directory under the system temporary directory. Both modes retain the
safe `codex-patch-live-smoke.json` report there.

The runner starts a fresh Codex app-server with fresh home, `CODEX_HOME` and
workspace. A limited test catalog offers the actual freeform/grammar
`apply_patch` tool while disabling shell; search and agents are disabled. This
catalog is explicitly not official Claude metadata. The actual sandbox is
requested as **workspace-write**, approval policy **never**, with no bypass or
automatic approval. Each turn also supplies a workspace-write sandbox policy.
Unexpected app-server approval/dynamic-action requests stop the test.

The first turn applies the supplied patch to create `fixture.txt` containing
exactly `SYNTHETIC_PATCH_CREATED` plus a newline. A second turn on the same actual
thread updates it to exactly `SYNTHETIC_PATCH_UPDATED` plus a newline. The
harness never creates or edits that file. It checks actual completed
`fileChange` events, the apply_patch call and returned tool result, final file
bytes, and the single-file workspace. A text success marker alone cannot pass.

Live mode's sole observer forwards received request bodies and response SSE
unchanged to `http://192.168.0.7:4000/claude-responses/v1/responses` for real
`claude-haiku-4-5-20251001`. It makes no direct `.64` call. At most **four**
outgoing attempts are permitted, two per turn, counted before connect/write.
Codex request/stream retries are zero; there is no observer retry, redirect,
fallback, prompt repair, or replay after uncertain failure. Any failed phase
prevents the update turn. The existing gateway's internal retries and its
relay-ingress bytes remain unobserved.

Offline mode serves deterministic Responses events from the same loopback
listener, including the fixed create/update patches and clearly synthetic
opaque reasoning. It makes **zero** remote requests. The actual Codex client
must still perform both real file writes; the fake never writes files. Offline
success verifies only this client's local patch/sandbox/protocol behavior, not
the relay's grammar validation, real model output, credentials or signatures.

The safe report includes request counts, terminal statuses, completed/failed
file-change counts, tool-result presence, exact-file booleans, safe failure
codes and numeric usage/cache fields. Opaque reasoning IDs/ciphertext are
compared in memory across output-item-done, response-completed and subsequent
client replay. Absent reasoning stays unobserved and cannot become a positive
signature claim. Those diagnostic checks are independent of functional file
editing success; the harness does not validate provider signatures itself.

Raw bodies, patches received from the model, SSE, opaque state, RPC events,
client stderr and provider error text are not exported. Only the static test
catalog, safe report and actual client files are retained. **Codex's own fresh
session history naturally may contain generated prompts, replies and opaque
reasoning.** Keep the test output directory private when retained. Normal user
homes, login state and installed client configuration are never copied or edited.

Bounds are 1 MiB per request, 4 MiB per captured response, 75-second HTTP/stream
idle timeout, 120-second turn waits and 30-second RPC acknowledgements. RPC
observation is bounded to 5 MiB/1,500 messages plus 1 MiB drained stderr. Owned
client/listener processes are stopped on exit. No OS sandbox installation or
privileged host configuration is performed; a container sandbox limitation is a
reported failure, not permission to bypass it.

## Observed first preflight (2026-10-06)

The default non-root, network-none Docker preflight reached the actual
apply_patch tool and returned its result through two fake Responses requests,
but the fileChange failed and no fixture was written. A separate sandbox probe
reported bubblewrap could not create a namespace. No live gateway call followed
and no sandbox bypass was used. See the
[deployment evidence](../../docs/evidence/validated-patch-enable-20261006.json).

## Approved scoped container settings and live result

After explicit user approval, the test container retained non-root UID1000 and
`--cap-drop ALL`, with a copy of Docker's actual effective default seccomp rules
plus `clone`, `unshare`, `mount`, `umount2` and `pivot_root`. AppArmor remained
enforcing through a uniquely named copy of the exact Docker 29.4.0 vendored
default profile, allowing mount/pivot_root for the inner Codex sandbox. Neither
profile was disabled and no host-wide setting or existing container changed.

Offline create/update then passed. The actual `.7` → `.64` → Haiku run also
passed in **four** requests: two completed fileChanges, matching tool results,
exact created/updated file bytes and five observed opaque replay checks.
Reported patch-text equality is false only because both model patches include
one terminal newline; actual file contents match exactly. Relay DB usage agrees
with provider-observed input/output, with no cache read/write in this short run.
This is a patch-only fixture, not general shell or repository-work qualification.

The ephemeral client containers were removed and the dedicated AppArmor profile
unloaded afterward. Private output stays in the dedicated test directory.
Re-running requires an operator-prepared supported sandbox environment; the
harness never changes those permissions itself. See
[safe live evidence](../../docs/evidence/client-patch-live-20261006.json) and
[verification details](../../docs/VERIFICATION.md#approved-namespace-support-and-actual-file-editing).
