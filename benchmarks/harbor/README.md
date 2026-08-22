# Harbor MCP benchmarks

This directory runs stock Harbor agents against a locally built `kernel-mcp-server` in a single Hypeman sandbox. The smoke task makes two read-only calls through the configured stdio MCP server and writes standard Harbor job artifacts.

## Requirements

- Harbor 0.21.0
- `harbor-hypeman` 0.1.1
- [uv](https://docs.astral.sh/uv/) and Hypeman CLI credentials
- `KERNEL_MCP_BENCHMARK_API_KEY` scoped to an isolated evaluation project
- `KERNEL_MCP_BENCHMARK_PROJECT_ID`
- `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` for Claude Code
- `OPENAI_API_KEY` for Codex

`run-smoke.sh` launches the pinned Harbor packages through `uvx`. To install the same versions as a persistent tool instead:

```bash
uv tool install 'harbor==0.21.0' --with 'harbor-hypeman==0.1.1'
```

Set `HARBOR_BIN` only when intentionally testing a different Harbor installation.

## Build the image

```bash
./benchmarks/harbor/build-image.sh
```

The build uses the current Git SHA, installs dependencies with Bun, runs the production Next.js build, and writes the resulting image reference to the ignored `.image.env` file. Hypeman can report a failed build before the converted image becomes visible; the script performs a bounded 5-minute ready-image check for that case.

## Run the smoke task

```bash
export KERNEL_MCP_BENCHMARK_PROJECT_ID=project_id
./benchmarks/harbor/run-smoke.sh claude-code
./benchmarks/harbor/run-smoke.sh codex
```

Defaults:

| Agent       | Version | Model             |
| ----------- | ------: | ----------------- |
| Claude Code | 2.1.238 | `claude-sonnet-5` |
| Codex       | 0.120.0 | `gpt-5.6-terra`   |

Override models with `CLAUDE_BENCHMARK_MODEL` or `CODEX_BENCHMARK_MODEL`, or test a specific Claude Code release with `CLAUDE_BENCHMARK_VERSION`. Runs have a 10-minute wall-clock limit; change it with `HARBOR_BENCHMARK_TIMEOUT`.

The output defaults to `/tmp/kernel-mcp-harbor-jobs/<job-name>`. Each successful trial contains:

- `steps/run/agent/trajectory.json` in ATIF format
- native agent logs and session data
- server stdout and stderr
- source SHA and Hypeman identity in `run-manifest.json`
- numeric Harbor rewards plus detailed `smoke-result.json`

The verifier proves local-server use from Harbor's ATIF trajectory: it requires native `mcp__kernel__get_connection_context` and `mcp__kernel__manage_browsers` calls, paired non-error observations, the expected project scope, and the required read-only browser-list arguments. Direct HTTP or custom MCP-client workarounds do not pass.

## Run the ClawBench Kernel MCP arm

The ClawBench arm starts from the Kernel-backed Harbor task produced by `clawbench-harbor-adapt`, replaces Playwright MCP with the local source-pinned Kernel MCP server, and keeps ClawBench attached to the same pre-created browser.

```bash
export CLAWBENCH_REPO=../ClawBench
./benchmarks/harbor/clawbench/run-control.sh claude-code \
  v2-1134-chapter-finder-redcross
```

The ClawBench checkout must contain commit `bf6d1ff`, from `kernel/ClawBench` PR #1. The generated task:

- exposes `get_connection_context`, `execute_playwright_code`, and `computer_action`
- disables browser lifecycle and managed-auth toolsets
- instructs the agent to read `./my-info/kernel_browser.json` and use that session ID
- instructs account tasks to use the supplied PurelyMail credentials instead of managed auth
- verifies ATIF observations, project scope, exact session reuse, ClawBench interception, replay finalization, and browser deletion

Outputs use the normal Harbor job directory and add `kernel-mcp-control-result.json`, Kernel MCP logs, source manifests, and same-session metrics to the ClawBench verifier artifacts.
