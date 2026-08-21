# Harbor MCP benchmarks

This directory runs stock Harbor agents against a locally built `kernel-mcp-server` in a single Hypeman sandbox. The smoke task makes two read-only calls through the configured stdio MCP server and writes standard Harbor job artifacts.

## Requirements

- Harbor 0.21.0 with `harbor_hypeman:HypemanEnvironment`
- `harbor-hypeman` with existing Hypeman image-reference support
- Hypeman CLI and credentials
- `KERNEL_MCP_BENCHMARK_API_KEY` scoped to an isolated evaluation project
- `KERNEL_MCP_BENCHMARK_PROJECT_ID`
- `ANTHROPIC_API_KEY` for Claude Code
- `OPENAI_API_KEY` for Codex

## Build the image

```bash
./benchmarks/harbor/build-image.sh
```

The build uses the current Git SHA, installs dependencies with Bun, runs the production Next.js build, and writes the resulting image reference to the ignored `.image.env` file. Hypeman can report a failed build before the converted image becomes visible; the script performs a bounded 60-second ready-image check for that case.

## Run the smoke task

```bash
export KERNEL_MCP_BENCHMARK_PROJECT_ID=project_id
./benchmarks/harbor/run-smoke.sh claude-code
./benchmarks/harbor/run-smoke.sh codex
```

Defaults:

| Agent       | Version | Model             |
| ----------- | ------: | ----------------- |
| Claude Code | 2.1.110 | `claude-sonnet-5` |
| Codex       | 0.120.0 | `gpt-5.6-terra`   |

Override models with `CLAUDE_BENCHMARK_MODEL` or `CODEX_BENCHMARK_MODEL`. Runs have a 10-minute wall-clock limit; change it with `HARBOR_BENCHMARK_TIMEOUT`.

The output defaults to `/tmp/kernel-mcp-harbor-jobs/<job-name>`. Each successful trial contains:

- `steps/run/agent/trajectory.json` in ATIF format
- native agent logs and session data
- `steps/run/artifacts/logs/kernel-mcp/requests.jsonl` with MCP latency and status
- server stdout and stderr
- source SHA and Hypeman identity in `run-manifest.json`
- numeric Harbor rewards plus detailed `smoke-result.json`

The verifier requires native trajectory calls to `get_connection_context` and `manage_browsers`; direct HTTP or custom MCP-client workarounds do not pass.
