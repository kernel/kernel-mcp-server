# Harbor MCP benchmarks

This directory runs stock Harbor agents against a locally built `kernel-mcp-server` in a single Hypeman sandbox. The smoke task makes two read-only calls through the configured stdio MCP server and writes standard Harbor job artifacts.

## Requirements

- Harbor 0.21.0 with `harbor_hypeman:HypemanEnvironment`
- `harbor-hypeman` with existing Hypeman image-reference support
- Hypeman CLI and credentials
- `KERNEL_MCP_BENCHMARK_API_KEY` scoped to an isolated evaluation project
- `KERNEL_MCP_BENCHMARK_PROJECT_ID`
- `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` for Claude Code
- `OPENAI_API_KEY` for Codex

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
