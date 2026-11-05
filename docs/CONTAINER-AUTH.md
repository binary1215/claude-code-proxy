# Container login with the official CLI

The optional `cli-auth` image target includes pinned, unmodified Claude Code
2.1.318 for **operator-initiated authentication only**. All Messages and Responses
requests still use this project's native HTTP relay. Neither a model request nor
a status probe starts the CLI. LiteLLM requires no source/configuration changes.

## Build and persist login

Build with `docker build --target cli-auth -t claude-proxy:cli-auth .` or use the
`docker-compose.cli-auth.yml` overlay alongside the existing Compose file.
The default image target remains CLI-free.

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

**Automatic refresh is not implemented.** A saved refresh token's presence is
reported as `refresh_available`, but the relay does not use undocumented refresh
endpoints or generate dummy model calls. If the official CLI updates the file,
the new token is picked up. For unattended operation, check `expires_at` and
renew with `claude-auth login` before expiry. Logout:

```sh
docker exec han-claudemock claude-auth logout
```

Subsequent [isolated refresh verification](../integration/auth/README.md) found
that official `claude auth status` in 2.1.318 can refresh near-expiry/expired
credentials without a model request. The hyphenated `claude-auth status` helper
above remains file-only. A production scheduler is still absent, and Linux/live
refresh qualification remains outstanding. Exit code 0 alone is insufficient:
the CLI also returned 0 after a synthetic refresh HTTP 503 with no token renewal.

The next request sees logout immediately; deleting only a DB token does not log
the CLI out. Responses encrypted reasoning state retains its existing binding
to the exact upstream token. **A token change invalidates previous capsules**
(409); start a fresh Responses conversation after re-login/rotation. Native
Messages transport remains unchanged. Account-stable reasoning binding would
be separate work; this change does not weaken the existing credential binding.

## Scope and references

Validation on 2026-11-05 used source commit `2efc59d` and the pinned CLI image:

- Windows: 173 tests passed; the Linux shell-helper test was skipped there.
- Linux image: 170 tests passed, including email argument quoting, callback
  stdin forwarding, environment isolation, both HTTP routes, rotation, expiry
  and logout. Four admin-observability tests then passed with their test-only
  TypeScript dependency mounted separately (174 passing cases in total).
- Actual official CLI `auth login --help` confirmed `--email` prefill and
  subscription login as the default. No CLI binary was modified.

These checks used synthetic credentials and loopback providers. They establish
the adapter behavior, not a real account login, model entitlement, automatic
refresh or end-to-end subscription acceptance.

Container login does not change Anthropic subscription-token usage restrictions
or make native relay acceptance an official guarantee. No paid API fallback or
Claude Code caller impersonation is added. Protect the auth volume and backups.

- [Official authentication](https://code.claude.com/docs/en/authentication)
- [CLI auth commands and email prefill](https://code.claude.com/docs/en/cli-reference)
- [Persistent credentials in containers](https://code.claude.com/docs/en/devcontainer#persist-authentication-and-settings-across-rebuilds)
- [Authentication policy](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use)
