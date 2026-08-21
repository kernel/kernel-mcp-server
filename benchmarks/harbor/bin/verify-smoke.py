#!/usr/bin/env python3
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

LOGS_DIR = Path(os.environ.get("HARBOR_LOGS_DIR", "/logs"))
VERIFIER_DIR = LOGS_DIR / "verifier"


def read_json(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def read_requests(path: Path) -> list[dict[str, Any]]:
    requests = []
    try:
        lines = path.read_text().splitlines()
    except OSError:
        return requests
    for line in lines:
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            requests.append(value)
    return requests


def successful_call(requests: list[dict[str, Any]], name: str) -> dict[str, Any] | None:
    return next(
        (
            request
            for request in requests
            if request.get("jsonrpc_method") == "tools/call"
            and request.get("tool_name") == name
            and request.get("success") is True
        ),
        None,
    )


def trajectory_tool_names(trajectory: dict[str, Any] | None) -> list[str]:
    names = []
    for step in (trajectory or {}).get("steps") or []:
        if not isinstance(step, dict):
            continue
        for call in step.get("tool_calls") or []:
            if isinstance(call, dict) and isinstance(call.get("function_name"), str):
                names.append(call["function_name"])
    return names


def main() -> int:
    VERIFIER_DIR.mkdir(parents=True, exist_ok=True)
    requests = read_requests(LOGS_DIR / "kernel-mcp/requests.jsonl")
    report = read_json(LOGS_DIR / "artifacts/agent-report.json")
    trajectory = read_json(LOGS_DIR / "agent/trajectory.json")
    manifest = read_json(LOGS_DIR / "kernel-mcp/run-manifest.json")

    context_call = successful_call(requests, "get_connection_context")
    browsers_call = successful_call(requests, "manage_browsers")
    expected_project_id = os.environ.get("KERNEL_MCP_EXPECTED_PROJECT_ID", "")
    report_matches = bool(
        report
        and report.get("get_connection_context_succeeded") is True
        and report.get("manage_browsers_list_succeeded") is True
        and report.get("connection_scope_kind") == "project"
        and report.get("project_id") == expected_project_id
    )
    source_sha_matches = bool(
        manifest
        and manifest.get("kernel_mcp_server_sha")
        == os.environ.get("KERNEL_MCP_SOURCE_SHA")
    )
    trajectory_names = trajectory_tool_names(trajectory)
    trajectory_has_calls = any(
        name.endswith("get_connection_context") for name in trajectory_names
    ) and any(name.endswith("manage_browsers") for name in trajectory_names)
    hypeman_identity_present = bool(
        manifest and manifest.get("hypeman_instance_name")
    )

    checks = {
        "get_connection_context": context_call is not None,
        "manage_browsers_list": browsers_call is not None,
        "agent_report": report_matches,
        "source_sha": source_sha_matches,
        "hypeman_identity": hypeman_identity_present,
        "trajectory": trajectory_has_calls,
        "server_stdout": (LOGS_DIR / "kernel-mcp/server.stdout.log").is_file(),
        "server_stderr": (LOGS_DIR / "kernel-mcp/server.stderr.log").is_file(),
    }
    reward = 1.0 if all(checks.values()) else 0.0
    tool_calls = [
        {
            "name": call["tool_name"],
            "success": call["success"],
            "duration_ms": call["duration_ms"],
            "http_status": call["http_status"],
        }
        for call in (context_call, browsers_call)
        if call is not None
    ]
    result = {
        "reward": reward,
        "checks": checks,
        "tool_calls": tool_calls,
        "agent_report": report,
        "trajectory": {
            "present": trajectory is not None,
            "schema_version": (trajectory or {}).get("schema_version"),
            "agent": (trajectory or {}).get("agent"),
            "tool_names": trajectory_names,
        },
        "run_manifest": manifest,
    }

    (VERIFIER_DIR / "reward.txt").write_text(str(reward))
    (VERIFIER_DIR / "reward.json").write_text(
        json.dumps(
            {
                "reward": reward,
                "get_connection_context": float(context_call is not None),
                "manage_browsers_list": float(browsers_call is not None),
                "agent_report": float(report_matches),
                "source_sha": float(source_sha_matches),
                "hypeman_identity": float(hypeman_identity_present),
                "trajectory": float(trajectory_has_calls),
            },
            indent=2,
        )
    )
    (VERIFIER_DIR / "smoke-result.json").write_text(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
