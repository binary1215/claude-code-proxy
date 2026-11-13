# claudemock container login with the official CLI

The default image includes pinned, unmodified Claude Code 2.1.322 and Agent SDK
0.3.322. With the default CLI inference backend, the CLI handles model requests
as well as the supported login/authentication commands. The optional background
refresh worker invokes authentication commands independently of inference.
Credential-store selection and inference-backend selection are separate settings.

## Build and persist login

For the full CLI inference image, use the `docker-compose.cli-auth.yml` overlay
alongside `docker-compose.yml`; the overlay selects the `default` build target
and a persistent auth volume for service `app`.

For explicit HTTP inference with CLI authentication only, build
`docker build --target cli-auth -t claudemock:cli-auth .`. That target defaults to
the HTTP backend. The separate `http` target is CLI-free; the default image is not.

The auth target sets `UPSTREAM_AUTH_SOURCE=claude_cli` and
`CLAUDE_CONFIG_DIR=/home/node/.claude`. Mount a **separate named volume** at that
directory, owned by container user `node` (uid 1000). Docker initializes a new
named volume with the image directory's ownership. Keep `/app/data` persistent
as before; it holds proxy keys and the DB, not a copied CLI token. Persist the
existing Responses state key separately as before.

Set optional `CLAUDE_AUTH_EMAIL=you@example.com` in the container environment.
With the Compose overlay it can be supplied through the private `.env` file.
This is an email prefill, not an email-code delivery endpoint. The helper passes
it as one quoted `--email` argument to official `claude auth login`.

## Interactive login flow

For the Han container on its Docker host:

```sh
docker exec -it han-claudemock claude-auth login
docker exec han-claudemock claude-auth status
```

To supply the email for one login without recreating the container:

```sh
docker exec -it -e CLAUDE_AUTH_EMAIL=you@example.com han-claudemock claude-auth login
```

1. The CLI displays the official login URL. Open it on your own computer.
2. Complete sign-in in the browser. An email sign-in code requested by the
   website belongs in that website; it is not the CLI callback code.
3. If browser callback cannot reach the container, use the URL above the CLI
   paste prompt and paste the resulting **OAuth login code** into that running
   terminal. Keep that terminal alive throughout login. A callback code belongs
   to that login attempt and cannot be replayed into a new attempt.
4. The official CLI writes its credentials in the auth volume. The next relay
   request sees them without a container restart. The helper never stores an
   authentication code in environment variables, the DB, or its own log.

There is no custom web login endpoint, emailed-OTP service, automatic browser
consent, or background login at container startup. An operator can relay the
user's callback code to the same live terminal. Do not post stored access or
refresh tokens in chat. No extra published callback port is needed for manual
code entry.

The official commands remain available as `claude auth login`, `claude auth
status`, and `claude auth logout`. Prefer the `claude-auth` helper here: it uses
the dedicated config directory and removes relay/provider environment overrides
before login/logout. `claude-auth status` is a **local file inspection**, with
`remotely_validated: false`; it prints no token or account details.

## Credential selection and lifecycle

`UPSTREAM_AUTH_SOURCE=configured` is the normal image default and preserves
DB > OAuth environment > API-key environment precedence. `claude_cli` explicitly
selects only `.credentials.json` in `CLAUDE_CONFIG_DIR`; database/environment
tokens never take over when this login is missing, invalid, expired or removed.
Admin token mutations return 409 with CLI login/logout instructions in this
mode, rather than claiming to change the active official login.

Each HTTP request reads a bounded snapshot of `claudeAiOauth.accessToken` and
`expiresAt` from the official CLI store. This Linux file schema is an integration
dependency, not a documented public token-export API. Revalidate it on CLI
upgrades. The relay does not copy credentials into its DB or keep an old token
after file removal. Partial/malformed writes cause temporary unavailability;
the next valid file is picked up automatically. A request already in flight
continues with its originally selected credential.

`claude-auth status`, admin `GET /api/admin/settings/token`, and `/health` expose
local readiness/expiry. Ready means a usable local credential exists, **not** that
the upstream accepts the account/model/client. Missing/expired credentials give
HTTP 503 with login instructions before contacting upstream. Actual upstream
401/400/429 responses are not masked or retried with another account.

