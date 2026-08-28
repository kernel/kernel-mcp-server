#!/usr/bin/env python3
"""Turn a ClawBench Harbor task into the Kernel MCP benchmark arm.

ClawBench generates a complete Harbor task that normally gives the agent
Playwright MCP. This script keeps ClawBench's instruction, evaluator, browser,
and cleanup lifecycle, but swaps the agent-facing MCP server for the local
source build and starts that server during task setup.
"""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

ENABLED_TOOLSETS = "playwright"


def _drop_mcp_servers(task_toml: str) -> str:
    lines = task_toml.splitlines()
    output: list[str] = []
    dropping = False
    for line in lines:
        if line.strip() == "[[environment.mcp_servers]]":
            dropping = True
            continue
        if dropping and line.startswith("["):
            dropping = False
        if not dropping:
            output.append(line)
    return "\n".join(output).rstrip() + "\n"


def _add_environment(
    task_toml: str, *, image: str, server_sha: str, clawbench_sha: str
) -> str:
    lines = task_toml.splitlines()
    output: list[str] = []
    inserted_image = False
    inserted_env = False
    for line in lines:
        output.append(line)
        if line.strip() == "[environment]":
            output.append(f"docker_image = {json.dumps(image)}")
            inserted_image = True
        elif line.strip() == "[environment.env]":
            output.extend(
                [
                    f"KERNEL_MCP_BENCHMARK_IMAGE = {json.dumps(image)}",
                    f"KERNEL_MCP_SOURCE_SHA = {json.dumps(server_sha)}",
                    f"CLAWBENCH_SOURCE_SHA = {json.dumps(clawbench_sha)}",
                    f"KERNEL_MCP_ENABLED_TOOLSETS = {json.dumps(ENABLED_TOOLSETS)}",
                    'API_BASE_URL = "${KERNEL_API_BASE_URL:-}"',
                    'KERNEL_PROJECT = "${KERNEL_PROJECT:-}"',
                    'REDIS_URL = "redis://127.0.0.1:6379"',
                ]
            )
            inserted_env = True
    if not inserted_image or not inserted_env:
        raise ValueError("generated task is missing Harbor environment sections")
    output.extend(
        [
            "",
            "[[environment.mcp_servers]]",
            'name = "kernel"',
            'transport = "stdio"',
            'command = "/usr/local/bin/kernel-mcp-local"',
            "args = []",
        ]
    )
    return "\n".join(output).rstrip() + "\n"


def _patch_setup(setup: str) -> str:
    install = """install_clawbench_runtime() {
  mkdir -p /app/src
  rm -rf /app/src/runtime-server /app/src/chrome-extension /app/src/shared /app/src/harbor
  cp -a /runtime-server /app/src/runtime-server
  cp -a /chrome-extension /app/src/chrome-extension
  cp -a /shared /app/src/shared
  cp -a /harbor /app/src/harbor
  chmod +x /app/src/harbor/*.sh /app/src/harbor/*.py
  cd /app/src/runtime-server
  UV_PYTHON_PREFERENCE=only-system uv sync --frozen
  uv pip install --python .venv/bin/python fpdf2
  cd /
}

install_clawbench_runtime
"""
    marker = "mkdir -p /data /logs/verifier /extra_info\n"
    if marker not in setup:
        raise ValueError("generated setup script is missing directory initialization")
    setup = setup.replace(marker, marker + "\n" + install, 1)
    runtime_marker = "/app/src/harbor/start-runtime.sh\n"
    if runtime_marker not in setup:
        raise ValueError("generated setup script is missing runtime startup")
    return setup.replace(
        runtime_marker,
        runtime_marker + "\nstart-kernel-mcp-server\n",
        1,
    )


def _patch_verifier(test_script: str) -> str:
    verify_marker = (
        "/app/src/runtime-server/.venv/bin/python /app/src/harbor/verify.py\n"
    )
    if verify_marker not in test_script:
        raise ValueError("generated verifier script is missing ClawBench verification")
    return test_script.replace(
        verify_marker,
        verify_marker
        + "mkdir -p /logs/verifier/kernel-mcp\n"
        + "cp -a /logs/kernel-mcp/. /logs/verifier/kernel-mcp/\n"
        + "/app/src/runtime-server/.venv/bin/python "
        + "/app/src/harbor/verify-kernel-mcp-task.py\n",
        1,
    )


def _patch_instruction(instruction: str) -> str:
    instruction = instruction.replace(
        "Use only Playwright MCP browser tools plus reading files",
        "Use only Kernel MCP browser-control tools plus reading files",
    )
    return (
        instruction.rstrip()
        + """

---
Kernel MCP benchmark arm:
- Wait for the `kernel` MCP server to finish initializing before starting. In Claude Code, call `WaitForMcpServers` if it is still pending; do not conclude that the tools are unavailable while it initializes.
- Read `./my-info/kernel_browser.json` and use its existing `session_id` for every `execute_playwright_code` call.
- Do not create, list, update, or delete browsers. Browser lifecycle tools and `computer_action` are intentionally unavailable.
- Use Kernel MCP `execute_playwright_code` for all browser interaction. Do not use Playwright MCP or a direct CDP client.
- Interact through visible page navigation and DOM/UI actions. Do not call `fetch`, `XMLHttpRequest`, Playwright request APIs, or other direct HTTP clients inside `execute_playwright_code`.
- Use the PurelyMail-backed credentials already provided under `./my-info/` when the task requires an account.
- Do not use Kernel managed auth, create an auth connection, or start a hosted login flow.
- Complete and submit the task through the existing browser, then stop.
"""
    )


def transform_task(
    task_dir: Path, *, image: str, server_sha: str, clawbench_sha: str
) -> None:
    dockerfile = task_dir / "environment" / "Dockerfile"
    dockerfile.unlink(missing_ok=True)

    task_toml_path = task_dir / "task.toml"
    task_toml = _drop_mcp_servers(task_toml_path.read_text())
    task_toml_path.write_text(
        _add_environment(
            task_toml,
            image=image,
            server_sha=server_sha,
            clawbench_sha=clawbench_sha,
        )
    )

    step_dir = task_dir / "steps" / "run"
    setup_path = step_dir / "workdir" / "setup.sh"
    setup_path.write_text(_patch_setup(setup_path.read_text()))
    setup_path.chmod(0o755)

    test_path = step_dir / "tests" / "test.sh"
    test_path.write_text(_patch_verifier(test_path.read_text()))
    test_path.chmod(0o755)

    instruction_path = step_dir / "instruction.md"
    instruction_path.write_text(_patch_instruction(instruction_path.read_text()))

    verifier_source = Path(__file__).with_name("verify-task.py")
    verifier_target = task_dir / "environment" / "harbor" / "verify-kernel-mcp-task.py"
    shutil.copy2(verifier_source, verifier_target)
    verifier_target.chmod(0o755)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Replace a generated ClawBench task's Playwright MCP server with the local Kernel MCP build"
    )
    parser.add_argument("task_dir", type=Path)
    parser.add_argument("--image", required=True)
    parser.add_argument("--server-sha", required=True)
    parser.add_argument("--clawbench-sha", required=True)
    args = parser.parse_args()
    transform_task(
        args.task_dir,
        image=args.image,
        server_sha=args.server_sha,
        clawbench_sha=args.clawbench_sha,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
