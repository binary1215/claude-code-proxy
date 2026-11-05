# Official CLI refresh probe

This black-box probe runs an **unmodified official Claude Code 2.1.318 binary**
against a local fake HTTPS authentication service. It does not use an account,
copy an existing credential store, modify the CLI, install a system certificate,
or submit model prompts. The CLI uses a temporary config/home directory and
synthetic credentials. A certificate is trusted only by that child process;
TLS verification remains enabled. The local proxy never forwards connections.

Requirements: Python 3, `cryptography`, and the official CLI binary. Use an
isolated test environment; the harness intentionally avoids global installs.

```sh
python integration/auth/probe_cli_refresh.py --cli /path/to/claude --output /tmp/cli-refresh-results.json
```

The test asserts fresh, near-expiry, expired, revoked-refresh and transient-error
behavior. It records paths and boolean observations, never a real credential.
Its `--output` file is safe evidence. `--coordinator` instead probes a wrapper
running `claude-auth refresh`, checking session continuity, terminal/backoff
suppression, and cross-process lock exclusion on Linux. The wrapper's `--version`
must still report the pinned official CLI version.

## Observed on 2026-11-05

The official Windows x64 npm package was downloaded at version 2.1.318 and its
archive SHA-512 matched the registry integrity metadata. All five cases passed:

| Stored access token / auth service | `claude auth status` result | Stored credentials |
| --- | --- | --- |
| Eight hours remaining | Exit 0, logged in | No refresh |
| Two minutes remaining | Exit 0, logged in | Access and refresh tokens replaced; expiry advanced |
| Expired | Exit 0, logged in | Access and refresh tokens replaced; expiry advanced |
| Expired; refresh returns `invalid_grant` | Exit 1, logged out | No successful refresh |
| Expired; refresh returns HTTP 503 | **Exit 0, logged in** | **Still expired; no successful refresh** |

Successful near-expiry/expired runs made a refresh-token grant to
`/v1/oauth/token` and a profile lookup at `/api/oauth/profile`. No Messages/model
request appeared at the fake service. A fresh token needed only a profile lookup.

This is direct observed behavior of this version, not a documented guarantee
that `auth status` is a refresh API. The public command reference describes it as
a status command, and the executable advertises no standalone `auth refresh`.
The HTTP 503 result is why a scheduler must check the stored expiry/readiness
after the command, not trust exit code 0 or `loggedIn` alone.

The initial Linux run was delayed by server resource pressure and SSH timeouts.
After access recovered, the same five cases passed inside the exact Linux image.
A separately authorized live check then moved only local expiry metadata to
90 seconds ahead and ran official CLI auth status: access and refresh tokens
changed, expiry advanced, and account identity was unchanged. No model prompt
was submitted, and old tokens were never restored. These are separate results
from the Windows fixture run.

## Consequence for the proposed implementation

The implemented CLI-owned refresh path keeps model requests in the
native relay: invoke the pinned official `claude auth status` near expiry,
serialize it with login/logout, then reread the credentials and verify a usable
expiry. Treat temporary network/provider failures separately from revoked login.
The existing **`claude-auth status` helper only reads the file** and does not run
that official command; the hyphenated helper is not the refresh trigger.

The opt-in scheduler and login-session continuity now implement this behavior;
see [container auth](../../docs/CONTAINER-AUTH.md) for lifecycle and crash limits.

References: [official CLI reference](https://code.claude.com/docs/en/cli-reference),
[official authentication guidance](https://code.claude.com/docs/en/authentication).
