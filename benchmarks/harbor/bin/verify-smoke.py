#!/usr/bin/env python3
from __future__ import annotations

import ast
import json
import os
from pathlib import Path
from typing import Any

LOGS_DIR = Path(os.environ.get("HARBOR_LOGS_DIR", "/logs"))
VERIFIER_DIR = LOGS_DIR / "verifier"
REQUIRED_TOOLS = {
    "mcp__kernel__get_connection_context",
    "mcp__kernel__manage_browsers",
}


def read_json(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _decode_tool_result_content(content: Any) -> Any:
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
        if "error" in value and value["error"] not in (None, False, ""):
            return True
        return any(_contains_error(item) for item in value.values())
    if isinstance(value, list):
        return any(_contains_error(item) for item in value)
    if isinstance(value, str):
        text = value.lstrip().lower()
        return text.startswith(("[error]", "error:", "error in "))
    return False


def _observation_result_map(trajectory: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
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
            source_call_id = result.get("source_call_id")
            if isinstance(source_call_id, str):
                results.setdefault(source_call_id, []).append(result)
    return results


def _native_tool_calls(trajectory: dict[str, Any]) -> list[dict[str, Any]]:
    calls = []
    for step in trajectory.get("steps") or []:
        if not isinstance(step, dict):
            continue
        for call in step.get("tool_calls") or []:
            if not isinstance(call, dict):
                continue
            if call.get("function_name") in REQUIRED_TOOLS:
                calls.append(call)
    return calls


def _manage_browsers_arguments_valid(call: dict[str, Any]) -> bool:
    arguments = call.get("arguments")
    return (
        isinstance(arguments, dict)
        and arguments.get("action") == "list"
        and arguments.get("status") == "active"
        and arguments.get("limit") == 1
    )


def validate_trajectory(
    trajectory: dict[str, Any] | None, expected_project_id: str
) -> dict[str, Any]:
    calls = _native_tool_calls(trajectory or {})
    calls_by_name = {
        name: [call for call in calls if call.get("function_name") == name]
        for name in REQUIRED_TOOLS
    }
    result_map = _observation_result_map(trajectory or {})
    missing_observations = []
    duplicate_observations = []
    error_observations = []
    context_scope_valid = True
    browser_arguments_valid = True

    for call in calls:
        call_id = call.get("tool_call_id")
        results = result_map.get(call_id, []) if isinstance(call_id, str) else []
        if len(results) == 0:
            missing_observations.append(call_id)
            continue
        if len(results) != 1:
            duplicate_observations.append(call_id)
            continue
        result = results[0]
        decoded = _decode_tool_result_content(result.get("content"))
        if _contains_error(decoded) or _contains_error(result):
            error_observations.append(call_id)
            continue
        if call.get("function_name") == "mcp__kernel__get_connection_context":
            scope = decoded.get("connection_scope") if isinstance(decoded, dict) else None
            context_scope_valid = context_scope_valid and (
                bool(expected_project_id)
                and isinstance(scope, dict)
                and scope.get("kind") == "project"
                and scope.get("project_id") == expected_project_id
            )
        elif call.get("function_name") == "mcp__kernel__manage_browsers":
            browser_arguments_valid = (
                browser_arguments_valid and _manage_browsers_arguments_valid(call)
            )

    native_calls_present = all(calls_by_name[name] for name in REQUIRED_TOOLS)
    observations_valid = bool(calls) and not (
        missing_observations or duplicate_observations or error_observations
    )
    return {
        "native_calls_present": native_calls_present,
        "observations_valid": observations_valid,
        "context_scope_valid": context_scope_valid
        and bool(calls_by_name["mcp__kernel__get_connection_context"]),
        "manage_browsers_arguments_valid": browser_arguments_valid
        and bool(calls_by_name["mcp__kernel__manage_browsers"]),
        "missing_observations": missing_observations,
        "duplicate_observations": duplicate_observations,
        "error_observations": error_observations,
        "tool_calls": [
            {
                "tool_call_id": call.get("tool_call_id"),
                "name": call.get("function_name"),
                "arguments": call.get("arguments"),
            }
            for call in calls
        ],
    }


def main() -> int:
    VERIFIER_DIR.mkdir(parents=True, exist_ok=True)
    report = read_json(LOGS_DIR / "artifacts/agent-report.json")
    trajectory = read_json(LOGS_DIR / "agent/trajectory.json")
    manifest = read_json(LOGS_DIR / "kernel-mcp/run-manifest.json")
    expected_project_id = os.environ.get("KERNEL_MCP_EXPECTED_PROJECT_ID", "")
    atif = validate_trajectory(trajectory, expected_project_id)
    source_sha_matches = bool(
        manifest
        and manifest.get("kernel_mcp_server_sha")
        == os.environ.get("KERNEL_MCP_SOURCE_SHA")
    )
    hypeman_identity_present = bool(
        manifest and manifest.get("hypeman_instance_name")
    )

    checks = {
        "native_mcp_calls": atif["native_calls_present"],
        "tool_observations": atif["observations_valid"],
        "context_scope": atif["context_scope_valid"],
        "manage_browsers_arguments": atif["manage_browsers_arguments_valid"],
        "source_sha": source_sha_matches,
        "hypeman_identity": hypeman_identity_present,
        "server_stdout": (LOGS_DIR / "kernel-mcp/server.stdout.log").is_file(),
        "server_stderr": (LOGS_DIR / "kernel-mcp/server.stderr.log").is_file(),
    }
    reward = 1.0 if all(checks.values()) else 0.0
    result = {
        "reward": reward,
        "checks": checks,
        "atif": atif,
        "agent_report": report,
        "trajectory": {
            "present": trajectory is not None,
            "schema_version": (trajectory or {}).get("schema_version"),
            "agent": (trajectory or {}).get("agent"),
        },
        "run_manifest": manifest,
    }

    (VERIFIER_DIR / "reward.txt").write_text(str(reward))
    (VERIFIER_DIR / "reward.json").write_text(
        json.dumps(
            {"reward": reward, **{name: float(value) for name, value in checks.items()}},
            indent=2,
        )
    )
    (VERIFIER_DIR / "smoke-result.json").write_text(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
