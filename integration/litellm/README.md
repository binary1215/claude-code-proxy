# LiteLLM 1.103.1 native-Claude preservation patch

Pinned upstream: [`v1.103.1`, `580bde9a2d148714889ec1c04a9872819e78a778`](https://github.com/BerriAI/litellm/tree/580bde9a2d148714889ec1c04a9872819e78a778).
This patch belongs in the **separate LiteLLM service**, not in the native relay.
It does not add credentials, provider access, account pooling, or authorization.

## Apply before starting LiteLLM

Use a fresh, uncompiled Python install of the exact version. For example, in a
dedicated virtual environment or image:

```sh
python -m pip install 'litellm[proxy]==1.103.1'
python integration/litellm/patch_litellm.py --check
python integration/litellm/patch_litellm.py
```

Then set `LITELLM_NATIVE_ANTHROPIC_STRICT_THINKING=1` in the LiteLLM process
environment and restart it. Route the model with LiteLLM's direct `anthropic/`
provider and point its `api_base` at the native relay. Configure authentication
through the deployment's normal secret mechanism; this folder contains no
deployment credentials or complete deployment configuration.

The installer checks all six upstream Git blob identities before changing any
file. It refuses different source versions, partial/unreviewed edits and compiled
extensions that shadow the Python modules. Reapplying the exact patch is safe.
`--root` accepts an explicit source root; it still checks all blob identities.
[`native-preservation.patch`](native-preservation.patch) is the equivalent
reviewable unified diff, not an independently maintained implementation.

## Behavior and boundaries

- Chat streaming emits thinking text only in thinking deltas, not a second time
  in signature deltas. The native block handler accumulates signature fragments
  and emits one completed signature at each thinking `content_block_stop`.
  The stream builder keeps signed thinking with empty text and keeps consecutive
  signed-empty blocks distinct.
- Responses streaming creates a reasoning item even when its first meaningful
  delta contains only a signature or redacted data.
- Native Messages forwards caller `anthropic-beta` values to direct Anthropic.
  Translated providers keep their existing filtering.
- **Opt-in strict native Messages** preserves original history instead of removing
  empty blocks, normalizing tool IDs, flattening web-search results, or dropping
  advisor/encrypted reasoning blocks. It disables the internal HTTP-error retry
  that deletes thinking/redacted thinking and retries without top-level thinking.
  Invalid signed history therefore remains an upstream error, not a silent
  unsigned continuation. These native preservation changes are disabled unless
  the environment variable is exactly `1`; translated providers remain unchanged.

This is not full JSON pass-through inside LiteLLM: model selection, supported
parameter handling and other normal LiteLLM transformations still exist. The
native relay should preserve the resulting Anthropic request/response itself.
Ordinary router retries/fallbacks are a separate deployment concern; configure
them to avoid silently changing the model/account or retrying a rejected signed
history. This patch does not alter Chat/Responses general retry policy.

Clients must replay native thinking/redacted blocks unchanged. Chat clients must
retain the assembled `thinking_blocks`, not just `content` or `reasoning_content`.
Responses clients must replay the full output, including reasoning
`encrypted_content`, function calls and call IDs; the Anthropic bridge uses that
field as serialized opaque blocks, **not as an encryption guarantee**. A client
which drops those fields cannot recover continuity through this patch.

`previous_response_id` state lookup, database persistence, session/account
stickiness, cross-provider signature portability and arbitrary stream reordering
are not implemented by this patch. Cache markers/TTL and usage fields can be
preserved, but a synthetic transport test cannot prove a real cache hit, token
saving, or acceptance of a synthetic signature by Anthropic.
The converted streaming regressions include two signature fragments per block,
consecutive signed-empty blocks, and signed thinking before/after a tool block.
They check opaque block order within reasoning, complete signatures, tool IDs
and arguments on assembly and replay. Chat/Responses are converted formats and
may regroup thinking before tool calls in the replayed native message; they do
not promise the original interleaving of every native content block. Use native
Messages when exact native ordering is required. Native SSE is forwarded without
reconstructing those deltas. Malformed/interleaved/incomplete provider streams
are not repaired into valid signed history by this patch.

## Offline verification

In the patched environment:

```sh
python integration/litellm/test_patch.py
python integration/litellm/test_transport.py
npm run build
python integration/litellm/test_transport.py --via-proxy
```

The first suite checks exact/idempotent installation, fail-before-write source
mismatch/compiled-extension guards and reproducibility of the committed diff.
The second calls the **installed LiteLLM HTTP transport**, not a mock completion,
against a temporary `127.0.0.1` fake Anthropic server. It checks native JSON/SSE,
beta/cache/tool preservation, visible signature errors with no stripping retry,
default opt-out behavior, translated-provider isolation, Chat signed/empty-signed
assembly and replay, and Responses item lifecycle/cache metrics/full-output replay.
Both converted paths also cover fragmented signatures and multiple native
thinking block boundaries (including consecutive signed-empty blocks).
Only a dummy local key is used; no provider call or deployment is made.

`--via-proxy` (or `LITELLM_TEST_VIA_PROXY=1`) runs the same transport tests through
the current built `dist/app.js` native proxy: installed LiteLLM → real proxy →
fake Anthropic. The child listens only on an ephemeral loopback port, uses an
in-memory database and a random local admin secret, provisions a random proxy
key with authentication enabled, and raises only that temporary key's RPM limit.
It removes inherited OAuth credentials and uses a different dummy upstream API
key. Assertions verify that the caller's proxy key is not forwarded upstream.
The child is tracked and terminated during test cleanup, including setup failure.
Use `LITELLM_TEST_NODE=/absolute/path/to/node` if Node is not on `PATH`.

This does not exercise LiteLLM's deployed FastAPI router/authentication layer, a
real Claude credential, a Docker deployment, or provider-policy approval.
Do not assume that protocol compatibility authorizes a credential's use.
