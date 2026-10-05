"""Pinned stock policy/schema tests; no DB, provider, license override, or HTTP ACL claim.

Run with pristine litellm[proxy]==1.103.1. Reports stock helper behavior using
synthetic key/request fixtures. No key is persisted or inserted into auth caches.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import tempfile

SHA = "580bde9a2d148714889ec1c04a9872819e78a778"
EXPECTED = {
    "litellm/proxy/auth/route_checks.py": "1b9fd7c42bff4222a98a40a2e4d5bbe89875b91a",
    "litellm/proxy/auth/auth_checks.py": "e75ace7c76016d6848fe5463a6ea9c221ddde230",
    "litellm/proxy/auth/auth_utils.py": "3372145e66c300c5b62fed6691f7a9c4009f7957",
    "litellm/proxy/auth/user_api_key_auth.py": "de0131772bc46b4110dd6818a0a6c0e5ee90ae25",
    "litellm/proxy/proxy_server.py": "7ad10a870a83566d3ceaaa12a67f3b9ad06bed3e",
    "litellm/proxy/_types.py": "3e6e297f6b68134b79ac6fd7b95d106de8b74ac2",
    "litellm/proxy/pass_through_endpoints/pass_through_endpoints.py": "79a328f5199dbff0a49da654c41753371d94669b",
    "litellm/proxy/pass_through_endpoints/llm_passthrough_endpoints.py": "44d9f11360dc1db3d9f2394148cda9b45b0fe4bf",
    "litellm/proxy/pass_through_endpoints/upstream_usage_headers.py": "5e9fba0b7cd018f4f89f4232e6fbeb844852aebd",
    "litellm/proxy/pass_through_endpoints/success_handler.py": "de1a8ae1d937c4cb2154f4324370f71a44a2ff09",
    "litellm/proxy/pass_through_endpoints/streaming_handler.py": "fe9e104789baa2b61eb9ce58d5d977cfd4bc5ec5",
    "litellm/proxy/config_resolvers/settings_store.py": "291000b3b6aa9f50d6c04e4407309ef51f86fa91",
    "litellm/proxy/config_resolvers/settings_rules.py": "f346dd6198d3df03788e50a2d3ccd260233fa8ed",
}


def identities():
    package = Path(importlib.util.find_spec("litellm").origin).resolve().parent.parent
    result = {}
    for relative, expected in EXPECTED.items():
        data = (package / relative).read_bytes().replace(b"\r\n", b"\n")
        actual = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
        result[relative] = {"expected": expected, "actual": actual, "matches_tag": actual == expected}
    return result


async def audit(report):
    import httpx
    import litellm
    from fastapi import FastAPI, HTTPException
    from starlette.requests import Request
    from litellm.proxy._types import ConfigYAML, ConfigFieldUpdate, PassThroughGenericEndpoint, UserAPIKeyAuth, LitellmUserRoles
    from litellm.proxy.config_resolvers.settings_store import SettingsStore
    from litellm.proxy.auth.auth_checks import can_key_call_model, route_skips_budget_checks, _virtual_key_max_budget_check
    from litellm.proxy.auth.auth_utils import get_model_from_request
    from litellm.proxy.auth.route_checks import RouteChecks
    from litellm.proxy.auth.user_api_key_auth import _enforce_key_and_fallback_model_access, user_api_key_auth
    from litellm.proxy.pass_through_endpoints.llm_passthrough_endpoints import anthropic_proxy_route
    from litellm.proxy.pass_through_endpoints.pass_through_endpoints import _register_pass_through_endpoint, HttpPassThroughEndpointHelpers, InitPassThroughEndpointHelpers
    from litellm.proxy.pass_through_endpoints.success_handler import PassThroughEndpointLogging
    from litellm.proxy.pass_through_endpoints.upstream_usage_headers import apply_upstream_reported_usage
    from litellm.proxy import proxy_server
    from types import SimpleNamespace

    litellm.telemetry = False
    errors = []

    def check(name, observed, expected, scope="stock_policy_helper"):
        passed = observed == expected
        report["cases"].append({"name": name, "scope": scope, "observed": observed, "expected": expected, "expectation_verified": passed})
        if not passed:
            errors.append(name)

    async def rejected(operation):
        try:
            await operation
        except Exception as error:
            return type(error).__name__
        return None

    route = "/test-claudemock/v1/messages"
    data = {"id": "local-policy-only", "path": route, "target": "http://127.0.0.1:1/v1/messages", "auth": True, "methods": ["POST"], "forward_headers": True}
    parsed = PassThroughGenericEndpoint.model_validate(data)
    check("auth_default_is_free_safe_true", PassThroughGenericEndpoint(path=route, target=data["target"]).auth, True, "stock_schema")
    check("CRUD_schema_drops_forward_headers", "forward_headers" in parsed.model_dump(), False, "observed_schema_constraint")
    config = ConfigYAML.model_validate({"general_settings": {"pass_through_endpoints": [data]}})
    check("config_update_schema_drops_forward_headers", "forward_headers" in config.model_dump(exclude_unset=True)["general_settings"]["pass_through_endpoints"][0], False, "observed_schema_constraint")
    settings = SettingsStore("general_settings")
    settings.load_yaml({"pass_through_endpoints": []})
    check("even_empty_yaml_list_owns_entire_field", settings.rejected_writes({"pass_through_endpoints": [data]}), ("pass_through_endpoints",), "observed_config_ownership_constraint")
    app = FastAPI()
    await _register_pass_through_endpoint(data, app, premium_user=False, visited_endpoints=set())
    registered = next(r for r in app.routes if r.path == route)
    check("OSS_registration_has_real_auth_dependency", any(dep.call is user_api_key_auth for dep in registered.dependant.dependencies), True, "stock_registration_premium_false")
    check("OSS_registry_enforces_auth", RouteChecks.is_auth_enforced_pass_through_route(route, "POST"), True)
    request = Request({"type": "http", "method": "POST", "path": route, "headers": [], "query_string": b"", "endpoint": registered.endpoint})
    key = UserAPIKeyAuth(models=["only-managed-model"], allowed_routes=["llm_api_routes"], metadata={})
    check("llm_group_without_passthrough_grant_denied", RouteChecks.check_passthrough_route_access(route, key), False)
    try:
        RouteChecks.is_virtual_key_allowed_to_call_route(route, key, request)
        denied = False
    except HTTPException as error:
        denied = error.status_code == 403
    check("virtual_route_group_explicit_grant_required", denied, True)
    key.metadata = {"allowed_passthrough_routes": [route]}
    check("explicit_route_grant_accepted", RouteChecks.is_virtual_key_allowed_to_call_route(route, key, request), True)
    check("similarly_named_prefix_not_allowed", RouteChecks.check_passthrough_route_access(route + "-other", key), False)
    check("child_count_route_inherits_prefix_grant", RouteChecks.check_passthrough_route_access(route + "/count_tokens", key), True)
    key.team_metadata = {"allowed_passthrough_routes": ["/team-scope"]}
    key.metadata = {"allowed_passthrough_routes": []}
    check("empty_key_grant_inherits_team_not_deny", RouteChecks.check_passthrough_route_access("/team-scope/v1/messages", key), True, "observed_policy_constraint")
    key.metadata = {"allowed_passthrough_routes": [route]}
    body = {"model": "not-managed-and-not-key-allowed", "messages": []}
    check("custom_route_body_model_not_managed", get_model_from_request(body, route, request=request), None, "observed_policy_constraint")
    check("custom_route_skips_key_model_allowlist", await rejected(_enforce_key_and_fallback_model_access(valid_token=key, request_data=body, route=route, request=request, llm_model_list=None, llm_router=None)), None, "observed_policy_constraint")
    check("direct_managed_model_allowlist_still_denies", await rejected(can_key_call_model(body["model"], None, key, None)), "ModelAccessDeniedProxyException")
    builtin_request = Request({**request.scope, "path": "/anthropic/v1/messages", "endpoint": anthropic_proxy_route})
    check("builtin_anthropic_keeps_body_model_ACL", get_model_from_request(body, "/anthropic/v1/messages", request=builtin_request), body["model"])
    check("custom_authenticated_route_is_budget_classified", route_skips_budget_checks(route), False)
    budget_key = UserAPIKeyAuth(token="local-policy-budget-only", spend=1.0, max_budget=1.0, metadata={})
    check("at_budget_limit_rejected_helper", await rejected(_virtual_key_max_budget_check(budget_key, proxy_server.proxy_logging_obj)), "BudgetExceededError", "stock_helper_cached_spend_fixture_not_persisted_accounting")
    check("custom_host_stream_is_GENERIC", HttpPassThroughEndpointHelpers.get_endpoint_type(data["target"]).value, "generic", "observed_accounting_constraint")
    check("anthropic_host_stream_is_ANTHROPIC", HttpPassThroughEndpointHelpers.get_endpoint_type("https://api.anthropic.com/v1/messages").value, "anthropic")
    logging = SimpleNamespace(model_call_details={})
    usage = apply_upstream_reported_usage(logging, httpx.Headers({"x-litellm-response-cost": "0.000415", "x-litellm-total-tokens": "1874"}))
    check("official_upstream_cost_headers_parsed", [usage.response_cost, usage.total_tokens], [0.000415, 1874], "stock_logging_helper_not_DB_write")
    kwargs = PassThroughEndpointLogging()._set_cost_per_request(logging, {"cost_per_request": 0.0}, {})
    check("reported_cost_wins_over_default_zero", logging.model_call_details["response_cost"], 0.000415, "stock_logging_helper_not_DB_write")
    no_report = SimpleNamespace(model_call_details={"response_cost": 0.5})
    PassThroughEndpointLogging()._set_cost_per_request(no_report, {"cost_per_request": 0.0}, {})
    check("default_flat_zero_overrides_derived_cost", no_report.model_call_details["response_cost"], 0.0, "observed_accounting_constraint")
    check("DB_not_connected_in_isolated_fixture", proxy_server.prisma_client is None, True)
    try:
        await proxy_server.update_config_general_settings(ConfigFieldUpdate(field_name="pass_through_endpoints", field_value=[data], config_type="general_settings"), UserAPIKeyAuth(user_role=LitellmUserRoles.PROXY_ADMIN))
        db_error = None
    except HTTPException as error:
        db_error = error.status_code
    check("config_field_update_requires_DB_no_write_attempted", db_error, 400, "stock_admin_helper_no_DB")
    InitPassThroughEndpointHelpers.remove_endpoint_routes("local-policy-only")
    await asyncio.sleep(0)
    report["unexpected_failures"] = errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.output is None:
        output = Path(tempfile.mkdtemp(prefix="stock-litellm-policy-"))
    else:
        output = args.output.resolve()
        repository = Path(__file__).resolve().parents[2]
        if output == repository or repository in output.parents:
            parser.error("--output must be outside the repository")
        if output.exists() or output.is_symlink():
            parser.error("--output must be a new directory; existing evidence is never overwritten")
        # exist_ok=False also rejects another process creating it after the check.
        output.mkdir(parents=True, exist_ok=False)
    # Imports cannot discover real provider credentials or enable external callbacks.
    safe = {k: v for k, v in os.environ.items() if k.upper() in {"PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA", "USERPROFILE", "PATHEXT"}}
    os.environ.clear()
    os.environ.update(safe)
    os.environ.update({"LITELLM_LOCAL_MODEL_COST_MAP": "True", "DO_NOT_TRACK": "1", "PYTHONDONTWRITEBYTECODE": "1"})
    report = {"version": importlib.metadata.version("litellm"), "sha": SHA, "scope": "stock policy/schema helpers and isolated premium_user=False route registration; no persisted virtual-key or HTTP auth proof", "before": identities(), "cases": [], "not_tested": ["actual DB-backed key generation/authentication/revocation", "admin CRUD persistence and multiworker synchronization", "HTTP virtual-key ACL with DB", "budget debits/reservation/concurrency", "spend logs/UI accounting/cache price breakdown", "real coding clients/providers or remote .7/.64"]}
    if report["version"] != "1.103.1" or not all(v["matches_tag"] for v in report["before"].values()):
        raise SystemExit("Requires pristine pinned LiteLLM 1.103.1")
    try:
        asyncio.run(audit(report))
    except Exception as error:
        report["execution_error"] = type(error).__name__ + ": " + str(error)
        raise
    finally:
        report["after"] = identities()
        report["source_unchanged"] = report["before"] == report["after"]
        report["harness_sha256"] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
        report["acceptance"] = "expected_policy_observations_verified" if report.get("unexpected_failures") == [] and report["source_unchanged"] else "unexpected_failure"
        report_path = output.resolve() / "gateway-policy.json"
        report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
        print("Report:", report_path)
    if report["acceptance"] != "expected_policy_observations_verified":
        raise SystemExit("Unexpected policy observations: " + str(report.get("unexpected_failures")))
    print("Verified", len(report["cases"]), "policy observations; no DB/HTTP/client/accounting support claim.")


if __name__ == "__main__":
    main()
