import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildExperimentEvents, publishBenchmark } from "./publish-braintrust";
import { renderMarkdown } from "./report";
import { readBenchmarkArm, selectPrimaryReward, summarizeArm } from "./results";
import {
  assertSafeToPublish,
  privateInfoRead,
  redactString,
  redactValue,
} from "./redact";
import { assertProjectScopedCredential } from "./verify-project-scope";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "harbor-results-"));
  temporaryDirectories.push(root);
  writeJson(join(root, "config.json"), { job_name: "test-job" });
  writeJson(join(root, "result.json"), {
    id: "job-id",
    n_total_trials: 2,
    stats: {
      n_completed_trials: 1,
      n_errored_trials: 1,
      n_cancelled_trials: 0,
      n_retries: 0,
    },
  });

  const success = join(root, "task-one__abc");
  writeJson(join(success, "result.json"), {
    id: "trial-one",
    task_name: "clawbench/v2-task-one",
    trial_name: "task-one__abc",
    source: "clawbench-v2",
    config: {
      agent: {
        name: "codex",
        model_name: "gpt-5.6-luna",
        kwargs: { version: "0.120.0" },
      },
    },
    verifier_result: {
      rewards: {
        reward: 1,
        reward_lenient: 1,
        reward_strict: 0,
        intercepted: 1,
        kernel_mcp_valid: 1,
      },
    },
    started_at: "2026-01-01T00:00:00Z",
    finished_at: "2026-01-01T00:01:00Z",
    environment_setup: {
      started_at: "2026-01-01T00:00:00Z",
      finished_at: "2026-01-01T00:00:05Z",
    },
    agent_setup: {
      started_at: "2026-01-01T00:00:05Z",
      finished_at: "2026-01-01T00:00:10Z",
    },
    step_results: [
      {
        agent_result: {
          n_input_tokens: 100,
          n_cache_tokens: 80,
          n_output_tokens: 20,
          cost_usd: 0.01,
        },
        agent_execution: {
          started_at: "2026-01-01T00:00:20Z",
          finished_at: "2026-01-01T00:00:40Z",
        },
        verifier: {
          started_at: "2026-01-01T00:00:45Z",
          finished_at: "2026-01-01T00:00:55Z",
        },
      },
    ],
  });
  writeJson(join(success, "steps/run/agent/trajectory.json"), {
    steps: [
      {
        step_id: 1,
        source: "system",
        timestamp: "2026-01-01T00:00:20Z",
        message: "system prompt",
      },
      {
        step_id: 2,
        source: "user",
        timestamp: "2026-01-01T00:00:20Z",
        message: "perform the task",
      },
      {
        step_id: 3,
        source: "agent",
        timestamp: "2026-01-01T00:00:21Z",
        message: "",
        tool_calls: [
          {
            tool_call_id: "call-1",
            function_name: "execute_playwright_code",
            arguments: {
              session_id: "session-123",
              code: "await page.locator('#password').fill('secret-password'); return 'done'",
            },
          },
        ],
        observation: {
          results: [{ source_call_id: "call-1", content: "done" }],
        },
        metrics: {
          prompt_tokens: 100,
          cached_tokens: 80,
          completion_tokens: 20,
          cost_usd: 0.01,
        },
      },
    ],
  });
  writeJson(join(success, "steps/run/verifier/kernel-mcp/run-manifest.json"), {
    kernel_mcp_server_sha: "server-sha",
    clawbench_source_sha: "clawbench-sha",
  });
  writeJson(join(success, "steps/run/verifier/kernel-mcp-result.json"), {
    expected_session_id: "session-123",
  });
  writeJson(
    join(success, "steps/run/verifier/data/kernel-browser-lifecycle.json"),
    {
      timeout_seconds: 1920,
      deletion_verified: true,
      events: [
        { event: "browser_created", ts: 1767225620 },
        { event: "browser_deleted", ts: 1767225640 },
      ],
    },
  );

  const failed = join(root, "task-two__def");
  writeJson(join(failed, "result.json"), {
    id: "trial-two",
    task_name: "clawbench/v2-task-two",
    trial_name: "task-two__def",
    config: { agent: { name: "codex", model_name: "gpt-5.6-luna" } },
    exception_info: { type: "ExecProtocolError", message: "setup failed" },
    verifier_result: { rewards: { reward: 0, intercepted: 0 } },
  });
  return root;
}

