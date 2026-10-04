"""Offline HTTP transport regressions against the installed LiteLLM package.

Only a loopback fake Anthropic endpoint is called. No provider credentials,
mock_response shortcuts, source checkout imports, or message-log DB are used.
"""

from __future__ import annotations

import copy
import importlib.metadata
import json
import os
from pathlib import Path
import queue
import secrets
import shutil
import subprocess
import sys
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import urllib.request

os.environ["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"
os.environ["LITELLM_LOG"] = "ERROR"
os.environ["LITELLM_NATIVE_ANTHROPIC_STRICT_THINKING"] = "1"

import litellm  # noqa: E402

litellm.telemetry = False
MODEL = "anthropic/claude-sonnet-4-20250514"
VENDOR_MODEL = MODEL.split("/", 1)[1]
KEY = "sk-ant-local-test-only"
BETA = "interleaved-thinking-2025-05-14,local-test-beta-2099-01-01"
SIGNATURE = "opaque-signature+/=preserve-exactly"
SIGNED = {"type": "thinking", "thinking": "first second", "signature": SIGNATURE}
SIGNATURE_ONLY = {"type": "thinking", "thinking": "", "signature": "opaque-signature-only"}
REDACTED = {"type": "redacted_thinking", "data": "opaque-redacted+/="}
TOOL = {"name": "lookup", "description": "Look up a city", "input_schema": {"type": "object", "properties": {"city": {"type": "string"}}}, "cache_control": {"type": "ephemeral", "ttl": "1h"}}
SYSTEM = [{"type": "text", "text": "Keep this stable system prefix.", "cache_control": {"type": "ephemeral", "ttl": "1h"}}]
USER = {"role": "user", "content": [{"type": "text", "text": "Look up Seoul.", "cache_control": {"type": "ephemeral"}}]}
TOOL_USE = {"type": "tool_use", "id": "toolu_local", "name": "lookup", "input": {"city": "Seoul"}}
USAGE = {"input_tokens": 10, "output_tokens": 29, "cache_read_input_tokens": 80, "cache_creation_input_tokens": 11, "cache_creation": {"ephemeral_5m_input_tokens": 3, "ephemeral_1h_input_tokens": 8}}


def sse(thinking: dict, content: list | None = None) -> bytes:
    events = [
        {"type": "message_start", "message": {"id": "msg_local", "type": "message", "role": "assistant", "model": VENDOR_MODEL, "content": [], "stop_reason": None, "stop_sequence": None, "usage": {**USAGE, "output_tokens": 0}}},
    ]
    for index, block in enumerate(content if content is not None else [thinking, REDACTED, TOOL_USE]):
        block_type = block["type"]
        start = {"type": "thinking", "thinking": ""} if block_type == "thinking" else {**block, "input": {}} if block_type == "tool_use" else block
        events.append({"type": "content_block_start", "index": index, "content_block": start})
        if block_type == "thinking":
            text = block["thinking"]
            midpoint = len(text) // 2
            for fragment in (text[:midpoint], text[midpoint:]):
                if fragment:
                    events.append({"type": "content_block_delta", "index": index, "delta": {"type": "thinking_delta", "thinking": fragment}})
            signature = block["signature"]
            midpoint = len(signature) // 2
            # Two signature deltas per native block, including signed-empty ones.
            for fragment in (signature[:midpoint], signature[midpoint:]):
                events.append({"type": "content_block_delta", "index": index, "delta": {"type": "signature_delta", "signature": fragment}})
        elif block_type == "tool_use":
            events.append({"type": "content_block_delta", "index": index, "delta": {"type": "input_json_delta", "partial_json": json.dumps(block["input"])}})
        events.append({"type": "content_block_stop", "index": index})
    events.extend([
        {"type": "message_delta", "delta": {"stop_reason": "tool_use", "stop_sequence": None}, "usage": {"output_tokens": 29}},
        {"type": "message_stop"},
    ])
    return "".join(f"event: {event['type']}\ndata: {json.dumps(event, separators=(',', ':'))}\n\n" for event in events).encode()


class FakeAnthropic(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.server.requests.append((self.path, dict(self.headers), body))
        blocks = [block for message in body.get("messages", []) for block in message.get("content", []) if isinstance(block, dict)]
        reject = any(block.get("signature") == "reject-signature" for block in blocks)
        if reject:
            payload = json.dumps({"type": "error", "error": {"type": "invalid_request_error", "message": "Invalid signature in thinking block"}}).encode()
            self.send_response(400)
            self.send_header("Content-Type", "application/json")
        elif body.get("stream"):
            payload = sse(self.server.thinking, self.server.content)
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
        else:
            payload = json.dumps({"id": "msg_local", "type": "message", "role": "assistant", "model": VENDOR_MODEL, "content": self.server.content if self.server.content is not None else [self.server.thinking, REDACTED, TOOL_USE], "stop_reason": "tool_use", "stop_sequence": None, "usage": USAGE}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(payload)
        self.wfile.flush()


def dump(value):
    return value.model_dump(exclude_none=True) if hasattr(value, "model_dump") else value


class TransportTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        if importlib.metadata.version("litellm") != "1.103.1":
            raise RuntimeError("This regression suite is pinned to LiteLLM 1.103.1")
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), FakeAnthropic)
        cls.server.requests = []
        cls.server.thinking = SIGNED
        cls.server.content = None
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.addClassCleanup(cls.stop_fake)
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"
        cls.key = KEY
        cls.via_proxy = os.environ.get("LITELLM_TEST_VIA_PROXY") == "1"
        if cls.via_proxy:
            cls.start_proxy()

    @classmethod
    def stop_fake(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(3)

    @classmethod
    def start_proxy(cls):
        root = Path(__file__).resolve().parents[2]
        app = root / "dist" / "app.js"
        if not app.is_file():
            raise RuntimeError("Run npm run build before --via-proxy")
        node = os.environ.get("LITELLM_TEST_NODE") or shutil.which("node")
        if not node:
            raise RuntimeError("Node is required for --via-proxy; set LITELLM_TEST_NODE if needed")
        admin = secrets.token_hex(24)
        environment = dict(os.environ)
        environment.pop("CLAUDE_CODE_OAUTH_TOKEN", None)
        environment.update({
            "DATABASE_PATH": ":memory:", "ADMIN_API_SECRET": admin,
            "AUTH_DISABLED": "false", "ANTHROPIC_API_KEY": KEY,
            "ANTHROPIC_BASE_URL": cls.base, "UPSTREAM_TIMEOUT_MS": "10000",
        })
        # Import app instead of server so the listener is exclusively loopback,
        # with an OS-allocated port rather than a preallocated/racy fixed port.
        boot = (
            f"const {{app}} = await import({json.dumps(app.as_uri())});"
            "const server = app.listen(0,'127.0.0.1',()=>"
            "console.log('LITELLM_TEST_PORT='+server.address().port));"
        )
        cls.proxy = subprocess.Popen(
            [node, "--input-type=module", "-e", boot], cwd=root, env=environment,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        cls.addClassCleanup(cls.stop_proxy)
        lines = queue.Queue()

        def read_output():
            for line in cls.proxy.stdout:
                lines.put(line.rstrip())

        cls.proxy_reader = threading.Thread(target=read_output, daemon=True)
        cls.proxy_reader.start()
        startup = []
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            try:
                line = lines.get(timeout=0.1)
            except queue.Empty:
                if cls.proxy.poll() is not None:
                    break
                continue
            if line.startswith("LITELLM_TEST_PORT="):
                cls.base = "http://127.0.0.1:" + line.split("=", 1)[1]
                break
            startup.append(line)
        else:
            raise RuntimeError("Local proxy did not become ready within 15 seconds")
        if cls.proxy.poll() is not None:
            raise RuntimeError("Local proxy startup failed: " + "\n".join(startup))

        local_http = urllib.request.build_opener(urllib.request.ProxyHandler({}))

        def admin_request(path, body, method):
            request = urllib.request.Request(
                cls.base + path, data=json.dumps(body).encode(), method=method,
                headers={"content-type": "application/json", "authorization": "Bearer " + admin},
            )
            with local_http.open(request, timeout=5) as response:
                return json.load(response)

        provisioned = admin_request("/api/admin/keys", {"name": "local LiteLLM regression"}, "POST")
        cls.key = provisioned["key"]
        admin_request("/api/admin/keys/" + str(provisioned["id"]), {"rate_limit_rpm": 300}, "PATCH")
        if cls.key == KEY:
            raise RuntimeError("Proxy and upstream dummy credentials must differ")

    @classmethod
    def stop_proxy(cls):
        if cls.proxy.poll() is None:
            cls.proxy.terminate()
            try:
                cls.proxy.wait(timeout=5)
            except subprocess.TimeoutExpired:
                cls.proxy.kill()
                cls.proxy.wait(timeout=5)
        cls.proxy_reader.join(3)
        cls.proxy.stdout.close()

    def setUp(self):
        self.server.requests.clear()
        self.server.thinking = SIGNED
        self.server.content = None
        os.environ["LITELLM_NATIVE_ANTHROPIC_STRICT_THINKING"] = "1"

    async def asyncSetUp(self):
        from litellm.llms.custom_httpx.http_handler import AsyncHTTPHandler

        # Explicit ownership keeps each real transport on its test's event loop.
        self.http = AsyncHTTPHandler(timeout=10)

    async def asyncTearDown(self):
        await self.http.close()

    def options(self):
        return {"model": MODEL, "api_base": self.base, "api_key": self.key, "client": self.http, "timeout": 10, "num_retries": 0, "extra_headers": {"anthropic-beta": BETA}}

    def request(self):
        self.assertTrue(self.server.requests)
        path, headers, body = self.server.requests[-1]
        self.assertEqual(path, "/v1/messages")
        lowered = {k.lower(): v for k, v in headers.items()}
        self.assertEqual(lowered.get("x-api-key"), KEY)
        self.assertNotIn("authorization", lowered)
        if self.via_proxy:
            self.assertNotIn(self.key, lowered.values(), "caller proxy key leaked upstream")
        return lowered, body

    async def native(self, messages, stream=False):
        return await litellm.anthropic_messages(max_tokens=2048, messages=messages, system=copy.deepcopy(SYSTEM), tools=[copy.deepcopy(TOOL)], thinking={"type": "enabled", "budget_tokens": 1024}, stream=stream, **self.options())

    async def test_native_preserves_signed_empty_redacted_tools_cache_and_beta(self):
        history = [copy.deepcopy(USER), {"role": "assistant", "content": [copy.deepcopy(SIGNATURE_ONLY), copy.deepcopy(REDACTED), {"type": "text", "text": "answer"}]}, {"role": "user", "content": "Continue"}]
        untouched = copy.deepcopy(history)
        response = await self.native(history)
        headers, body = self.request()
        self.assertEqual(history, untouched, "caller history was mutated")
        self.assertEqual(body["messages"], untouched)
        self.assertEqual(body["system"], SYSTEM)
        self.assertEqual(body["tools"], [TOOL])
        self.assertEqual(set(headers["anthropic-beta"].split(",")), set(BETA.split(",")))
        self.assertEqual(response["content"], [SIGNED, REDACTED, TOOL_USE])
        self.assertEqual(response["usage"]["cache_read_input_tokens"], 80)

    async def test_native_stream_is_forwarded_with_signature_and_cache_events(self):
        stream = await self.native([copy.deepcopy(USER)], stream=True)
        chunks = [chunk async for chunk in stream]
        wire = b"".join(chunk if isinstance(chunk, bytes) else str(chunk).encode() for chunk in chunks)
        self.assertEqual(wire, sse(SIGNED))

    async def test_native_invalid_signature_is_one_visible_error_without_strip_retry(self):
        history = [copy.deepcopy(USER), {"role": "assistant", "content": [{**SIGNED, "signature": "reject-signature"}, REDACTED, {"type": "text", "text": "answer"}]}, {"role": "user", "content": "Continue"}]
        with self.assertRaises(Exception) as caught:
            await self.native(history)
        self.assertIn("Invalid signature", str(caught.exception))
        self.assertEqual(getattr(caught.exception, "status_code", None), 400)
        self.assertEqual(len(self.server.requests), 1)
        self.assertEqual(self.request()[1]["messages"], history)

    async def test_native_legacy_behavior_is_available_without_opt_in(self):
        os.environ.pop("LITELLM_NATIVE_ANTHROPIC_STRICT_THINKING")
        history = [copy.deepcopy(USER), {"role": "assistant", "content": [SIGNATURE_ONLY, {**SIGNED, "signature": "reject-signature"}, REDACTED, {"type": "text", "text": "answer"}]}, {"role": "user", "content": "Continue"}]
        await self.native(history)
        self.assertEqual(len(self.server.requests), 2)
        first = self.server.requests[0][2]
        self.assertNotIn(SIGNATURE_ONLY, first["messages"][1]["content"])
        self.assertEqual(self.request()[1]["messages"][1]["content"], [{"type": "text", "text": "answer"}])
        self.assertNotIn("thinking", self.request()[1])

    async def test_chat_stream_signed_blocks_round_trip_without_duplicated_text(self):
        tools = [{"type": "function", "function": {"name": "lookup", "description": TOOL["description"], "parameters": TOOL["input_schema"]}}]
        initial = [{"role": "user", "content": "Look up Seoul."}]
        stream = await litellm.acompletion(messages=initial, tools=tools, max_tokens=2048, thinking={"type": "enabled", "budget_tokens": 1024}, stream=True, **self.options())
        chunks = [chunk async for chunk in stream]
        complete = litellm.stream_chunk_builder(chunks, messages=initial)
        message = complete.choices[0].message
        self.assertEqual(message.thinking_blocks, [SIGNED, REDACTED])
        for chunk in chunks:
            for block in getattr(chunk.choices[0].delta, "thinking_blocks", None) or []:
                if block.get("signature"):
                    self.assertEqual(block["thinking"], "")
        replay = initial + [dump(message), {"role": "tool", "tool_call_id": "toolu_local", "content": "Seoul is in Korea."}]
        await litellm.acompletion(messages=replay, tools=tools, max_tokens=2048, thinking={"type": "enabled", "budget_tokens": 1024}, **self.options())
        self.assertEqual(self.request()[1]["messages"][1]["content"][:2], [SIGNED, REDACTED])

    async def test_chat_signature_only_builder_keeps_signature(self):
        self.server.thinking = SIGNATURE_ONLY
        stream = await litellm.acompletion(messages=[{"role": "user", "content": "Go"}], stream=True, max_tokens=2048, **self.options())
        complete = litellm.stream_chunk_builder([chunk async for chunk in stream])
        self.assertEqual(complete.choices[0].message.thinking_blocks, [SIGNATURE_ONLY, REDACTED])

    async def test_responses_stream_signature_only_and_cache_round_trip(self):
        self.server.thinking = SIGNATURE_ONLY
        tools = [{"type": "function", "name": "lookup", "description": TOOL["description"], "parameters": TOOL["input_schema"], "cache_control": TOOL["cache_control"]}]
        initial = [{"role": "user", "content": [{"type": "input_text", "text": "Go", "cache_control": {"type": "ephemeral"}}]}]
        stream = await litellm.aresponses(input=initial, tools=tools, stream=True, max_output_tokens=2048, **self.options())
        events = [event async for event in stream]
        completed = next(event.response for event in events if event.type == "response.completed")
        reasoning = next(item for item in completed.output if item.type == "reasoning")
        self.assertEqual(json.loads(reasoning.encrypted_content), [SIGNATURE_ONLY, REDACTED])
        started_reasoning = [event for event in events if event.type == "response.output_item.added" and event.item.type == "reasoning"]
        self.assertTrue(started_reasoning, "signature-only reasoning had no item-added event")
        self.assertEqual(reasoning.id, started_reasoning[0].item.id)
        self.assertEqual(completed.usage.input_tokens_details.cached_tokens, 80)
        details = dump(completed.usage.input_tokens_details)
        self.assertEqual(details["cache_write_tokens"], 11)
        _, producing = self.request()
        self.assertEqual(producing["messages"][0]["content"][0]["cache_control"], {"type": "ephemeral"})
        self.assertEqual(producing["tools"][0]["cache_control"], TOOL["cache_control"])
        replay = initial + [dump(item) for item in completed.output] + [{"type": "function_call_output", "call_id": "toolu_local", "output": "Seoul is in Korea."}]
        await litellm.aresponses(input=replay, tools=tools, max_output_tokens=2048, **self.options())
        self.assertEqual(self.request()[1]["messages"][1]["content"][:2], [SIGNATURE_ONLY, REDACTED])

    def multiple_block_fixtures(self):
        empty_second = {**SIGNATURE_ONLY, "signature": "second-empty-signature+/="}
        signed_after_tool = {"type": "thinking", "thinking": "third fourth", "signature": "after-tool-signature+/="}
        return [
            [SIGNATURE_ONLY, empty_second, REDACTED, TOOL_USE],
            [SIGNED, TOOL_USE, signed_after_tool, REDACTED],
        ]

    async def test_chat_fragmented_signatures_and_multiple_blocks_round_trip(self):
        initial = [{"role": "user", "content": "Go"}]
        tools = [{"type": "function", "function": {"name": "lookup", "parameters": TOOL["input_schema"]}}]
        for content in self.multiple_block_fixtures():
            with self.subTest(content=content):
                self.server.content = content
                expected = [block for block in content if block["type"] in ("thinking", "redacted_thinking")]
                stream = await litellm.acompletion(messages=initial, tools=tools, stream=True, max_tokens=2048, **self.options())
                chunks = [chunk async for chunk in stream]
                signatures = [block["signature"] for chunk in chunks for block in getattr(chunk.choices[0].delta, "thinking_blocks", None) or [] if block.get("signature")]
                self.assertEqual(signatures, [block["signature"] for block in expected if block["type"] == "thinking"], "each block must emit exactly one completed signature, not fragments")
                message = litellm.stream_chunk_builder(chunks).choices[0].message
                self.assertEqual(message.thinking_blocks, expected)
                self.assertEqual(message.tool_calls[0].id, "toolu_local")
                self.assertEqual(json.loads(message.tool_calls[0].function.arguments), TOOL_USE["input"])
                replay = initial + [dump(message), {"role": "tool", "tool_call_id": "toolu_local", "content": "Result"}]
                await litellm.acompletion(messages=replay, tools=tools, max_tokens=2048, **self.options())
                upstream = self.request()[1]["messages"][1]["content"]
                self.assertEqual([block for block in upstream if block["type"] in ("thinking", "redacted_thinking")], expected)
                self.assertIn(TOOL_USE, upstream)

    async def test_responses_fragmented_signatures_and_multiple_blocks_round_trip(self):
        initial = [{"role": "user", "content": "Go"}]
        tools = [{"type": "function", "name": "lookup", "parameters": TOOL["input_schema"]}]
        for content in self.multiple_block_fixtures():
            with self.subTest(content=content):
                self.server.content = content
                expected = [block for block in content if block["type"] in ("thinking", "redacted_thinking")]
                stream = await litellm.aresponses(input=initial, tools=tools, stream=True, max_output_tokens=2048, **self.options())
                events = [event async for event in stream]
                completed = next(event.response for event in events if event.type == "response.completed")
                reasoning = [item for item in completed.output if item.type == "reasoning"]
                opaque = [block for item in reasoning for block in json.loads(item.encrypted_content)]
                self.assertEqual(opaque, expected)
                added_ids = {event.item.id for event in events if event.type == "response.output_item.added" and event.item.type == "reasoning"}
                self.assertTrue(all(item.id in added_ids for item in reasoning))
                calls = [item for item in completed.output if item.type == "function_call"]
                self.assertEqual(calls[0].call_id, "toolu_local")
                self.assertEqual(json.loads(calls[0].arguments), TOOL_USE["input"])
                replay = initial + [dump(item) for item in completed.output] + [{"type": "function_call_output", "call_id": "toolu_local", "output": "Result"}]
                await litellm.aresponses(input=replay, tools=tools, max_output_tokens=2048, **self.options())
                upstream = self.request()[1]["messages"][1]["content"]
                self.assertEqual([block for block in upstream if block["type"] in ("thinking", "redacted_thinking")], expected)
                self.assertIn(TOOL_USE, upstream)

    def test_strict_policy_does_not_change_translated_provider_config(self):
        import httpx
        from litellm.llms.anthropic.experimental_pass_through.messages.transformation import AnthropicMessagesConfig
        from litellm.llms.anthropic.common_utils import strict_native_anthropic_thinking

        class TranslatedConfig(AnthropicMessagesConfig):
            @property
            def custom_llm_provider(self):
                return "vertex_ai"

        config = TranslatedConfig()
        self.assertTrue(config.should_filter_anthropic_beta_headers())
        self.assertFalse(strict_native_anthropic_thinking(MODEL, "vertex_ai"))
        error = httpx.HTTPStatusError("rejected", request=httpx.Request("POST", self.base), response=httpx.Response(400, text="Invalid signature in thinking block"))
        self.assertTrue(config.should_retry_anthropic_messages_on_http_error(error, {}))


if __name__ == "__main__":
    if "--via-proxy" in sys.argv:
        sys.argv.remove("--via-proxy")
        os.environ["LITELLM_TEST_VIA_PROXY"] = "1"
    unittest.main(verbosity=2)
