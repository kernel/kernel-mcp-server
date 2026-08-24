#!/usr/bin/env python3
"""Record whether a ClawBench trial used the intended Kernel MCP setup.

ClawBench's verifier remains responsible for the task reward, request
interception, replay download, and browser cleanup. This script adds one
`kernel_mcp_valid` diagnostic metric so benchmark results can distinguish a
failed task from a trial that never exercised the local server correctly.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

LOGS_DIR = Path(os.environ.get("HARBOR_LOGS_DIR", "/logs"))
VERIFIER_DIR = LOGS_DIR / "verifier"
PLAYWRIGHT_TOOL = "mcp__kernel__execute_playwright_code"


def read_object(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def tool_calls(trajectory: dict[str, Any]) -> list[dict[str, Any]]:
    calls: list[dict[str, Any]] = []
    for step in trajectory.get("steps") or []:
        if isinstance(step, dict):
            calls.extend(
                call for call in step.get("tool_calls") or [] if isinstance(call, dict)
            )
    return calls


def main() -> int:
    VERIFIER_DIR.mkdir(parents=True, exist_ok=True)
    browser = read_object(Path("/my-info/kernel_browser.json"))
    manifest = read_object(LOGS_DIR / "kernel-mcp" / "run-manifest.json")
    trajectory = read_object(LOGS_DIR / "agent" / "trajectory.json")

    expected_session = browser.get("session_id")
    calls = [
        call
        for call in tool_calls(trajectory)
        if call.get("function_name") == PLAYWRIGHT_TOOL
    ]
    called_sessions = {
        arguments.get("session_id")
        for call in calls
        if isinstance((arguments := call.get("arguments")), dict)
    }

    expected_source = os.environ.get("KERNEL_MCP_SOURCE_SHA")
    checks = {
        "used_kernel_mcp": bool(calls),
        "used_clawbench_browser": bool(expected_session)
        and called_sessions == {expected_session},
        "used_expected_source": bool(expected_source)
        and manifest.get("kernel_mcp_server_sha") == expected_source,
    }
    valid = all(checks.values())

    result = {
        "valid": valid,
        "checks": checks,
        "expected_session_id": expected_session,
        "called_session_ids": sorted(str(value) for value in called_sessions),
        "expected_source_sha": expected_source,
        "actual_source_sha": manifest.get("kernel_mcp_server_sha"),
    }
    (VERIFIER_DIR / "kernel-mcp-result.json").write_text(json.dumps(result, indent=2))

    reward_path = VERIFIER_DIR / "reward.json"
    rewards = read_object(reward_path)
    rewards["kernel_mcp_valid"] = float(valid)
    reward_path.write_text(json.dumps(rewards, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
