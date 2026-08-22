#!/usr/bin/env python3
from __future__ import annotations

import ast
import json
import os
from pathlib import Path
from typing import Any

LOGS_DIR = Path(os.environ.get("HARBOR_LOGS_DIR", "/logs"))
VERIFIER_DIR = LOGS_DIR / "verifier"
CONTEXT_TOOL = "mcp__kernel__get_connection_context"
BROWSER_TOOLS = {
    "mcp__kernel__execute_playwright_code",
    "mcp__kernel__computer_action",
}
FORBIDDEN_KERNEL_TOOLS = {
    "mcp__kernel__manage_browsers",
    "mcp__kernel__manage_auth_connections",
    "mcp__kernel__open_auth_login",
}


def read_json(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _decode_content(content: Any) -> Any:
    value = content
    for _ in range(6):
        if isinstance(value, str):
            try:
                value = json.loads(value)
            except json.JSONDecodeError:
                try:
                    value = ast.literal_eval(value)
                except (SyntaxError, ValueError):
                    return value
            continue
        if isinstance(value, dict) and value.get("type") == "text":
            value = value.get("text")
            continue
        if (
            isinstance(value, list)
            and len(value) == 1
            and isinstance(value[0], dict)
            and value[0].get("type") == "text"
        ):
            value = value[0].get("text")
            continue
        return value
    return value


def _contains_error(value: Any) -> bool:
    if isinstance(value, dict):
        if value.get("is_error") is True or value.get("isError") is True:
            return True
        if value.get("error") not in (None, False, ""):
            return True
        return any(_contains_error(item) for item in value.values())
    if isinstance(value, list):
        return any(_contains_error(item) for item in value)
    if isinstance(value, str):
        return value.lstrip().lower().startswith(("[error]", "error:", "error in "))
    return False


def _calls(trajectory: dict[str, Any]) -> list[dict[str, Any]]:
    calls: list[dict[str, Any]] = []
    for step in trajectory.get("steps") or []:
        if not isinstance(step, dict):
            continue
        calls.extend(call for call in step.get("tool_calls") or [] if isinstance(call, dict))
    return calls


def _results(trajectory: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    results: dict[str, list[dict[str, Any]]] = {}
    for step in trajectory.get("steps") or []:
        if not isinstance(step, dict):
            continue
        observation = step.get("observation")
        if not isinstance(observation, dict):
            continue
        for result in observation.get("results") or []:
            if not isinstance(result, dict):
                continue
            call_id = result.get("source_call_id")
            if isinstance(call_id, str):
                results.setdefault(call_id, []).append(result)
    return results


def validate_control(
    trajectory: dict[str, Any] | None,
    *,
    expected_session_id: str,
    expected_project_id: str,
) -> dict[str, Any]:
    trajectory = trajectory or {}
    calls = _calls(trajectory)
    result_map = _results(trajectory)
    kernel_calls = [
        call for call in calls if str(call.get("function_name", "")).startswith("mcp__kernel__")
    ]
    context_calls = [call for call in kernel_calls if call.get("function_name") == CONTEXT_TOOL]
    browser_calls = [call for call in kernel_calls if call.get("function_name") in BROWSER_TOOLS]
    playwright_calls = [
        call for call in calls if str(call.get("function_name", "")).startswith("mcp__playwright__")
    ]
    forbidden_calls = [
        call for call in kernel_calls if call.get("function_name") in FORBIDDEN_KERNEL_TOOLS
    ]

    missing_observations: list[Any] = []
    duplicate_observations: list[Any] = []
    error_observations: list[Any] = []
    context_scope_valid = bool(expected_project_id)
    same_session = bool(expected_session_id and browser_calls)

    for call in context_calls + browser_calls:
        call_id = call.get("tool_call_id")
        observations = result_map.get(call_id, []) if isinstance(call_id, str) else []
        if not observations:
            missing_observations.append(call_id)
            continue
        if len(observations) != 1:
            duplicate_observations.append(call_id)
            continue
        decoded = _decode_content(observations[0].get("content"))
        if _contains_error(decoded) or _contains_error(observations[0]):
            error_observations.append(call_id)
            continue
        if call.get("function_name") == CONTEXT_TOOL:
            scope = decoded.get("connection_scope") if isinstance(decoded, dict) else None
            context_scope_valid = context_scope_valid and (
                isinstance(scope, dict)
                and scope.get("kind") == "project"
                and scope.get("project_id") == expected_project_id
            )
        elif call.get("function_name") in BROWSER_TOOLS:
            arguments = call.get("arguments")
            same_session = same_session and (
                isinstance(arguments, dict)
                and arguments.get("session_id") == expected_session_id
            )

    observations_valid = bool(context_calls and browser_calls) and not (
        missing_observations or duplicate_observations or error_observations
    )
    return {
        "context_called": bool(context_calls),
        "browser_control_called": bool(browser_calls),
        "observations_valid": observations_valid,
        "context_scope_valid": context_scope_valid and bool(context_calls),
        "same_session": same_session,
        "no_playwright_mcp": not playwright_calls,
        "no_forbidden_kernel_tools": not forbidden_calls,
        "missing_observations": missing_observations,
        "duplicate_observations": duplicate_observations,
        "error_observations": error_observations,
        "kernel_tool_calls": [
            {
                "tool_call_id": call.get("tool_call_id"),
                "name": call.get("function_name"),
                "arguments": call.get("arguments"),
            }
            for call in kernel_calls
        ],
    }


def main() -> int:
    VERIFIER_DIR.mkdir(parents=True, exist_ok=True)
    trajectory = read_json(LOGS_DIR / "agent" / "trajectory.json")
    browser = read_json(Path("/my-info/kernel_browser.json"))
    lifecycle = read_json(Path("/data/kernel-browser-lifecycle.json"))
    manifest = read_json(LOGS_DIR / "kernel-mcp" / "run-manifest.json")
    clawbench_result = read_json(VERIFIER_DIR / "clawbench-result.json")
    reward_path = VERIFIER_DIR / "reward.json"
    reward_metrics = read_json(reward_path) or {}

    session_id = str((browser or {}).get("session_id") or "")
    expected_project_id = os.environ.get("KERNEL_MCP_EXPECTED_PROJECT_ID", "")
    atif = validate_control(
        trajectory,
        expected_session_id=session_id,
        expected_project_id=expected_project_id,
    )
    checks = {
        "kernel_mcp_context": atif["context_called"],
        "kernel_mcp_browser_control": atif["browser_control_called"],
        "kernel_mcp_observations": atif["observations_valid"],
        "kernel_mcp_project_scope": atif["context_scope_valid"],
        "kernel_mcp_same_session": atif["same_session"],
        "no_playwright_mcp": atif["no_playwright_mcp"],
        "no_forbidden_kernel_tools": atif["no_forbidden_kernel_tools"],
        "kernel_mcp_source_sha": bool(
            manifest
            and manifest.get("kernel_mcp_server_sha") == os.environ.get("KERNEL_MCP_SOURCE_SHA")
        ),
        "kernel_mcp_manifest_session": bool(
            manifest and manifest.get("browser_session_id") == session_id
        ),
        "kernel_mcp_toolset_allowlist": bool(
            manifest
            and set(str(manifest.get("enabled_toolsets", "")).split())
            == {"playwright", "computer"}
        ),
        "hypeman_identity": bool(manifest and manifest.get("hypeman_instance_name")),
        "browser_deleted": bool(
            lifecycle
            and lifecycle.get("status") == "deleted"
            and lifecycle.get("deletion_verified") is True
        ),
        "clawbench_intercepted": bool(
            reward_metrics.get("intercepted") == 1
            or (clawbench_result or {}).get("intercepted") is True
        ),
    }
    infra_ok = all(value for name, value in checks.items() if name != "clawbench_intercepted")
    checks["infra_ok"] = infra_ok

    reward_metrics.update({name: float(value) for name, value in checks.items()})
    reward_path.write_text(json.dumps(reward_metrics, indent=2))
    result = {
        "checks": checks,
        "session_id": session_id,
        "expected_project_id": expected_project_id,
        "atif": atif,
        "run_manifest": manifest,
        "browser_lifecycle": lifecycle,
        "clawbench_result": clawbench_result,
    }
    (VERIFIER_DIR / "kernel-mcp-control-result.json").write_text(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
