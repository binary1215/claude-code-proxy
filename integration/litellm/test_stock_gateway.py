"""Stock 1.103.1 FastAPI HTTP audit. All inference targets are loopback fakes."""
from __future__ import annotations
import copy
import argparse
import codecs
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import queue
import secrets
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import yaml

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--collision", action="store_true", help="Experimentally configure a colliding /v1/messages route")
parser.add_argument("--output", type=Path, help="Evidence output directory (default: ./baseline or ./collision)")
args = parser.parse_args()
BASE = Path(__file__).resolve().parent
HERE = (args.output or (BASE / ("collision" if args.collision else "baseline"))).resolve()
HERE.mkdir(parents=True, exist_ok=True)
SHA = "580bde9a2d148714889ec1c04a9872819e78a778"
EXPECTED = {
    "litellm/proxy/anthropic_endpoints/endpoints.py": "644778bcb9ff55dda04d80c00bc9a8d7e743520a",
    "litellm/proxy/pass_through_endpoints/llm_passthrough_endpoints.py": "44d9f11360dc1db3d9f2394148cda9b45b0fe4bf",
    "litellm/proxy/pass_through_endpoints/pass_through_endpoints.py": "79a328f5199dbff0a49da654c41753371d94669b",
    "litellm/proxy/pass_through_endpoints/streaming_handler.py": "fe9e104789baa2b61eb9ce58d5d977cfd4bc5ec5",
    "litellm/proxy/pass_through_endpoints/passthrough_endpoint_router.py": "7fd607fc4d06a436ab92f3700e499dff16e4f821",
    "litellm/passthrough/utils.py": "452c9c7de9d91ced0ffbba2b8aafb98f641504d0",
    "litellm/proxy/_types.py": "3e6e297f6b68134b79ac6fd7b95d106de8b74ac2",
    "litellm/llms/anthropic/chat/handler.py": "359b8bb08c90db5c2933f436895a2f2dc59678d0",
    "litellm/litellm_core_utils/streaming_chunk_builder_utils.py": "0ca93fe08b3b617fbd92875322b565ff121e9d4d",
    "litellm/llms/anthropic/common_utils.py": "98e2f6d5bde852d49de45487fc961cb5d2ff3788",
    "litellm/llms/anthropic/experimental_pass_through/messages/handler.py": "87a4801f987cf22e0795f5b1962b70da143c58a2",
    "litellm/llms/anthropic/experimental_pass_through/messages/transformation.py": "5fa686b7560a2350a9a722509b19b0e6f1bab8c2",
    "litellm/responses/litellm_completion_transformation/streaming_iterator.py": "5173cd04a89baf6b0a17b37eb210de91fda380d1",
}
MODEL = "claude-sonnet-4-20250514"
UPSTREAM_KEY = "sk-ant-local-upstream-fake-only"
MASTER = "sk-" + secrets.token_hex(32)
BETA = "interleaved-thinking-2025-05-14,local-future-beta-2099-01-01"
SIGNED = {"type": "thinking", "thinking": "first second 한글🙂", "signature": "opaque-signature+/=preserve"}
EMPTY_SIGNED = {"type": "thinking", "thinking": "", "signature": "opaque-empty-signature+/="}
REDACTED = {"type": "redacted_thinking", "data": "opaque-redacted+/="}
TOOL_USE = {"type": "tool_use", "name": "lookup", "id": "toolu_local", "input": {"city": "Seoul"}}
CONTENT = [SIGNED, EMPTY_SIGNED, REDACTED, TOOL_USE]
USAGE = {"input_tokens": 10, "output_tokens": 29, "cache_read_input_tokens": 80, "cache_creation_input_tokens": 11, "cache_creation": {"ephemeral_5m_input_tokens": 3, "ephemeral_1h_input_tokens": 8}}
REPLY = {"id": "msg_local", "type": "message", "role": "assistant", "model": MODEL, "content": CONTENT, "stop_reason": "tool_use", "stop_sequence": None, "usage": USAGE, "future_response": {"opaque": "preserved"}}
JSON_BYTES = ("  " + json.dumps(REPLY, ensure_ascii=False) + "\n").encode()
ERROR_BYTES = json.dumps({"type": "error", "error": {"type": "invalid_request_error", "message": "Invalid signature in thinking block"}}).encode()
COUNT_BYTES = b' {"input_tokens":123,"future_count_usage":true}\n'
MODELS_BYTES = b' {"data":[{"id":"upstream-native-model","type":"model"}],"has_more":false}\n'


def event(name, body):
    return "event: " + name + "\r\ndata: " + json.dumps(body, ensure_ascii=False) + "\r\n\r\n"