function completeArm() {
  const arm = readBenchmarkArm({ name: "candidate", path: fixture() });
  const failed = arm.trials[1];
  failed.error = undefined;
  failed.errorClass = undefined;
  failed.rewards = { reward: 0, intercepted: 0 };
  failed.scores = {
    accuracy: 0,
    false_positive_rate: 0,
    false_negative_rate: 1,
    infra_error_rate: 0,
    intercepted: 0,
    reward: 0,
    ungraded_rate: 0,
  };
  return arm;
}

describe("Harbor result ingestion", () => {
  test("keeps infrastructure errors out of task-quality scores", () => {
    const arm = readBenchmarkArm({ name: "candidate", path: fixture() });
    expect(arm.trials).toHaveLength(2);
    expect(arm.trials[0].scores).toEqual({
      accuracy: 1,
      false_positive_rate: 0,
      false_negative_rate: 0,
      infra_error_rate: 0,
      ungraded_rate: 0,
      reward: 1,
      reward_lenient: 1,
      reward_strict: 0,
      intercepted: 1,
      kernel_mcp_valid: 1,
    });
    expect(arm.trials[1].scores).toEqual({
      infra_error_rate: 1,
      ungraded_rate: 1,
    });
  });

  test("classifies ungraded step setup failures as infrastructure", () => {
    const root = fixture();
    const failedPath = join(root, "task-two__def", "result.json");
    const failed = JSON.parse(readFileSync(failedPath, "utf8")) as Record<
      string,
      unknown
    >;
    delete failed.exception_info;
    failed.verifier_result = null;
    failed.step_results = [
      {
        exception_info: {
          exception_type: "RuntimeError",
          exception_message: "Step setup exited with code 1",
        },
      },
    ];
    writeJson(failedPath, failed);

    const arm = readBenchmarkArm({ name: "candidate", path: root });
    expect(arm.trials[1].errorClass).toBe("infra");
    expect(arm.trials[1].error).toContain("Step setup exited with code 1");
  });

  test("summarizes against the intended task denominator", () => {
    const summary = summarizeArm(
      readBenchmarkArm({ name: "candidate", path: fixture() }),
    );
    expect(summary).toMatchObject({
      trials: 2,
      lenient: 1,
      strict: 0,
      intercepted: 1,
      infraErrors: 1,
      retries: 0,
      ungraded: 0,
      complete: false,
      incompleteReasons: ["scored 1/2 trials", "had 1 infrastructure failure"],
      kernelMcpValid: 1,
      medianCalls: 1,
      totalCostUsd: 0.01,
    });
  });

  test("requires every intended trial to be graded", () => {
    expect(summarizeArm(completeArm()).complete).toBe(true);

    const missing = completeArm();
    missing.nTotalTrials = 3;
    expect(summarizeArm(missing)).toMatchObject({
      complete: false,
      incompleteReasons: ["scored 2/3 trials"],
    });

    const empty = completeArm();
    empty.nTotalTrials = 0;
    empty.trials = [];
    expect(summarizeArm(empty)).toMatchObject({
      complete: false,
      incompleteReasons: ["had no intended trials"],
    });
  });

  test("builds deterministic root, llm, and tool spans", () => {
    const arm = readBenchmarkArm({ name: "candidate", path: fixture() });
    const first = buildExperimentEvents([arm], "test-experiment");
    const second = buildExperimentEvents([arm], "test-experiment");
    expect(first).toEqual(second);
    expect(
      first.filter((event) => event.span_attributes.type === "eval"),
    ).toHaveLength(2);
    expect(
      first.filter((event) => event.span_attributes.type === "llm"),
    ).toHaveLength(1);
    expect(
      first.filter((event) => event.span_attributes.type === "tool"),
    ).toHaveLength(1);
    expect(
      first.filter((event) => event.span_attributes.type === "task"),
    ).toHaveLength(7);
    const root = first.find((event) => event.span_attributes.type === "eval");
    expect(root?.input).toEqual({
      source: "clawbench-v2",
      taskName: "v2-task-one",
      instruction: "perform the task",
    });
    expect(root?.span_parents).toEqual([]);
    const infra = first.find(
      (event) =>
        event.span_attributes.type === "eval" &&
        (event.output as { error?: string }).error,
    );
    expect(infra?.scores).toEqual({ infra_error_rate: 1, ungraded_rate: 1 });
    expect(infra?.output).not.toHaveProperty("reward", 0);
    const success = first.find(
      (event) =>
        event.span_attributes.type === "eval" &&
        (event.output as { reward?: number }).reward === 1,
    );
    expect(success?.output).toMatchObject({
      reward: 1,
      rewardKey: "reward_lenient",
    });
    const llm = first.find((event) => event.span_attributes.type === "llm");
    expect(llm?.input).toEqual([
      {
        source: "system",
        message: "system prompt",
        toolCalls: [],
        observations: [],
      },
      {
        source: "user",
        message: "perform the task",
        toolCalls: [],
        observations: [],
      },
    ]);
    expect(llm?.output).toMatchObject({
      message: "",
      toolCalls: [
        {
          name: "execute_playwright_code",
          arguments: {
            session_id: "[REDACTED]",
            code: "await page.locator('#password').fill('[REDACTED]'); return 'done'",
          },
        },
      ],
    });
    const tool = first.find((event) => event.span_attributes.type === "tool");
    expect(tool?.metadata).toMatchObject({
      sessionIdMatchesExpected: true,
    });
    const browser = first.find(
      (event) => event.span_attributes.name === "browser_session",
    );
    expect(browser?.metadata).toMatchObject({
      timeoutSeconds: 1920,
      deletionVerified: true,
    });
    expect(llm?.metrics).toMatchObject({
      start: Date.parse("2026-01-01T00:00:20Z") / 1000,
      end: Date.parse("2026-01-01T00:00:21Z") / 1000,
      prompt_tokens: 100,
      prompt_cached_tokens: 80,
      completion_tokens: 20,
      tokens: 120,
      cost_usd: 0.01,
    });
    expect(root?.metrics).not.toHaveProperty("input_tokens");
    expect(root?.metrics).not.toHaveProperty("cost_usd");
  });

  test("re-publishes the same rows and spans by deterministic ID", async () => {
    const arm = completeArm();
    const originalFetch = globalThis.fetch;
    const inserts: string[][] = [];
    const metadataUpdates: unknown[] = [];
    globalThis.fetch = (async (request, init) => {
      const url = String(request);
      if (url.endsWith("/v1/project")) {
        return Response.json({
          id: "project-id",
          org_id: "org-id",
          name: "project name",
        });
      }
      if (url.endsWith("/v1/experiment")) {
        return Response.json({
          id: "experiment-id",
          project_id: "project-id",
          name: "experiment name",
        });
      }
      if (
        url.endsWith("/v1/experiment/experiment-id") &&
        init?.method === "PATCH"
      ) {
        metadataUpdates.push(JSON.parse(String(init.body)));
        return Response.json({ id: "experiment-id" });
      }
      if (url.includes("/insert")) {
        const body = JSON.parse(String(init?.body)) as {
          events: Array<{ id: string }>;
        };
        inserts.push(body.events.map((event) => event.id));
        return Response.json({ row_ids: body.events.map((event) => event.id) });
      }
      if (url.endsWith("/v1/organization/org-id")) {
        return Response.json({ name: "Kernel" });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    try {
      const first = await publishBenchmark(
        [arm],
        "project name",
        "experiment name",
        "test-key",
      );
      const second = await publishBenchmark(
        [arm],
        "project name",
        "experiment name",
        "test-key",
      );
      expect(first).toEqual(second);
      expect(inserts).toHaveLength(2);
      expect(inserts[0]).toEqual(inserts[1]);
      expect(metadataUpdates).toHaveLength(2);
      expect(metadataUpdates[0]).toEqual(metadataUpdates[1]);
      expect(first.url).toBe(
        "https://www.braintrust.dev/app/Kernel/p/project%20name/experiments/experiment%20name",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("does not publish incomplete arms", async () => {
    const arm = readBenchmarkArm({ name: "candidate", path: fixture() });
    for (const trial of arm.trials) trial.rewards = {};
    await expect(
      publishBenchmark([arm], "project", "experiment", "api-key"),
    ).rejects.toThrow("Cannot publish incomplete benchmark arms: candidate");
  });

  test("uses the lenient reward per trial and reports incomplete arms", () => {
    expect(selectPrimaryReward({ reward: 0, reward_lenient: 1 })).toEqual({
      key: "reward_lenient",
      value: 1,
    });
    const arm = completeArm();
    const summary = summarizeArm(arm);
    expect(summary.scored).toBe(2);
    expect(summary.lenient).toBe(1);
    expect(summary.configuration).toContain("codex");
    expect(
      renderMarkdown("test", [summary], undefined, { candidate: 124 }),
    ).toContain("Incomplete benchmark: candidate exited 124");
    expect(
      renderMarkdown("test", [
        { ...summary, arm: "candidate", lenient: 0.3 },
        { ...summary, arm: "baseline", lenient: 0.2 },
      ]),
    ).toContain("+0.1 lenient");
    const ungraded = renderMarkdown("test", [
      {
        ...summary,
        arm: "candidate",
        scored: 0,
        ungraded: summary.trials,
        complete: false,
        incompleteReasons: ["had 2 ungraded trials"],
      },
      {
        ...summary,
        arm: "baseline",
        scored: 0,
        ungraded: summary.trials,
        complete: false,
        incompleteReasons: ["had 2 ungraded trials"],
      },
    ]);
    expect(ungraded).toContain("candidate had 2 ungraded trials");
    expect(ungraded).not.toContain("Candidate minus baseline");

    const infra = renderMarkdown("test", [
      {
        ...summary,
        arm: "candidate",
        infraErrors: 1,
        complete: false,
        incompleteReasons: ["had 1 infrastructure failure"],
      },
      { ...summary, arm: "baseline" },
    ]);
    expect(infra).toContain("candidate had 1 infrastructure failure");
    expect(infra).not.toContain("Candidate minus baseline");
  });

  test("keeps full errors until redaction and clamps derived scores", () => {
    const root = fixture();
    const successPath = join(root, "task-one__abc", "result.json");
    const result = JSON.parse(readFileSync(successPath, "utf8")) as {
      verifier_result: { rewards: Record<string, number> };
      exception_info?: string;
    };
    result.verifier_result.rewards.reward_lenient = 2;
    writeJson(successPath, result);

    const failedPath = join(root, "task-two__def", "result.json");
    const failed = JSON.parse(readFileSync(failedPath, "utf8")) as {
      exception_info: unknown;
    };
    failed.exception_info = `${"x".repeat(395)}secret-value-after-boundary`;
    writeJson(failedPath, failed);

    const arm = readBenchmarkArm({ name: "candidate", path: root });
    expect(arm.trials[0].scores.accuracy).toBe(1);
    expect(arm.trials[1].error?.length).toBeGreaterThan(400);

    process.env.TEST_SECRET = "secret-value-after-boundary";
    const events = buildExperimentEvents([arm], "redaction-boundary");
    expect(JSON.stringify(events)).not.toContain("secret-value-after-boundary");
    expect(JSON.stringify(events)).not.toContain(`${"x".repeat(395)}secre`);
    delete process.env.TEST_SECRET;
  });

  test("assigns unique span IDs when ATIF step IDs are absent", () => {
    const root = fixture();
    writeJson(join(root, "task-one__abc", "steps/run/agent/trajectory.json"), {
      steps: [
        { source: "agent", message: "first" },
        { source: "agent", message: "second" },
      ],
    });
    const events = buildExperimentEvents(
      [readBenchmarkArm({ name: "candidate", path: root })],
      "missing-step-ids",
    ).filter((event) => event.span_attributes.type === "llm");
    expect(new Set(events.map((event) => event.id)).size).toBe(2);
  });
});

describe("Braintrust redaction", () => {
  test("redacts configured secrets and credential-shaped strings", () => {
    process.env.TEST_API_KEY = "super-secret-value";
    expect(
      redactString(
        'Bearer super-secret-value sk-proj-abcdefghijklmnop?access_token=visible&token=plain&jwt=opaque "password":"generated-password" "session_id":"session-123" Cookie: session=visible\nhttps://example.com/browser/live/replay-slug user@example.com await page.locator("#password").fill("typed-password")',
      ),
    ).toBe(
      'Bearer [REDACTED] [REDACTED]?access_token=[REDACTED]&token=[REDACTED]&jwt=[REDACTED] "password":"[REDACTED]" "session_id":"[REDACTED]" Cookie: [REDACTED]\nhttps://example.com/browser/live/[REDACTED] [REDACTED_EMAIL] await page.locator("#password").fill("[REDACTED]")',
    );
    const redacted = redactValue({
      api_key: "visible",
      Cookie: "session=visible",
      session_id: "session-123",
      max_output_tokens: 1000,
      nested: ["bt-abcdefghijklmnop"],
    });
    expect(redacted).toEqual({
      api_key: "[REDACTED]",
      Cookie: "[REDACTED]",
      session_id: "[REDACTED]",
      max_output_tokens: 1000,
      nested: ["[REDACTED]"],
    });
    expect(() => assertSafeToPublish(redacted)).not.toThrow();
    expect(() =>
      assertSafeToPublish({ code: "page.fill('still-visible')" }),
    ).toThrow("typed form value");
    expect(
      privateInfoRead("exec_command", {
        cmd: "cat /my-info/email_credentials.json",
      }),
    ).toBe(true);
    expect(
      privateInfoRead("exec_command", {
        cmd: "cat /my-info/kernel_browser.json",
      }),
    ).toBe(false);
    delete process.env.TEST_API_KEY;
  });
});

describe("benchmark workflow hardening", () => {
  test("uses merge-base comparisons, fixed configs, and arm statuses", () => {
    const workflow = readFileSync(
      join(process.cwd(), ".github/workflows/benchmark-clawbench.yml"),
      "utf8",
    );
    expect(workflow).toContain("github.rest.repos.compareCommits");
    expect(workflow).not.toContain("baseSha = pull.base.sha");
    expect(workflow).toContain('HARBOR_VERSION: "0.21.0"');
    expect(workflow).toContain('HARBOR_HYPEMAN_VERSION: "0.1.2"');
    expect(workflow).toContain('CODEX_BENCHMARK_VERSION: "0.120.0"');
    expect(
      workflow.match(/c7feaa2435ca8115c0762c44e13885fe5adf3e98/g),
    ).toHaveLength(2);
    expect(workflow).toContain("issues: write\n      pull-requests: write");
    expect(workflow).not.toContain(
      "KERNEL_PROJECT: ${{ vars.KERNEL_PROJECT }}",
    );
    expect(workflow).toContain("all(.arms[]; .complete == true)");
    expect(workflow).toMatch(
      /- name: Mark the PR benchmark as running\n\s+if:.*\n\s+continue-on-error: true/,
    );
    expect(workflow).toMatch(
      /- name: Update PR benchmark comment\n\s+if:.*\n\s+continue-on-error: true/,
    );
    expect(workflow).toContain(
      'statuses=(--status "candidate=${CANDIDATE_STATUS:-1}")',
    );
    expect(workflow).toContain('KERNEL_MCP_BENCHMARK_SOURCE_ROOT="$checkout"');
    expect(workflow).toContain(
      '"$GITHUB_WORKSPACE/harness/benchmarks/harbor/clawbench/run.sh"',
    );

    const runner = readFileSync(
      join(process.cwd(), "benchmarks/harbor/clawbench/run.sh"),
      "utf8",
    );
    expect(runner).toContain(
      "source_root=${KERNEL_MCP_BENCHMARK_SOURCE_ROOT:-$harness_root}",
    );
    expect(runner).toContain(
      "harbor_hypeman_version=${HARBOR_HYPEMAN_VERSION:-0.1.2}",
    );
    expect(runner).toContain('--max-retries "${HARBOR_MAX_RETRIES:-5}"');
    expect(runner).toContain('bun "$benchmark_dir/verify-purelymail.ts"');
    for (const exception of [
      "APITimeoutError",
      "APIConnectionError",
      "RateLimitError",
      "InternalServerError",
      "ConnectionRefusedError",
      "ExecProtocolError",
      "AgentSetupTimeoutError",
      "RuntimeError",
    ]) {
      expect(runner).toContain(`--retry-include ${exception}`);
    }
  });

  test("requires the benchmark credential to resolve to one project", () => {
    expect(() =>
      assertProjectScopedCredential({
        authorization: {
          credential_scope: { project_id: "project" },
          effective_scope: { project_id: "project" },
        },
      }),
    ).not.toThrow();
    expect(() =>
      assertProjectScopedCredential({
        authorization: {
          credential_scope: { project_id: null },
          effective_scope: { project_id: null },
        },
      }),
    ).toThrow();
    expect(() =>
      assertProjectScopedCredential({
        authorization: {
          credential_scope: { project_id: "credential-project" },
          effective_scope: { project_id: "other-project" },
        },
      }),
    ).toThrow();
  });

  test("excludes private keys and forwards only the selected provider", () => {
    const dockerignore = readFileSync(
      join(process.cwd(), ".dockerignore"),
      "utf8",
    );
    const runner = readFileSync(
      join(process.cwd(), "benchmarks/harbor/clawbench/run.sh"),
      "utf8",
    );
    const verifier = readFileSync(
      join(process.cwd(), "benchmarks/harbor/clawbench/verify-task.py"),
      "utf8",
    );
    const taskPreparer = readFileSync(
      join(process.cwd(), "benchmarks/harbor/clawbench/prepare-task.py"),
      "utf8",
    );
    expect(dockerignore.split("\n")).toContain("*.pem");
    expect(runner).not.toContain("KERNEL_PROJECT");
    expect(runner).toContain("c7feaa2435ca8115c0762c44e13885fe5adf3e98");
    expect(runner).toContain('"${KERNEL_API_BASE_URL%/}/auth/context"');
    expect(runner).toContain('bun "$benchmark_dir/verify-project-scope.ts"');
    expect(taskPreparer).not.toContain("KERNEL_PROJECT");
    expect(verifier).toContain('"mcp__kernel__execute_playwright_code"');
    expect(verifier).toContain('"kernel__execute_playwright_code"');
    expect(verifier).toContain('"execute_playwright_code"');
    const commonStart = runner.indexOf("printf 'KERNEL_API_KEY=%s\\n'");
    const providerCaseStart = runner.indexOf('case "$agent" in', commonStart);
    const providerCase = runner.slice(
      providerCaseStart,
      runner.indexOf('chmod 0600 "$runtime_env"'),
    );
    expect(providerCase).toContain("ANTHROPIC_API_KEY");
    expect(providerCase).toContain("OPENAI_API_KEY");
    const commonEnvironment = runner.slice(commonStart, providerCaseStart);
    expect(commonEnvironment).toContain("CLAWBENCH_JUDGE_API_KEY");
    expect(commonEnvironment).not.toContain("OPENAI_API_KEY");
    expect(commonEnvironment).not.toContain("ANTHROPIC_API_KEY");
    expect(runner).not.toContain("<<EOF");
  });
});
