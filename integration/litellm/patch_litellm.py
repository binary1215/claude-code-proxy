"""Apply the reviewed native-Claude patch to exactly LiteLLM 1.103.1 sources.

No import-time monkey patching: run before starting LiteLLM, then restart it.
All original/patched blob identities are checked before any file is changed.
"""

from __future__ import annotations

import argparse
import difflib
import hashlib
import importlib.metadata
import importlib.util
from pathlib import Path

VERSION = "1.103.1"
UPSTREAM_SHA = "580bde9a2d148714889ec1c04a9872819e78a778"

# Exact source replacements keep this patch small and auditable. The generated
# native-preservation.patch is the equivalent standard unified diff.
PATCHES = {
    "litellm/llms/anthropic/chat/handler.py": (
        "359b8bb08c90db5c2933f436895a2f2dc59678d0",
        [
            ("""            signature: Final = content_block["delta"].get("signature")
            if isinstance(signature, str) and signature:
                thinking_blocks = [
                    ChatCompletionThinkingBlock(
                        type="thinking",
                        thinking="".join(
                            cast(str, block["delta"].get("thinking"))
                            for block in self.content_blocks
                            if isinstance(block["delta"].get("thinking"), str)
                        ),
                        signature=signature,
                    )
                ]
                provider_specific_fields["thinking_blocks"] = thinking_blocks
                if reasoning_content is None:
                    reasoning_content = ""
""", """            # Signature fragments remain in self.content_blocks. Emit the full
            # signature only at the native thinking block's stop boundary.
"""),
            (
                """            elif type_chunk == "content_block_stop":
                ContentBlockStop(**chunk)
                # check if tool call content block""",
                """            elif type_chunk == "content_block_stop":
                ContentBlockStop(**chunk)
                if self.current_content_block_type == "thinking":
                    complete_signature = "".join(
                        cast(str, block["delta"]["signature"])
                        for block in self.content_blocks
                        if isinstance(block["delta"].get("signature"), str)
                    )
                    if complete_signature:
                        thinking_blocks = [ChatCompletionThinkingBlock(
                            type="thinking", thinking="", signature=complete_signature,
                        )]
                        provider_specific_fields["thinking_blocks"] = thinking_blocks
                        reasoning_content = ""
                # check if tool call content block""",
            ),
        ],
    ),
    "litellm/litellm_core_utils/streaming_chunk_builder_utils.py": (
        "0ca93fe08b3b617fbd92875322b565ff121e9d4d",
        [("if len(current_thinking_text_parts) > 0 and current_signature:", "if current_signature:")],
    ),
    "litellm/llms/anthropic/common_utils.py": (
        "98e2f6d5bde852d49de45487fc961cb5d2ff3788",
        [
            ("import copy\nimport re", "import copy\nimport os\nimport re"),
            (
                "def is_anthropic_invalid_thinking_block_error(error_text: str) -> bool:",
                """def strict_native_anthropic_thinking(model: str = "", custom_llm_provider: str | None = None) -> bool:
    """ + '"""Opt in only for direct Anthropic; translated providers keep their defaults."""' + """
    if os.getenv("LITELLM_NATIVE_ANTHROPIC_STRICT_THINKING") != "1":
        return False
    if custom_llm_provider is not None:
        return custom_llm_provider == "anthropic"
    return model.startswith("anthropic/") or model.startswith("claude-")


def is_anthropic_invalid_thinking_block_error(error_text: str) -> bool:""",
            ),
        ],
    ),
    "litellm/llms/anthropic/experimental_pass_through/messages/handler.py": (
        "87a4801f987cf22e0795f5b1962b70da143c58a2",
        [
            ("    strip_empty_content_blocks_from_anthropic_messages,", "    strip_empty_content_blocks_from_anthropic_messages,\n    strict_native_anthropic_thinking,"),
            (
                """    messages = strip_empty_content_blocks_from_anthropic_messages(messages)
    # Replay of cross-provider tool history (e.g. kimi -> Anthropic) may carry
    # ids like ``functions.Bash:0`` that violate Anthropic's id pattern.
    messages = sanitize_tool_use_ids_in_anthropic_messages(messages)
    messages = flatten_unencrypted_web_search_results_in_anthropic_messages(messages)""",
                """    if not strict_native_anthropic_thinking(model, custom_llm_provider):
        messages = strip_empty_content_blocks_from_anthropic_messages(messages)
        # Translated history may require provider-specific normalization.
        messages = sanitize_tool_use_ids_in_anthropic_messages(messages)
        messages = flatten_unencrypted_web_search_results_in_anthropic_messages(messages)""",
            ),
            (
                '    if not kwargs.pop("_litellm_messages_presanitized", False):',
                """    presanitized = kwargs.pop("_litellm_messages_presanitized", False)
    if not presanitized and not strict_native_anthropic_thinking(model, custom_llm_provider):""",
            ),
        ],
    ),
    "litellm/llms/anthropic/experimental_pass_through/messages/transformation.py": (
        "5fa686b7560a2350a9a722509b19b0e6f1bab8c2",
        [
            ("    strip_encrypted_reasoning_blocks_from_anthropic_messages,", "    strip_encrypted_reasoning_blocks_from_anthropic_messages,\n    strict_native_anthropic_thinking,"),
            (
                "    def get_supported_anthropic_messages_params(self, model: str) -> list:",
                """    def should_filter_anthropic_beta_headers(self) -> bool:
        # Native Anthropic owns validation of its beta headers.
        return self._resolved_provider != "anthropic"

    def should_retry_anthropic_messages_on_http_error(self, e: httpx.HTTPStatusError, litellm_params: dict) -> bool:
        if strict_native_anthropic_thinking(custom_llm_provider=self._resolved_provider):
            return False
        return super().should_retry_anthropic_messages_on_http_error(e, litellm_params)

    def transform_anthropic_messages_request_on_http_error(self, e: httpx.HTTPStatusError, request_data: dict) -> dict:
        if strict_native_anthropic_thinking(custom_llm_provider=self._resolved_provider):
            return request_data
        return super().transform_anthropic_messages_request_on_http_error(e, request_data)

    def get_supported_anthropic_messages_params(self, model: str) -> list:""",
            ),
            (
                "        if not _has_advisor:\n            messages = strip_advisor_blocks_from_messages(messages)",
                "        strict_native = strict_native_anthropic_thinking(custom_llm_provider=self._resolved_provider)\n        if not _has_advisor and not strict_native:\n            messages = strip_advisor_blocks_from_messages(messages)",
            ),
            (
                "            messages=strip_encrypted_reasoning_blocks_from_anthropic_messages(messages),",
                "            messages=messages if strict_native else strip_encrypted_reasoning_blocks_from_anthropic_messages(messages),",
            ),
        ],
    ),
    "litellm/responses/litellm_completion_transformation/streaming_iterator.py": (
        "5173cd04a89baf6b0a17b37eb210de91fda380d1",
        [
            (
                '        if hasattr(delta, "reasoning_content") and delta.reasoning_content:\n            self._reasoning_active = True',
                """        signed_thinking = any(
            isinstance(block, dict) and (block.get("signature") or block.get("data"))
            for block in (getattr(delta, "thinking_blocks", None) or ())
        )
        if (hasattr(delta, "reasoning_content") and delta.reasoning_content) or signed_thinking:
            self._reasoning_active = True""",
            ),
        ],
    ),
}