def issued_sse():
    """Fake-issued tool turn: one signature event, fragmented bytes/text/JSON."""
    wire = ": untouched comment\r\n\r\n" + event("message_start", {"type": "message_start", "message": {**REPLY, "content": [], "stop_reason": None, "usage": {**USAGE, "output_tokens": 0}}})
    for index, block in enumerate(CONTENT):
        kind = block["type"]
        start = {"type": "thinking", "thinking": ""} if kind == "thinking" else {**block, "input": {}} if kind == "tool_use" else block
        wire += event("content_block_start", {"type": "content_block_start", "index": index, "content_block": start})
        if kind == "thinking":
            text, signature = block["thinking"], block["signature"]
            for fragment in (text[:6], text[6:]):
                if fragment:
                    wire += event("content_block_delta", {"type": "content_block_delta", "index": index, "delta": {"type": "thinking_delta", "thinking": fragment}})
            wire += event("content_block_delta", {"type": "content_block_delta", "index": index, "delta": {"type": "signature_delta", "signature": signature}})
        elif kind == "tool_use":
            encoded = json.dumps(block["input"], ensure_ascii=False)
            for fragment in (encoded[:7], encoded[7:]):
                wire += event("content_block_delta", {"type": "content_block_delta", "index": index, "delta": {"type": "input_json_delta", "partial_json": fragment}})
        wire += event("content_block_stop", {"type": "content_block_stop", "index": index})
    return (wire + event("future_event", {"type": "future_event", "opaque": "preserve🙂"}) + event("message_delta", {"type": "message_delta", "delta": {"stop_reason": "tool_use"}, "usage": {"output_tokens": 29}}) + event("message_stop", {"type": "message_stop"})).encode()


SSE_BYTES = issued_sse()


def accumulate_native_sse(chunks):
    """Independent fixture client, not LiteLLM's builder or a coding-client test."""
    decoder = codecs.getincrementaldecoder("utf-8")()
    pending = ""
    blocks, tool_json, stopped = {}, {}, set()
    message = None
    complete = False
    unknown = []
    for chunk in [*chunks, b""]:
        pending = (pending + decoder.decode(chunk, final=chunk == b"")).replace("\r\n", "\n")
        while "\n\n" in pending:
            frame, pending = pending.split("\n\n", 1)
            data = "\n".join(line[5:].lstrip(" ") for line in frame.splitlines() if line.startswith("data:"))
            if not data:
                continue
            item = json.loads(data)
            kind = item["type"]
            if kind == "message_start":
                message = copy.deepcopy(item["message"])
            elif kind == "content_block_start":
                assert item["index"] not in blocks, "Duplicate content block start"
                blocks[item["index"]] = copy.deepcopy(item["content_block"])
            elif kind == "content_block_delta":
                index, delta = item["index"], item["delta"]
                assert index not in stopped, "Delta after block stop"
                if delta["type"] == "thinking_delta":
                    blocks[index]["thinking"] = blocks[index].get("thinking", "") + delta["thinking"]
                elif delta["type"] == "signature_delta":
                    blocks[index]["signature"] = delta["signature"]
                elif delta["type"] == "input_json_delta":
                    tool_json[index] = tool_json.get(index, "") + delta["partial_json"]
                else:
                    raise AssertionError("Unexpected fixture delta: " + delta["type"])
            elif kind == "content_block_stop":
                index = item["index"]
                assert index in blocks and index not in stopped, "Unmatched block stop"
                if index in tool_json:
                    blocks[index]["input"] = json.loads(tool_json[index])
                stopped.add(index)
            elif kind == "message_delta":
                message.update(item["delta"])
                message["usage"].update(item.get("usage", {}))
            elif kind == "message_stop":
                complete = True
            else:
                unknown.append(item)
    assert complete and message is not None and not pending.strip(), "Incomplete native SSE"
    assert set(blocks) == stopped, "Unfinished native content blocks"
    message["content"] = [blocks[index] for index in sorted(blocks)]
    return message, unknown


def replay_preserved(body, expected_tool_result):
    """Fake validation oracle: opaque fields are compared, never interpreted."""
    history = [m.get("content") for m in body.get("messages", []) if m.get("role") == "assistant"]
    results = [b for m in body.get("messages", []) for b in m.get("content", []) if isinstance(b, dict) and b.get("type") == "tool_result"]
    return history == [CONTENT] and results == [expected_tool_result]


