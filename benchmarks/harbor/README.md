# Harbor ClawBench benchmark

This directory runs stock Harbor agents (Claude Code, Codex) against a locally built `kernel-mcp-server` on a ClawBench task in a single Hypeman sandbox. The task starts from the Kernel-backed ClawBench Harbor adaptation, replaces Playwright MCP with the local source-pinned Kernel MCP server, and keeps ClawBench attached to the same pre-created browser.

## Requirements

- Harbor 0.21.0 with `harbor-hypeman` 0.1.1 (launched through `uvx`)
- [uv](https://docs.astral.sh/uv/) and Hypeman CLI credentials
- A ClawBench checkout containing commit `df6743f` (`kernel/ClawBench` PR #1)
- `KERNEL_MCP_BENCHMARK_API_KEY` scoped to an isolated evaluation project
- `KERNEL_MCP_BENCHMARK_PROJECT_ID`
- `PURELY_MAIL_API_KEY` and `PURELY_MAIL_DOMAIN` for account-task credentials
- `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` for Claude Code
- `OPENAI_API_KEY` for Codex

## Build the image

```bash
./benchmarks/harbor/build-image.sh
```

The build uses the current Git SHA, installs dependencies with Bun, runs the production Next.js build, and writes the resulting image reference to the ignored `.image.env` file. Hypeman can report a failed build before the converted image becomes visible; the script performs a bounded 5-minute ready-image check for that case.

## Run the ClawBench Kernel MCP arm

```bash
export CLAWBENCH_REPO=../ClawBench
./benchmarks/harbor/clawbench/run-control.sh claude-code \
  v2-1134-chapter-finder-redcross
```

Defaults:

| Agent       | Version | Model             |
| ----------- | ------: | ----------------- |
| Claude Code | 2.1.238 | `claude-sonnet-5` |
| Codex       | 0.120.0 | `gpt-5.6-luna`    |

Override models with `CLAUDE_BENCHMARK_MODEL` or `CODEX_BENCHMARK_MODEL`. Single-task runs have a 40-minute wall-clock limit; full-suite runs default to 6 hours. Change either with `HARBOR_BENCHMARK_TIMEOUT`.

Pass `all` instead of a task ID to run the complete suite, and set `HARBOR_N_CONCURRENT` to control parallelism:

```bash
HARBOR_N_CONCURRENT=10 ./benchmarks/harbor/clawbench/run-control.sh codex all
```

`run-control.sh` adapts the selected ClawBench tasks with `clawbench-harbor-adapt`, converts them with `clawbench/prepare-control.py`, and runs them under Harbor. Each generated task:

- exposes `get_connection_context` and `execute_playwright_code`
- disables coordinate-based computer actions, browser lifecycle, and managed-auth toolsets
- instructs the agent to read `./my-info/kernel_browser.json` and use that session ID
- instructs account tasks to use the supplied PurelyMail credentials instead of managed auth
- verifies ATIF observations, project scope, exact session reuse, ClawBench interception, replay finalization, and browser deletion

Outputs use the normal Harbor job directory and add `kernel-mcp-control-result.json`, Kernel MCP logs, source manifests, and same-session metrics to the ClawBench verifier artifacts.
