"""Stock 1.103.1 FastAPI HTTP audit. All inference targets are loopback fakes."""
from __future__ import annotations
import copy
import argparse
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


SSE_BYTES = (
    ": untouched comment\r\n\r\n" + event("message_start", {"type": "message_start", "message": {**REPLY, "content": [], "usage": {**USAGE, "output_tokens": 0}}})
    + event("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": ""}})
    + event("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": SIGNED["thinking"]}})
    + event("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "signature_delta", "signature": SIGNED["signature"][:12]}})
    + event("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "signature_delta", "signature": SIGNED["signature"][12:]}})
    + event("content_block_stop", {"type": "content_block_stop", "index": 0})
    + event("future_event", {"type": "future_event", "opaque": "preserve🙂"})
    + event("message_delta", {"type": "message_delta", "delta": {"stop_reason": "tool_use"}, "usage": {"output_tokens": 29}})
    + event("message_stop", {"type": "message_stop"})
).encode()


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
            {"role": "user", "content": [{"type": "text", "text": "Go", "cache_control": {"type": "ephemeral"}}]},
            {"role": "assistant", "content": copy.deepcopy(CONTENT)},
            {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "toolu_local", "content": "Seoul result"}]},
        ],
        "metadata": {"user_id": "native-user-id-preserve"},
        "future_request": {"opaque": "preserve"},
    }


report = {"version": importlib.metadata.version("litellm"), "sha": SHA, "before": source_identities(), "cases": [], "runtime": {name: importlib.metadata.version(name) for name in ("fastapi", "uvicorn", "httpx", "aiohttp", "prisma")}}
if report["version"] != "1.103.1" or not all(v["matches_tag"] for v in report["before"].values()):
    raise SystemExit("Not pristine pinned LiteLLM")
fake = ThreadingHTTPServer(("127.0.0.1", 0), Fake)
fake.requests = []
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
        return raw, response.status, dict(response.headers), response.read()


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
            raw, code, response_headers, response_raw = call(route, original, authenticated=scenario != "unauthenticated", auth_mode=scenario)
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
                })
            checks["sse_comments_preserved"] = b": untouched comment\r\n\r\n" in response_raw
            checks["sse_future_event_preserved"] = b"event: future_event\r\n" in response_raw
            checks["sse_signature_fragments_preserved"] = all(fragment.encode() in response_raw for fragment in (SIGNED["signature"][:12], SIGNED["signature"][12:]))
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
            raw, code, response_headers, response_raw = call(route, payload(MODEL), authenticated=authenticated, auth_mode="x-api-key-only", method=method)
            received = fake.requests[start:]
            checks = {"status": code, "upstream_request_count": len(received), "response_bytes_exact": response_raw == expected}
            if received:
                headers = {k.lower(): v for k, v in received[0]["headers"].items()}
                checks.update({"upstream_path": received[0]["path"], "beta_exact": headers.get("anthropic-beta") == BETA, "gateway_key_leaked": any(MASTER in value for value in headers.values())})
            report["cases"].append({"route": route, "scenario": "authorized" if authenticated else "unauthenticated", "checks": checks, "response_headers": response_headers})
            print(route, authenticated, json.dumps(checks, ensure_ascii=True), flush=True)
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
assert report["source_unchanged"], "Pinned package sources changed"
assert len(report["cases"]) == 26, "Incomplete scenario run"
for case in report["cases"]:
    checks = case["checks"]
    assert not checks.get("gateway_key_leaked", False), case
    if case["scenario"] == "unauthenticated":
        assert checks["status"] == 401 and checks["upstream_request_count"] == 0, case
    elif case["route"] == "/v1/messages" and not args.collision:
        # Known stock transformation behavior, not a full-fidelity success.
        assert checks["status"] == 200 and not checks["messages_exact"] and not checks["beta_exact"], case
        if case["scenario"] == "invalid-signature":
            assert checks["upstream_request_count"] == 2 and not checks["last_request_has_thinking"] and checks["last_request_signed_blocks"] == [], case
        else:
            assert checks["upstream_request_count"] == 1, case
    elif case["route"] != "/v1/messages":
        assert checks["upstream_request_count"] == 1 and checks["beta_exact"], case
        if case["scenario"] == "invalid-signature":
            assert checks["status"] == 400 and checks["response_error_bytes_exact"], case
        else:
            assert checks["status"] == 200, case
            if case["scenario"] == "authorized":
                assert checks["response_bytes_exact"], case
            else:
                assert all(checks[key] for key in ("messages_exact", "system_exact", "tools_exact", "thinking_exact", "future_request_exact")), case
                assert checks["response_sse_bytes_exact" if case["scenario"] == "sse" else "response_json_bytes_exact"], case
print("Report:", HERE / "gateway-audit.json", flush=True)
