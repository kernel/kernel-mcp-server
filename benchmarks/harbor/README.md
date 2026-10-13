# Benchmark Kernel MCP with ClawBench

[ClawBench](https://github.com/TIGER-AI-Lab/ClawBench) is a suite of browser tasks. Each task describes work to complete on a real website and an evaluator that watches for the network request representing completion. ClawBench then judges the submitted request parameters.

[Harbor](https://github.com/laude-institute/harbor) runs those tasks as reproducible agent trials. For each trial, Harbor creates an isolated environment, installs a stock agent such as Codex or Claude Code, gives it the task's MCP tools and instruction, runs the verifier, and writes the reward and ATIF trajectory to a job directory.

This benchmark uses Harbor's `kernel` environment as its execution backend. For every trial, Harbor creates one headful stealth Kernel browser VM, builds the task image inside it with Docker, and runs the task in that container:

1. The image contains ClawBench's runtime and a build of the benchmarked `kernel-mcp-server` commit.
2. ClawBench attaches its request evaluator and replay to the trial's Kernel browser.
3. The task setup starts Redis and the local `kernel-mcp-server` on port 3002.
4. Harbor starts the stock agent with a stdio MCP command that connects to that local server.
5. The agent controls the trial's browser through `execute_playwright_code`; it cannot create browsers or use managed auth.
6. ClawBench scores the intercepted request and downloads the replay. Harbor deletes the browser when the trial ends.

The image records the benchmarked Git SHA, and the generated task records the ClawBench SHA and browser session ID. The additional `kernel_mcp_valid` result confirms that the agent called the local server with the trial's browser. Task reward still comes directly from ClawBench.

## Requirements

- `uv` and `git`; the runner installs Harbor from the commit in `HARBOR_REF`
- a [`kernel/ClawBench`](https://github.com/kernel/ClawBench) checkout containing pinned commit `187cd252bc60af8ac3a2c98a87c9316e49a5ac75`
- `KERNEL_MCP_BENCHMARK_API_KEY` scoped to an isolated evaluation project; its credential scope is the project source of truth
- `PURELY_MAIL_API_KEY` and `PURELY_MAIL_DOMAIN` for ClawBench account tasks
- `OPENAI_API_KEY` for Codex, or Anthropic credentials for Claude Code
- the ClawBench judge variables when using a hosted judge: `CLAWBENCH_JUDGE_BASE_URL`, `CLAWBENCH_JUDGE_API_KEY`, `CLAWBENCH_JUDGE_MODEL`, and `CLAWBENCH_JUDGE_API_TYPE`
- `BRAINTRUST_API_KEY` and `BRAINTRUST_PROJECT` when publishing results

The runner checks `/auth/context` before generating trials and stops unless the benchmark credential and effective connection resolve to the same non-empty project scope.

The runner benchmarks the committed `HEAD` of the checkout. Each trial builds `benchmarks/harbor/image/Dockerfile` from that commit inside its browser VM, so uncommitted changes are not included.

## Run one task

```bash
export CLAWBENCH_REPO=../ClawBench
./benchmarks/harbor/clawbench/run.sh codex \
  v2-1134-chapter-finder-redcross
```

## Run the full suite

```bash
export CLAWBENCH_REPO=../ClawBench
HARBOR_N_CONCURRENT=10 \
  ./benchmarks/harbor/clawbench/run.sh codex all
```

Codex defaults to version `0.120.0` with `gpt-5.6-luna`. Claude Code defaults to version `2.1.238` with `claude-sonnet-5`. Override these with `CODEX_BENCHMARK_MODEL`, `CODEX_BENCHMARK_VERSION`, `CLAUDE_BENCHMARK_MODEL`, or `CLAUDE_BENCHMARK_VERSION`.

Single-task runs have a 40-minute wall-clock limit. Full-suite runs default to six hours. Set `HARBOR_BENCHMARK_TIMEOUT` to override either limit. Set `HARBOR_JOBS_DIR` to choose where Harbor writes results.

Before creating the Harbor dataset, the runner creates and deletes one disposable PurelyMail account. API errors stop the run before trials begin, so missing email accounts cannot silently become task failures.

The runner retries a whole isolated trial up to five times for transient Kernel connection, timeout, browser placement, and agent setup failures. Harbor step `setup.sh` failures are not retried; the PurelyMail preflight catches the known external setup dependency before trials begin. Set `HARBOR_MAX_RETRIES` to override the trial retry limit. Per-request SDK retries remain disabled because transparently retrying browser creation can duplicate a request whose first response was lost.

## GitHub Actions

The `Benchmark ClawBench` workflow runs the complete suite weekly and on demand. Select it from the Actions tab and provide either a same-repository PR number or a ref. Comparison runs benchmark the candidate SHA against its merge base so unrelated changes on the target branch do not affect the delta. Harbor, agent, and model versions are pinned by the workflow and each arm's observed agent configuration appears in the report.

An organization member or repository collaborator can also start the full PR comparison by commenting this exact command on a same-repository pull request:

```text
/benchmark clawbench
```

The command parser does not execute comment text. It accepts only the exact command, rejects fork pull requests and untrusted commenters, and resolves the candidate and merge-base SHAs through GitHub's API. The workflow uses the `benchmarks` environment for credentials, updates one benchmark comment on the pull request, and publishes the same results to Braintrust.

## Results

Harbor writes its normal job directory, including:

- `trajectory.json`: the agent's ATIF messages and tool calls
- `reward.json`: ClawBench's reward plus the `kernel_mcp_valid` diagnostic
- `clawbench-result.json`: evaluator details
- `kernel-mcp-result.json`: local-source and same-browser wiring details
- `recording.mp4`: the finalized Kernel replay
- `kernel-mcp/`: local server logs and the source/session manifest

Generate a redacted summary from one or more completed jobs:

```bash
bun run benchmark:report -- \
  --arm candidate=/path/to/candidate-job \
  --arm baseline=/path/to/baseline-job \
  --json /tmp/benchmark-summary.json \
  --markdown /tmp/benchmark-summary.md
```

Publish those arms as one idempotent Braintrust experiment:

```bash
BRAINTRUST_PROJECT=kernel-mcp-server-benchmarks \
  bun run benchmark:publish -- \
    --experiment pr-162-a60c518-example \
    --arm candidate=/path/to/candidate-job \
    --arm baseline=/path/to/baseline-job
```

The experiment name and deterministic row/span IDs make it safe to publish the same job directories again. Re-publication replaces the rows and refreshes experiment metadata. Rows contain task identity, the redacted instruction, numeric rewards, provenance, bounded errors, and trial timing. Setup, browser lifetime, execution, verification, and finalization are separate timeline spans; the browser span records its timeout and deletion status without its identifiers. ATIF turns include their preceding context, structured tool calls, cached-token metrics, and inferred turn intervals. Browser tool spans record whether the supplied session ID matched the trial's expected session without publishing either ID. Tool durations remain unspecified because ATIF does not record them.

The publisher redacts typed form values, configured secrets, credentials, email addresses, browser session/replay IDs, private-info file contents, and provider URLs. It validates the final payload and aborts before creating an experiment if sensitive content remains. Ground truth, recordings, and raw Harbor jobs are never published.

Reports suppress comparison deltas when either arm has an infrastructure failure or ungraded trial. The workflow fails unless every intended trial is graded, while still retaining the incomplete report for diagnosis.