Enable **`CLAUDE_AUTH_AUTO_REFRESH=true`** with `UPSTREAM_AUTH_SOURCE=claude_cli`
to start the background refresh worker. It checks on startup and every minute,
invoking official `claude auth status --json` within three minutes of access-token
expiry. The CLI owns the refresh HTTP exchange and credential persistence; the
proxy submits no dummy model calls and implements no private OAuth endpoint.
The normal image/configured-source mode remains unchanged and refresh is opt-in.

The worker checks that credentials actually changed and expiry advanced; CLI
exit code 0 alone is insufficient. Temporary expired-token refresh failures use
bounded backoff (30–300 seconds, attempted on minute ticks). A revoked login or
missing refresh token requires `claude-auth login`. Missing/invalid credentials
never trigger another account or paid API-key fallback. Check the safe `refresh`
object in `claude-auth status` or admin token status, or `auth_refresh` in health.

`claude-auth refresh` runs the same check manually. A Linux `flock` in the auth
volume serializes refresh with helper login/logout across processes. Refresh
skips a busy lock (exit 75), while interactive login/logout waits up to 120 seconds.
The official command has a 60-second worker deadline. New model requests wait
for an ongoing refresh to finish (bounded to 75 seconds); no tools or models are
executed by this authentication work. Use the helper for lifecycle commands so
they participate in the same lock. Logout:

```sh
docker exec han-claudemock claude-auth logout
```

The [isolated refresh verification](../integration/auth/README.md) found
that official `claude auth status` in 2.1.318 can refresh near-expiry/expired
credentials without a model request. The hyphenated `claude-auth status` helper
above remains file-only. Linux fixture and real account refresh validation also
passed on 2026-11-05. Exit code 0 alone is insufficient:
the CLI also returned 0 after a synthetic refresh HTTP 503 with no token renewal.

The next request sees logout immediately; deleting only a DB token does not log
the CLI out. With auto-refresh enabled, a persistent random login-session binding
and verified account/organization identity keep Responses thinking capsules
valid across **coordinator-observed same-account refresh**. Only digests and the
random binding are stored in `.proxy-auth-session.json`; no extra token copies
are made. Keep this metadata in the same persistent auth volume.

Start a fresh Responses conversation when enabling/disabling auto-refresh,
explicitly logging in/out, changing accounts, or replacing credentials outside
the coordinator. Configured-source credentials keep their existing token binding.
If a worker/container crashes after the CLI saves tokens but before committing
session metadata, the next check creates a new binding: auth can recover but old
capsules require a fresh conversation. No thinking is silently removed. Native
Messages transport remains unchanged. Requests already in flight retain their
originally selected credential.

## Scope and references

Initial login validation on 2026-11-05 used source commit `2efc59d` and the pinned CLI image:

- Windows: 173 tests passed; the Linux shell-helper test was skipped there.
- Linux image: 170 tests passed, including email argument quoting, callback
  stdin forwarding, environment isolation, both HTTP routes, rotation, expiry
  and logout. Four admin-observability tests then passed with their test-only
  TypeScript dependency mounted separately (174 passing cases in total).
- Actual official CLI `auth login --help` confirmed `--email` prefill and
  subscription login as the default. No CLI binary was modified.

Those initial adapter checks used synthetic credentials and loopback providers.
The subsequent official browser login completed on the Han account. Automatic
refresh implementation `81a9024` then passed **181 Linux tests**, all five CLI
fixture cases, all five coordinator cases, and actual account refresh. After
deploying with automatic refresh enabled, the background timer rotated both
tokens without a manual refresh command or model prompt. The same account and
session binding survived, and a pre-refresh synthetic reasoning capsule restored
unchanged. The [verification receipts](../integration/auth/README.md#linux-deployment-and-live-timer-verification)
record the exact scope. Existing private settings, named volumes and other
containers were preserved. Model entitlement and real inference were not tested
as part of the authentication rollout.

Container login does not change Anthropic subscription-token usage restrictions
or make native relay acceptance an official guarantee. No paid API fallback or
Claude Code caller impersonation is added. Protect the auth volume and backups.

- [Official authentication](https://code.claude.com/docs/en/authentication)
- [CLI auth commands and email prefill](https://code.claude.com/docs/en/cli-reference)
- [Persistent credentials in containers](https://code.claude.com/docs/en/devcontainer#persist-authentication-and-settings-across-rebuilds)
- [Authentication policy](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use)