class Fake(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("content-length", "0")))
        body = json.loads(raw)
        self.server.requests.append({"path": self.path, "headers": dict(self.headers), "body": body, "raw": raw})
        blocks = [b for m in body.get("messages", []) for b in m.get("content", []) if isinstance(b, dict)]
        rejected = any(b.get("signature") == "reject-signature" for b in blocks)
        if self.server.validate_replay:
            tool_results = [b for m in body.get("messages", []) for b in m.get("content", []) if isinstance(b, dict) and b.get("type") == "tool_result"]
            preserved = replay_preserved(body, self.server.expected_tool_result)
            if not preserved:
                error = json.dumps({"type": "error", "error": {"type": "invalid_request_error", "message": "Fake-issued replay history mismatch"}}).encode()
                return self.respond(400, error, "application/json")
            continuation = {**REPLY, "id": "msg_followup", "content": [{"type": "text", "text": "Handled tool failure" if tool_results[0]["is_error"] else "Handled tool result"}], "stop_reason": "end_turn"}
            return self.respond(200, json.dumps(continuation, ensure_ascii=False).encode(), "application/json")
        code = 400 if rejected else 200
        payload = ERROR_BYTES if rejected else COUNT_BYTES if self.path.split("?", 1)[0].endswith("/count_tokens") else SSE_BYTES if body.get("stream") else JSON_BYTES
        self.respond(code, payload, "text/event-stream" if body.get("stream") and not rejected else "application/json")

    def do_GET(self):
        self.server.requests.append({"path": self.path, "headers": dict(self.headers), "body": {}, "raw": b""})
        self.respond(200, MODELS_BYTES, "application/json")

    def respond(self, code, payload, content_type):
        self.send_response(code)
        self.send_header("content-type", content_type)
        self.send_header("request-id", "upstream-request-id")
        self.send_header("x-native-response", "unchanged")
        self.send_header("anthropic-ratelimit-tokens-remaining", "12345")
        self.send_header("x-litellm-upstream-input-tokens", "10")
        self.send_header("x-litellm-upstream-output-tokens", "29")
        self.send_header("cache-control", "no-store")
        self.send_header("content-length", str(len(payload)))
        self.send_header("connection", "close")
        self.end_headers()
        for start in range(0, len(payload), 7):
            self.wfile.write(payload[start:start+7])
        self.wfile.flush()


def source_identities():
    package = Path(importlib.util.find_spec("litellm").origin).resolve().parent.parent
    result = {}
    for relative, expected in EXPECTED.items():
        data = (package / relative).read_bytes().replace(b"\r\n", b"\n")
        actual = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
        result[relative] = {"actual": actual, "expected": expected, "matches_tag": actual == expected}
    return result


def payload(model):
    return {
        "model": model, "max_tokens": 2048, "thinking": {"type": "enabled", "budget_tokens": 1024},
        "system": [{"type": "text", "text": "Stable system 한글🙂", "cache_control": {"type": "ephemeral", "ttl": "1h"}}],
        "tools": [{"name": "lookup", "description": "Lookup", "input_schema": {"type": "object", "properties": {"city": {"type": "string"}}}, "cache_control": {"type": "ephemeral", "ttl": "1h"}}],
        "messages": [
            {"role": "user", "content": [{"type": "text", "text": "Go", "cache_control": {"type": "ephemeral", "ttl": "5m"}}]},
            {"role": "assistant", "content": copy.deepcopy(CONTENT)},
            {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "toolu_local", "content": "Seoul result", "is_error": True, "cache_control": {"type": "ephemeral", "ttl": "1h"}}]},
        ],
        "metadata": {"user_id": "native-user-id-preserve"},
        "future_request": {"opaque": "preserve"},
    }


report = {"schema_version": 2, "test_scope": "synthetic loopback HTTP against unmodified stock FastAPI; not a provider or coding-client test", "version": importlib.metadata.version("litellm"), "sha": SHA, "before": source_identities(), "cases": [], "round_trips": [], "acceptance": {"status": "incomplete"}, "harness": {name: {"path": str(BASE / name), "sha256": hashlib.sha256((BASE / name).read_bytes()).hexdigest()} for name in ("test_stock_gateway.py", "boot_gateway.py")}, "runtime": {name: importlib.metadata.version(name) for name in ("fastapi", "uvicorn", "httpx", "aiohttp", "prisma")}, "not_tested": ["managed-model ACL enforcement", "per-model ACL on pass-through routes", "budget enforcement", "UI/spend-log token and cost accounting", "actual coding clients (Claude Code/Codex/OpenCode/etc.)", "real provider acceptance of synthetic signatures", "real prompt-cache hits/savings", "production containers, remote gateways, or real credentials"]}
if report["version"] != "1.103.1" or not all(v["matches_tag"] for v in report["before"].values()):
    raise SystemExit("Not pristine pinned LiteLLM")
