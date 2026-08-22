from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path
from types import ModuleType

HERE = Path(__file__).parent


def load_module(name: str, filename: str) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


prepare = load_module("prepare_control", "prepare-control.py")
verify = load_module("verify_control", "verify-control.py")


class PrepareControlTest(unittest.TestCase):
    def test_transforms_playwright_control_into_kernel_mcp_arm(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            task = Path(temp)
            environment = task / "environment"
            step = task / "steps" / "run"
            (step / "workdir").mkdir(parents=True)
            (step / "tests").mkdir()
            (step / "instruction.md").write_text(
                "Use only Playwright MCP browser tools plus reading files under ./my-info/.\n"
            )
            (environment / "harbor").mkdir(parents=True)
            (environment / "Dockerfile").write_text("FROM python:3.11-slim\n")
            (task / "task.toml").write_text(
                """[environment]
workdir = "/"

[environment.env]
KERNEL_API_KEY = "${KERNEL_API_KEY}"

[[steps]]
name = "run"

[[environment.mcp_servers]]
name = "playwright"
transport = "stdio"
command = "npx"
args = ["-y", "@playwright/mcp@0.0.79"]
"""
            )
            (step / "workdir" / "setup.sh").write_text(
                "#!/bin/bash\nmkdir -p /data /logs/verifier /extra_info\n"
                "/app/src/harbor/start-runtime.sh\n"
            )
            (step / "tests" / "test.sh").write_text(
                "#!/bin/bash\n"
                "/app/src/runtime-server/.venv/bin/python /app/src/harbor/verify.py\n"
            )

            prepare.transform_task(
                task,
                image="docker.io/builds/image:latest",
                server_sha="server-sha",
                clawbench_sha="clawbench-sha",
            )

            task_toml = (task / "task.toml").read_text()
            self.assertFalse((environment / "Dockerfile").exists())
            self.assertIn('docker_image = "docker.io/builds/image:latest"', task_toml)
            self.assertIn('name = "kernel"', task_toml)
            self.assertIn('command = "/usr/local/bin/kernel-mcp-local"', task_toml)
            self.assertNotIn("@playwright/mcp", task_toml)
            self.assertIn(
                'KERNEL_MCP_ENABLED_TOOLSETS = "playwright computer"', task_toml
            )
            self.assertNotIn("KERNEL_MCP_DISABLED_TOOLSETS", task_toml)
            self.assertIn('API_BASE_URL = "${KERNEL_API_BASE_URL:-}"', task_toml)
            self.assertNotIn("KERNEL_API_BASE_URL =", task_toml)
            self.assertIn('REDIS_URL = "redis://127.0.0.1:6379"', task_toml)

            setup = (step / "workdir" / "setup.sh").read_text()
            self.assertIn("install_clawbench_runtime", setup)
            self.assertIn("start-kernel-mcp-server", setup)
            test_script = (step / "tests" / "test.sh").read_text()
            self.assertIn("verify-kernel-mcp-control.py", test_script)
            self.assertIn("/logs/verifier/kernel-mcp", test_script)
            instruction = (step / "instruction.md").read_text()
            self.assertIn("WaitForMcpServers", instruction)
            self.assertIn("existing `session_id`", instruction)
            self.assertIn("Use only Kernel MCP browser-control tools", instruction)
            self.assertIn("PurelyMail-backed credentials", instruction)
            self.assertIn("Do not use Kernel managed auth", instruction)
            self.assertIn("Do not call `fetch`", instruction)
            self.assertTrue((environment / "harbor" / "verify-kernel-mcp-control.py").is_file())


class VerifyControlTest(unittest.TestCase):
    def trajectory(self, session_id: str = "session-123") -> dict:
        return {
            "steps": [
                {
                    "tool_calls": [
                        {
                            "tool_call_id": "context-1",
                            "function_name": "mcp__kernel__get_connection_context",
                            "arguments": {},
                        },
                        {
                            "tool_call_id": "playwright-1",
                            "function_name": "mcp__kernel__execute_playwright_code",
                            "arguments": {
                                "session_id": session_id,
                                "code": "await page.goto('https://example.com')",
                            },
                        },
                    ],
                    "observation": {
                        "results": [
                            {
                                "source_call_id": "context-1",
                                "content": {
                                    "connection_scope": {
                                        "kind": "project",
                                        "project_id": "project-123",
                                    }
                                },
                            },
                            {
                                "source_call_id": "playwright-1",
                                "content": [{"type": "text", "text": "{\"ok\": true}"}],
                            },
                        ]
                    },
                }
            ]
        }

    def test_accepts_successful_calls_on_precreated_session(self) -> None:
        result = verify.validate_control(
            self.trajectory(),
            expected_session_id="session-123",
            expected_project_id="project-123",
        )
        for key in (
            "context_called",
            "browser_control_called",
            "observations_valid",
            "context_scope_valid",
            "same_session",
            "no_playwright_mcp",
            "no_forbidden_kernel_tools",
            "no_direct_http_automation",
        ):
            self.assertTrue(result[key], key)

    def test_rejects_another_session(self) -> None:
        result = verify.validate_control(
            self.trajectory("session-other"),
            expected_session_id="session-123",
            expected_project_id="project-123",
        )
        self.assertFalse(result["same_session"])

    def test_rejects_direct_http_inside_playwright_code(self) -> None:
        trajectory = self.trajectory()
        trajectory["steps"][0]["tool_calls"][1]["arguments"]["code"] = (
            "return await page.evaluate(() => fetch('/api'))"
        )
        result = verify.validate_control(
            trajectory,
            expected_session_id="session-123",
            expected_project_id="project-123",
        )
        self.assertFalse(result["no_direct_http_automation"])

    def test_rejects_playwright_mcp_and_lifecycle_tools(self) -> None:
        trajectory = self.trajectory()
        trajectory["steps"][0]["tool_calls"].extend(
            [
                {
                    "tool_call_id": "direct-playwright",
                    "function_name": "mcp__playwright__browser_navigate",
                    "arguments": {},
                },
                {
                    "tool_call_id": "browser-list",
                    "function_name": "mcp__kernel__manage_browsers",
                    "arguments": {"action": "list"},
                },
            ]
        )
        result = verify.validate_control(
            trajectory,
            expected_session_id="session-123",
            expected_project_id="project-123",
        )
        self.assertFalse(result["no_playwright_mcp"])
        self.assertFalse(result["no_forbidden_kernel_tools"])


if __name__ == "__main__":
    unittest.main()