def blob_id(data: bytes) -> str:
    return hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()


def patched_text(original: str, replacements: list[tuple[str, str]]) -> str:
    result = original
    for old, new in replacements:
        if result.count(old) != 1:
            raise ValueError("Patch context must occur exactly once")
        result = result.replace(old, new, 1)
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, help="Source root containing litellm/ (defaults to installed package)")
    parser.add_argument("--check", action="store_true", help="Verify compatibility without writing")
    parser.add_argument("--emit-diff", type=Path, help="Generate the equivalent unified diff without applying it")
    args = parser.parse_args()
    if args.root is None:
        if importlib.metadata.version("litellm") != VERSION:
            raise SystemExit(f"Refusing to patch anything except LiteLLM {VERSION}")
        spec = importlib.util.find_spec("litellm")
        if spec is None or spec.origin is None:
            raise SystemExit("LiteLLM Python sources not found")
        root = Path(spec.origin).resolve().parent.parent
    else:
        root = args.root.resolve()

    planned: list[tuple[Path, bytes]] = []
    diffs: list[str] = []
    for relative, (expected, replacements) in PATCHES.items():
        path = root / relative
        data = path.read_bytes()
        # Wheels and source archives may differ only in newline encoding.
        normalized = data.replace(b"\r\n", b"\n")
        text = normalized.decode("utf-8")
        if blob_id(normalized) == expected:
            updated = patched_text(text, replacements)
            planned.append((path, updated.encode("utf-8")))
            diffs.extend(difflib.unified_diff(text.splitlines(keepends=True), updated.splitlines(keepends=True), fromfile="a/" + relative, tofile="b/" + relative))
        else:
            # Idempotence is exact, not a partial-context heuristic.
            reversed_text = text
            for old, new in reversed(replacements):
                if reversed_text.count(new) != 1:
                    raise SystemExit(f"Source identity mismatch: {relative}; nothing was written")
                reversed_text = reversed_text.replace(new, old, 1)
            if blob_id(reversed_text.encode("utf-8")) != expected:
                raise SystemExit(f"Source identity mismatch: {relative}; nothing was written")
        # A compiled extension would shadow the modified .py source.
        if any(path.parent.glob(path.stem + ".*.so")) or any(path.parent.glob(path.stem + "*.pyd")):
            raise SystemExit(f"Compiled module shadows source: {relative}; use an uncompiled image")
    if args.emit_diff:
        args.emit_diff.write_text("".join(diffs), encoding="utf-8", newline="\n")
        print(f"Generated {args.emit_diff} from {VERSION} ({UPSTREAM_SHA})")
    elif args.check:
        print(f"Compatible LiteLLM {VERSION}: {len(planned)} files require patching")
    else:
        for path, data in planned:
            path.write_bytes(data)
        print(f"Patched LiteLLM {VERSION}: {len(planned)} files; restart LiteLLM")


if __name__ == "__main__":
    main()