fake = ThreadingHTTPServer(("127.0.0.1", 0), Fake)
fake.requests = []
fake.validate_replay = False
fake.expected_tool_result = None
thread = threading.Thread(target=fake.serve_forever, daemon=True)
thread.start()
fake_base = "http://127.0.0.1:" + str(fake.server_port)
config = {
    "model_list": [{"model_name": "stock-native", "litellm_params": {"model": "anthropic/" + MODEL, "api_key": "os.environ/LOCAL_UPSTREAM_KEY", "api_base": fake_base}}],
    "litellm_settings": {"telemetry": False, "num_retries": 0, "callbacks": []},
    "router_settings": {"num_retries": 0},
    "general_settings": {"master_key": "os.environ/LOCAL_GATEWAY_KEY", "pass_through_endpoints": [
        {"path": "/native/v1/messages", "target": fake_base + "/v1/messages", "auth": True, "methods": ["POST"], "forward_headers": True, "headers": {"Authorization": "os.environ/LOCAL_UPSTREAM_AUTHORIZATION", "x-api-key": "", "anthropic-version": "2023-06-01"}},
        {"path": "/native/v1/messages/count_tokens", "target": fake_base + "/v1/messages/count_tokens", "auth": True, "methods": ["POST"], "forward_headers": True, "headers": {"Authorization": "os.environ/LOCAL_UPSTREAM_AUTHORIZATION", "x-api-key": "", "anthropic-version": "2023-06-01"}},
        {"path": "/native/v1/models", "target": fake_base + "/v1/models", "auth": True, "methods": ["GET"], "forward_headers": True, "headers": {"Authorization": "os.environ/LOCAL_UPSTREAM_AUTHORIZATION", "x-api-key": "", "anthropic-version": "2023-06-01"}},
    ]},
}
if args.collision:
    config["general_settings"]["pass_through_endpoints"].append({"path": "/v1/messages", "target": fake_base + "/collision-would-be-passthrough", "auth": True, "methods": ["POST"], "headers": {"x-api-key": "os.environ/LOCAL_UPSTREAM_KEY"}})
