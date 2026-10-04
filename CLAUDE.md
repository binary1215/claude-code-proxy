# Repository development notes

This branch is a native Anthropic Messages HTTP relay. It does not run Claude Code or the Agent SDK. LiteLLM, in a separate container, owns Chat/Responses conversion, model aliases and financial budgets.

Keep the transport and observation paths separate. Preserve JSON/SSE payload bytes, unknown fields, signed thinking and redacted content. Never repair or silently drop opaque history, retry errors, follow redirects with credentials, or execute client tools. Do not log prompts, responses, signatures, credentials or raw error text.

Run `npm test` for the TypeScript build and local HTTP/SQLite regressions. The admin UI uses its own pinned dependencies and `npm run build`; read `admin/AGENTS.md` before UI changes. LiteLLM version-pinned integration fixtures live in `integration/litellm` and never require real provider credentials.

See README.md and docs/ADAPTER-PATCH.md for authentication limitations and migration. Preserve old database data; never claim missing usage/cost is zero. Real provider calls, production deployment and policy eligibility are distinct from local test success.
