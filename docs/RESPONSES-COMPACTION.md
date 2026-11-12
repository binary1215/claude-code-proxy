# Stateless Responses compaction

`POST /v1/responses/compact` compresses supplied conversation history using the
genuine CLI backend and returns a canonical window for the next Responses
request. The client retains that window. The proxy does not create a response
database or require a live worker to replay it.

This implements the standalone request/output flow described by OpenAI's
[compaction guide](https://developers.openai.com/api/docs/guides/compaction) and
[compact endpoint reference](https://developers.openai.com/api/reference/resources/responses/methods/compact)
using Claude-native context. It does not decode OpenAI ciphertext or provide
every Responses API capability.

## Enable and call

Use the existing enabled Responses configuration, persistent state key and
CLI inference backend:

```dotenv
CLAUDE_INFERENCE_BACKEND=cli
RESPONSES_ENABLED=true
RESPONSES_STATE_KEY=<existing-private-canonical-base64-32-byte-key>
RESPONSES_STATE_TTL_SECONDS=604800
```

No new state key or conversation-storage service is required. The request uses
the same proxy API authentication as `/v1/responses`. An explicit HTTP inference
backend returns `501 compaction_backend_unavailable` for this operation.

The ordinary compact request has `model`, `input`, and optional `instructions`.
The adapter also accepts its existing supported native/options extensions where
needed. This endpoint returns one JSON response; `stream: true` is unsupported.
Current tool definitions may be omitted when the history contains previous tool
calls and results. Historical identities are reconstructed without making those
tools callable again.

```json
{
  "model": "claude-opus-5-5",
  "instructions": "Keep the agreed project requirements.",
  "input": [
    {"role": "user", "content": "The project target is ..."},
    {"role": "assistant", "content": "The current implementation is ..."}
  ]
}
```

The result has the following shape. IDs and ciphertext below are placeholders:

```json
{
  "id": "resp_compact_<generated>",
  "object": "response.compaction",
  "created_at": 1794499200,
  "output": [
    {"id": "cmp_<generated>", "type": "compaction", "encrypted_content": "ccpc1.<authenticated-state>"}
  ],
  "usage": {
    "input_tokens": 1000,
    "output_tokens": 200,
    "total_tokens": 1200,
    "input_tokens_details": {"cached_tokens": 800, "cache_write_tokens": 0}
  }
}
```

If the input includes system/developer message items, those validated items
appear before the compaction item in `output`. Usage numbers in this example
are illustrative. Actual usage describes the compaction provider calls, not
the token size of the returned capsule; missing/incomplete usage returns
`usage: null` rather than invented zero counts.

## Continue with the entire returned window

Replace the old conversational input with the complete returned `output`, then
append the next user message or matching tool results. Preserve the items in
order. Do not extract a visible summary, drop an instruction item or turn opaque
content into a user/system prompt.

This minimal Python example uses only the standard library and private
environment variables. Set `CLAUDE_PROXY_BASE_URL` to the chosen API base,
including `/v1`, and use a model ID accepted by that route.

```python
import json
import os
import urllib.request

base = os.environ["CLAUDE_PROXY_BASE_URL"].rstrip("/")
model = os.environ.get("CLAUDE_PROXY_MODEL", "claude-opus-5-5")
headers = {
    "Authorization": "Bearer " + os.environ["CLAUDE_PROXY_API_KEY"],
    "Content-Type": "application/json",
}

def post(path, payload):
    request = urllib.request.Request(
        base + path, json.dumps(payload).encode(), headers, method="POST"
    )
    with urllib.request.urlopen(request, timeout=300) as response:
        return json.load(response)

instructions = "Keep the agreed project requirements."
history = [
    {"role": "user", "content": "The target is a two-file implementation."},
    {"role": "assistant", "content": "The current work is ready for review."},
]
compacted = post("/responses/compact", {
    "model": model, "instructions": instructions, "input": history,
})
continued = post("/responses", {
    "model": model,
    "instructions": instructions,
    "input": compacted["output"] + [
        {"role": "user", "content": "Continue from the current state."}
    ],
})
```

Top-level `instructions` is a request parameter and is not added to the returned
input array. Resend it unchanged. With developer hoisting enabled, the capsule
is bound to the effective instruction prefix and its policy; changing or omitting
that prefix fails replay. Input system/developer items are returned separately
so they can retain the same meaning. User messages, tool outputs and native
compaction summaries never become system/developer instructions.

Repeated compaction is supported: provide the current returned window and its
new turns to `/responses/compact` again. If a request includes earlier history
followed by several compaction items, the newest item supplies the canonical
native context; earlier conversational items are superseded. Input instruction
items remain explicit and validated, so clients should replace the window
rather than append a second copy of its instructions.

## Native context and state boundaries

The backend invokes the official CLI's compaction operation and extracts the
reduced native transcript. The capsule contains that context plus any retained
tail, including exact signed/redacted thinking and tool blocks when present.
It does not disguise an unchanged full transcript as a compaction result or
construct a summary from public reasoning text. Information summarized away by
the CLI is not recoverable as the original full history.

An assistant response may end the compact input. Outstanding caller-owned tool
calls are retained in an untouched tail when compressing the completed prefix.
The next ordinary model turn must still supply their matching results. Neither
compaction nor replay executes client tools, invents tool schemas, or authorizes
new tool calls to a tool omitted from the next request.

Compaction capsules use their own versioned `ccpc1` AES-256-GCM domain. Thinking
capsules keep the separate `ccpr2` format. A compaction capsule restores a reduced
conversation window; a thinking capsule restores one signed native block. They
are not interchangeable.

The compaction capsule binds the native model, validated proxy principal,
upstream scope, optional effective instruction scope, item ID and issuance time.
The external item ID may be omitted: the authenticated internal ID is recovered.
If supplied, it must match. A fresh process with the same state key and scopes
can replay the returned context without the original CLI worker or a server-side
response ID.

The existing state TTL applies: seven days by default, configurable from 60
seconds to 30 days. A different key, model, principal or upstream account/scope,
expired state, or modified ciphertext returns `409 invalid_compaction_state`.
Managed same-account authentication refresh retains its existing stable scope;
it does not deliberately invalidate active capsules. State-key rotation does.
Capsule expiry is separate from Anthropic prompt-cache expiry.

Decoded compacted state is limited to 7 MiB. The HTTP request limit remains
10 MiB, including base64 state, visible instructions and new input. An oversized
compacted state returns `compaction_state_too_large`; a request can still exceed
the HTTP limit after appending a large new item. The state format is private to
this adapter: foreign OpenAI capsules are explicitly rejected.

## Client and gateway limits

The existing `/v1/responses` model route does not by itself prove that a gateway
also routes `/v1/responses/compact`. Verify both the compact request and a replay
request on the intended LiteLLM deployment. No LiteLLM or client source change
is part of this implementation.

Codex 0.160.0 distinguishes remote compaction capabilities from an ordinary
custom Responses provider. In the inspected
[pinned provider implementation](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/model-provider/src/provider.rs#L461),
remote V2 compaction is selected for OpenAI/Azure providers. That path appends a
[`compaction_trigger` input item](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/core/src/compact_remote_v2_attempt.rs#L78)
and uses the ordinary Responses SSE stream; it is separate from a standalone
`/responses/compact` client. This proxy's configured custom provider continues
to use client-local compaction. Adding the endpoint does not make that client
automatically select it. CLI automatic compaction, client-local summarization
and this explicitly called standalone endpoint remain distinct operations.

This does not add stored conversations, `previous_response_id`, background jobs,
all Responses tools, or the separate inline `context_management` compaction API.
It does not guarantee identical OpenAI compaction semantics, complete retention
of every project detail, a future cache hit, or a particular billing outcome.

## Verification status

Pure state/request regressions cover cold-process replay, signed and redacted
blocks, expiry and context binding, repeated compaction, canonical instructions,
historical tool identities and pending-tail continuation. The implementation is
also designed for genuine pinned CLI compaction tests against a scripted
provider.

Real Opus calls, replay after worker/process replacement and the intended
LiteLLM compact route require their own recorded checks. Earlier successful
automatic/local compaction and project-edit results are not evidence that this
new endpoint passed those checks. Record the actual endpoint evidence here when
available.