config_path = HERE / "gateway-config.yaml"
config_path.write_text(yaml.safe_dump(config, sort_keys=False), encoding="utf-8")
(HERE / "expected-response.json").write_bytes(JSON_BYTES)
(HERE / "expected-response.sse").write_bytes(SSE_BYTES)
environment = {k: v for k, v in os.environ.items() if k.upper() in {"PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA", "USERPROFILE", "PATHEXT"}}
environment.update({"CONFIG_FILE_PATH": str(config_path), "LOCAL_GATEWAY_KEY": MASTER, "LOCAL_UPSTREAM_KEY": UPSTREAM_KEY, "LOCAL_UPSTREAM_AUTHORIZATION": "Bearer " + UPSTREAM_KEY, "ANTHROPIC_API_KEY": UPSTREAM_KEY, "ANTHROPIC_BASE_URL": fake_base, "LITELLM_LOCAL_MODEL_COST_MAP": "True", "PYTHONDONTWRITEBYTECODE": "1"})
process = subprocess.Popen([sys.executable, str(BASE / "boot_gateway.py")], cwd=HERE, env=environment, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace", creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
lines = queue.Queue()
boot_lines = []


def read_output():
    for line in process.stdout:
        boot_lines.append(line)
        lines.put(line)


reader = threading.Thread(target=read_output, daemon=True)
reader.start()
http = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def call(path, body, authenticated=True, auth_mode="both", method="POST"):
    raw = ("  " + json.dumps(body, ensure_ascii=False, indent=2) + "\n").encode()
    headers = {"content-type": "application/json", "anthropic-beta": BETA, "anthropic-version": "2023-06-01"}
    if authenticated:
        if auth_mode != "x-api-key-only":
            headers["authorization"] = "Bearer " + MASTER
        if auth_mode != "bearer-only":
            headers["x-api-key"] = MASTER
    if method == "GET":
        raw = b""
    request = urllib.request.Request(gateway + path, data=raw if method != "GET" else None, headers=headers, method=method)
    try:
        response = http.open(request, timeout=15)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        chunks = []
        while chunk := response.read(7):
            chunks.append(chunk)
        return raw, response.status, dict(response.headers), b"".join(chunks), chunks


try:
    deadline = time.monotonic() + 45
    gateway = None
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError("Stock gateway startup failed")
        try:
            line = lines.get(timeout=.1)
        except queue.Empty:
            continue
        if line.startswith("LOCAL_GATEWAY_PORT="):
            gateway = "http://127.0.0.1:" + line.strip().split("=", 1)[1]
            break
    if gateway is None:
        raise RuntimeError("No gateway listener port within 45 seconds")
    while time.monotonic() < deadline:
        try:
            with http.open(gateway + "/health/liveliness", timeout=1) as ready:
                if ready.status == 200:
                    break
        except (urllib.error.URLError, TimeoutError):
            if process.poll() is not None:
                raise RuntimeError("Gateway stopped during startup")
            time.sleep(.1)
    else:
        raise RuntimeError("Gateway did not become ready")
    report["gateway"] = gateway
    for route in ("/v1/messages", "/anthropic/v1/messages", "/native/v1/messages"):
        for scenario in ("json", "sse", "invalid-signature", "bearer-only", "x-api-key-only", "unauthenticated"):
            original = payload("stock-native" if route == "/v1/messages" else MODEL)
            if scenario == "sse":
                original["stream"] = True
            if scenario == "invalid-signature":
                original["messages"][1]["content"][0]["signature"] = "reject-signature"
            start = len(fake.requests)
            raw, code, response_headers, response_raw, _ = call(route, original, authenticated=scenario != "unauthenticated", auth_mode=scenario)
            received = fake.requests[start:]
            checks = {"upstream_request_count": len(received), "status": code, "response_json_bytes_exact": response_raw == JSON_BYTES, "response_sse_bytes_exact": response_raw == SSE_BYTES, "response_error_bytes_exact": response_raw == ERROR_BYTES}
            if received:
                first = received[0]
                upstream_headers = {k.lower(): v for k, v in first["headers"].items()}
                checks.update({
                    "upstream_path": first["path"], "request_bytes_exact": first["raw"] == raw,
                    "messages_exact": first["body"].get("messages") == original["messages"], "system_exact": first["body"].get("system") == original["system"], "tools_exact": first["body"].get("tools") == original["tools"], "thinking_exact": first["body"].get("thinking") == original["thinking"], "metadata_exact": first["body"].get("metadata") == original["metadata"], "future_request_exact": first["body"].get("future_request") == original["future_request"], "beta_exact": upstream_headers.get("anthropic-beta") == BETA,
                    "gateway_key_leaked": any(MASTER in value for value in upstream_headers.values()), "upstream_auth": {k: v for k, v in upstream_headers.items() if k in ("authorization", "x-api-key")},
                    "last_request_has_thinking": "thinking" in received[-1]["body"],
                    "last_request_signed_blocks": [block for message in received[-1]["body"].get("messages", []) for block in message.get("content", []) if isinstance(block, dict) and block.get("type") in ("thinking", "redacted_thinking")],
                    "signed_empty_history_exact": EMPTY_SIGNED in first["body"].get("messages", [{}, {}])[1].get("content", []),
                    "tool_result_is_error_exact": first["body"]["messages"][-1]["content"][0].get("is_error") is True,
                    "cache_ttls_exact": first["body"].get("system") == original["system"] and first["body"].get("tools") == original["tools"] and first["body"]["messages"][0]["content"][0].get("cache_control") == original["messages"][0]["content"][0]["cache_control"] and first["body"]["messages"][-1]["content"][0].get("cache_control") == original["messages"][-1]["content"][0]["cache_control"],
                })
            checks["sse_comments_preserved"] = b": untouched comment\r\n\r\n" in response_raw
            checks["sse_future_event_preserved"] = b"event: future_event\r\n" in response_raw
            checks["sse_signature_values_preserved"] = all(block["signature"].encode() in response_raw for block in (SIGNED, EMPTY_SIGNED))
            normalized_response_headers = {k.lower(): v for k, v in response_headers.items()}
            checks["response_selected_headers_exact"] = all(normalized_response_headers.get(key) == value for key, value in {"request-id": "upstream-request-id", "x-native-response": "unchanged", "anthropic-ratelimit-tokens-remaining": "12345", "cache-control": "no-store"}.items())
            try:
                decoded = json.loads(response_raw)
            except (ValueError, UnicodeDecodeError):
                decoded = None
            if isinstance(decoded, dict):
                checks["response_usage_exact"] = decoded.get("usage") == USAGE
                checks["response_signed_content_exact"] = decoded.get("content") == CONTENT
            report["cases"].append({"route": route, "scenario": scenario, "checks": checks, "response_headers": response_headers, "response_json": decoded})
            (HERE / (route.strip("/").replace("/", "-") + "-" + scenario + ".body")).write_bytes(response_raw)
            print(route, scenario, json.dumps(checks, ensure_ascii=True), flush=True)
    for route, method, expected in (
        ("/anthropic/v1/messages/count_tokens?beta=true", "POST", COUNT_BYTES),
        ("/native/v1/messages/count_tokens?beta=true", "POST", COUNT_BYTES),
        ("/anthropic/v1/models", "GET", MODELS_BYTES),
        ("/native/v1/models", "GET", MODELS_BYTES),
    ):
        for authenticated in (True, False):
            start = len(fake.requests)
            raw, code, response_headers, response_raw, _ = call(route, payload(MODEL), authenticated=authenticated, auth_mode="x-api-key-only", method=method)
            received = fake.requests[start:]
            checks = {"status": code, "upstream_request_count": len(received), "response_bytes_exact": response_raw == expected}
            if received:
                headers = {k.lower(): v for k, v in received[0]["headers"].items()}
                checks.update({"upstream_path": received[0]["path"], "beta_exact": headers.get("anthropic-beta") == BETA, "gateway_key_leaked": any(MASTER in value for value in headers.values())})
            report["cases"].append({"route": route, "scenario": "authorized" if authenticated else "unauthenticated", "checks": checks, "response_headers": response_headers})
            print(route, authenticated, json.dumps(checks, ensure_ascii=True), flush=True)
    for route in ("/v1/messages", "/anthropic/v1/messages", "/native/v1/messages"):
        for is_error in (False, True):
            fixture_name = route.strip("/").replace("/", "-") + ("-tool-error" if is_error else "-tool-success")
            seed = payload("stock-native" if route == "/v1/messages" else MODEL)
            seed["messages"] = seed["messages"][:1]
            seed["stream"] = True
            start = len(fake.requests)
            _, seed_code, _, seed_wire, chunks = call(route, seed)
            issued = fake.requests[start:]
            if seed_code != 200:
                raise AssertionError("Fake-issued SSE failed: " + fixture_name)
            generated, unknown = accumulate_native_sse(chunks)
            # Replay only content actually received/assembled over HTTP, never CONTENT.
            tool = next(block for block in generated["content"] if block["type"] == "tool_use")
            tool_result = {"type": "tool_result", "tool_use_id": tool["id"], "content": "Fake lookup failed" if is_error else "Fake lookup: " + tool["input"]["city"], "is_error": is_error, "cache_control": {"type": "ephemeral", "ttl": "1h"}}
            replay = copy.deepcopy(seed)
            replay.pop("stream")
            replay["messages"] += [{"role": "assistant", "content": generated["content"]}, {"role": "user", "content": [tool_result]}]
            fake.expected_tool_result = copy.deepcopy(tool_result)
            fake.validate_replay = True
            start = len(fake.requests)
            try:
                _, code, _, response_wire, _ = call(route, replay)
            finally:
                fake.validate_replay = False
            received = fake.requests[start:]
            upstream = received[0]["body"] if received else {}
            upstream_assistant = next((m.get("content", []) for m in upstream.get("messages", []) if m.get("role") == "assistant"), [])
            upstream_results = [b for m in upstream.get("messages", []) for b in m.get("content", []) if isinstance(b, dict) and b.get("type") == "tool_result"]
            continuation = json.loads(response_wire)
            checks = {
                "seed_status": seed_code, "seed_upstream_request_count": len(issued), "actual_http_chunks": len(chunks),
                "client_accumulation_exact": generated["content"] == CONTENT,
                "signature_values_assembled_exact": [b.get("signature") for b in generated["content"] if b["type"] == "thinking"] == [SIGNED["signature"], EMPTY_SIGNED["signature"]],
                "unknown_sse_event_preserved": unknown == [{"type": "future_event", "opaque": "preserve🙂"}],
                "response_sse_bytes_exact": seed_wire == SSE_BYTES,
                "status": code, "upstream_request_count": len(received),
                "opaque_history_exact": upstream_assistant == generated["content"],
                "signed_empty_history_exact": EMPTY_SIGNED in upstream_assistant,
                "redacted_history_exact": REDACTED in upstream_assistant,
                "tool_input_and_id_exact": TOOL_USE in upstream_assistant,
                "tool_result_is_error_exact": len(upstream_results) == 1 and upstream_results[0].get("is_error") is is_error,
                "tool_result_exact": upstream_results == [tool_result],
                "cache_ttls_exact": upstream.get("system") == replay["system"] and upstream.get("tools") == replay["tools"] and upstream.get("messages", [{}])[0] == replay["messages"][0] and upstream_results == [tool_result],
                "fake_accepted_replay": code == 200,
                "continuation_tool_result_outcome_exact": continuation.get("content") == [{"type": "text", "text": "Handled tool failure" if is_error else "Handled tool result"}],
                "loss_detected_by_fake": code == 400 and b"Fake-issued replay history mismatch" in response_wire,
            }
            # Guard the fake oracle against accepting dropped/corrupted opaque state.
            mutations = {}
            for label in ("signed_signature", "empty_signature", "redacted_data", "tool_input", "dropped_empty_block"):
                changed = copy.deepcopy(replay)
                history = changed["messages"][1]["content"]
                if label == "signed_signature":
                    history[0]["signature"] += "corrupt"
                elif label == "empty_signature":
                    history[1]["signature"] += "corrupt"
                elif label == "redacted_data":
                    history[2]["data"] += "corrupt"
                elif label == "tool_input":
                    history[3]["input"]["city"] = "corrupt"
                else:
                    history.pop(1)
                mutations[label] = not replay_preserved(changed, tool_result)
            checks["fixture_oracle_rejects_mutations"] = mutations
            fixtures = {"fake-issued.sse": SSE_BYTES, "client-received.sse": seed_wire, "continuation.body": response_wire}
            for suffix, data in fixtures.items():
                (HERE / (fixture_name + "-" + suffix)).write_bytes(data)
            for suffix, data in (("client-accumulated.json", generated), ("client-replay.json", replay), ("upstream-replay.json", upstream)):
                (HERE / (fixture_name + "-" + suffix)).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
            report["round_trips"].append({"route": route, "tool_result_is_error": is_error, "fixture_prefix": fixture_name, "checks": checks, "fixture_source": "actual fake-issued tool turn received through stock gateway HTTP, accumulated by independent synthetic client"})
            print(route, fixture_name, json.dumps(checks, ensure_ascii=True), flush=True)
except Exception as error:
    report["acceptance"] = {"status": "unexpected_failure", "execution_error": type(error).__name__ + ": " + str(error)}
    raise
finally:
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
    reader.join(3)
    process.stdout.close()
    (HERE / "gateway-process.log").write_text("".join(boot_lines).replace(MASTER, "[LOCAL_RANDOM_MASTER_KEY]"), encoding="utf-8")
    fake.shutdown()
    fake.server_close()
    thread.join(3)
    report["after"] = source_identities()
    report["source_unchanged"] = report["before"] == report["after"]
    report["child_exit"] = process.returncode
    (HERE / "gateway-audit.json").write_text(json.dumps(report, ensure_ascii=False, indent=2).replace(MASTER, "[LOCAL_RANDOM_MASTER_KEY]"), encoding="utf-8")
validation_errors = []


def require(condition, evidence):
    if not condition:
        validation_errors.append(evidence)


require(report["source_unchanged"], "Pinned package sources changed")
require(len(report["cases"]) == 26, "Incomplete baseline scenario run")
require(len(report["round_trips"]) == 6, "Incomplete HTTP-issued replay run")
# Include every retry, SSE seed and continuation, not just the first request
# from baseline scenarios. Only local random credentials exist in this audit.
credential_leaks = [index for index, request in enumerate(fake.requests)
                    if MASTER in request["path"] or MASTER.encode() in request["raw"]
                    or any(MASTER in value for value in request["headers"].values())]
report["credential_isolation"] = {"requests_checked": len(fake.requests),
                                  "leaking_request_indexes": credential_leaks,
                                  "gateway_key_absent_from_all_upstream_requests": not credential_leaks}
require(not credential_leaks, "Gateway key leaked in an upstream request, including retry/round-trip requests")
for case in report["cases"]:
    checks = case["checks"]
    label = case["route"] + ":" + case["scenario"]
    require(not checks.get("gateway_key_leaked", False), label + ": gateway key leaked")
    if case["scenario"] == "unauthenticated":
        require(checks["status"] == 401 and checks["upstream_request_count"] == 0, label + ": unauthorized upstream request")
    elif case["route"] == "/v1/messages" and not args.collision:
        # Known stock transformation behavior, not a full-fidelity success.
        require(checks["status"] == 200 and not checks["messages_exact"] and not checks["beta_exact"], label + ": changed known stock behavior")
        require(checks["cache_ttls_exact"] and checks["tool_result_is_error_exact"], label + ": cache TTL or tool error flag lost")
        if case["scenario"] == "invalid-signature":
            require(checks["upstream_request_count"] == 2 and not checks["last_request_has_thinking"] and checks["last_request_signed_blocks"] == [], label + ": changed signature-strip retry behavior")
        else:
            require(checks["upstream_request_count"] == 1, label + ": unexpected retry")
    elif case["route"] != "/v1/messages":
        require(checks["upstream_request_count"] == 1 and checks["beta_exact"], label + ": retry or beta rewrite")
        if case["scenario"] == "invalid-signature":
            require(checks["status"] == 400 and checks["response_error_bytes_exact"], label + ": changed invalid signature response")
        else:
            require(checks["status"] == 200, label + ": non-200")
            if case["scenario"] == "authorized":
                require(checks["response_bytes_exact"], label + ": response rewritten")
            else:
                require(all(checks[key] for key in ("messages_exact", "system_exact", "tools_exact", "thinking_exact", "future_request_exact", "signed_empty_history_exact", "tool_result_is_error_exact", "cache_ttls_exact")), label + ": native body content lost")
                require(checks["response_sse_bytes_exact" if case["scenario"] == "sse" else "response_json_bytes_exact"], label + ": response rewritten")
                require(not checks["metadata_exact"] and not checks["request_bytes_exact"], label + ": changed known passthrough metadata/serialization behavior")

for trip in report["round_trips"]:
    checks = trip["checks"]
    label = trip["fixture_prefix"]
    require(checks["seed_upstream_request_count"] == 1 and checks["upstream_request_count"] == 1, label + ": unexpected retry")
    require(all(checks[key] for key in ("client_accumulation_exact", "signature_values_assembled_exact", "unknown_sse_event_preserved", "redacted_history_exact", "tool_input_and_id_exact", "tool_result_is_error_exact", "tool_result_exact", "cache_ttls_exact")), label + ": fragmented fixture or retained fields mismatch")
    require(all(checks["fixture_oracle_rejects_mutations"].values()), label + ": validation oracle accepted mutated opaque state")
    if trip["route"] == "/v1/messages" and not args.collision:
        require(checks["loss_detected_by_fake"] and not checks["opaque_history_exact"] and not checks["signed_empty_history_exact"], label + ": failed to detect stock signed-empty history loss")
    elif trip["route"] != "/v1/messages":
        require(checks["fake_accepted_replay"] and checks["continuation_tool_result_outcome_exact"] and checks["opaque_history_exact"] and checks["signed_empty_history_exact"] and checks["response_sse_bytes_exact"], label + ": native replay fidelity failed")

report["semantic_capabilities"] = {}
for route in ("/v1/messages", "/anthropic/v1/messages", "/native/v1/messages"):
    baseline = {case["scenario"]: case["checks"] for case in report["cases"] if case["route"] == route}
    trips = [trip["checks"] for trip in report["round_trips"] if trip["route"] == route]
    values = {
        "signed_empty_history": baseline["json"]["signed_empty_history_exact"] and all(t["signed_empty_history_exact"] for t in trips),
        "redacted_thinking_history": all(t["redacted_history_exact"] for t in trips),
        "tool_use_input_and_id": all(t["tool_input_and_id_exact"] for t in trips),
        "fragmented_sse_opaque_tool_multiturn_replay": all(t["client_accumulation_exact"] and t["opaque_history_exact"] and t["fake_accepted_replay"] and t["continuation_tool_result_outcome_exact"] for t in trips),
        "unknown_beta_header": baseline["json"]["beta_exact"],
        "metadata": baseline["json"]["metadata_exact"],
        "invalid_signature_exactly_once_original_400": baseline["invalid-signature"]["upstream_request_count"] == 1 and baseline["invalid-signature"]["status"] == 400 and baseline["invalid-signature"]["response_error_bytes_exact"],
        "response_sse_raw_bytes": baseline["sse"]["response_sse_bytes_exact"] and all(t["response_sse_bytes_exact"] for t in trips),
        "response_json_raw_bytes": baseline["json"]["response_json_bytes_exact"],
        "request_raw_bytes": baseline["json"]["request_bytes_exact"],
        "tool_result_is_error": baseline["json"]["tool_result_is_error_exact"] and all(t["tool_result_is_error_exact"] for t in trips),
        "cache_control_5m_1h_ttl": baseline["json"]["cache_ttls_exact"] and all(t["cache_ttls_exact"] for t in trips),
        "response_cache_usage_fields": baseline["json"]["response_usage_exact"],
        "future_request_field": baseline["json"]["future_request_exact"],
        "response_selected_headers": baseline["json"]["response_selected_headers_exact"],
        "gateway_auth_blocks_unauthenticated": baseline["unauthenticated"]["status"] == 401 and baseline["unauthenticated"]["upstream_request_count"] == 0,
    }
    collision_probe = args.collision and route == "/v1/messages"
    report["semantic_capabilities"][route] = {name: {"status": "experimental_not_asserted" if collision_probe else "fidelity_success" if preserved else "observed_known_loss", "preserved": preserved, "evidence": [route + ":json", route + ":sse", route + ":invalid-signature", "round_trips:" + route]} for name, preserved in values.items()}
    if not args.collision or route != "/v1/messages":
        expected_losses = {"signed_empty_history", "fragmented_sse_opaque_tool_multiturn_replay", "unknown_beta_header", "invalid_signature_exactly_once_original_400", "response_sse_raw_bytes", "response_json_raw_bytes", "request_raw_bytes", "future_request_field", "response_selected_headers"} if route == "/v1/messages" else {"metadata", "request_raw_bytes"}
        observed_losses = {name for name, preserved in values.items() if not preserved}
        require(observed_losses == expected_losses, route + ": semantic loss set changed (observed " + str(sorted(observed_losses)) + ")")
report["acceptance"] = {
    "status": "unexpected_failure" if validation_errors else "experimental_observations_not_full_acceptance" if args.collision else "expected_observations_verified_with_known_losses",
    "baseline_cases": len(report["cases"]), "http_issued_multiturn_replays": len(report["round_trips"]),
    "validation_errors": validation_errors,
    "full_native_fidelity": False,
    "interpretation": "Known-loss expectations passing is not native fidelity success. Pass-through preserves tested opaque history/SSE/usage/beta, but strips metadata and reserializes requests. No actual client/provider/ACL/budget/accounting compatibility claim.",
    "route_collision_experiment": args.collision,
    "unasserted_collision_route": "/v1/messages" if args.collision else None,
    "pristine_source_files_verified": len(report["before"]),
    "signature_event_semantics": "SDK-compatible value replacement; one complete signature_delta per signed block in the provider fixture.",
    "fragmentation_scope": "One complete signature_delta frame per signed block, fragmented thinking/tool JSON, and 7-byte client reads (including UTF-8 boundaries); TCP packet boundaries are not asserted.",
}
(HERE / "gateway-audit.json").write_text(json.dumps(report, ensure_ascii=False, indent=2).replace(MASTER, "[LOCAL_RANDOM_MASTER_KEY]"), encoding="utf-8")
print("Report:", HERE / "gateway-audit.json", flush=True)
if validation_errors:
    raise SystemExit("Unexpected observations: " + "; ".join(validation_errors))
print("Experimental collision observations only; the colliding route is not an acceptance result." if args.collision else "Expected observations verified; see semantic_capabilities for fidelity successes and known losses.", flush=True)
