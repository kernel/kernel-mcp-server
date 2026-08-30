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
import { redactString, redactValue } from "./redact";

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
    step_results: [
      {
        agent_result: {
          n_input_tokens: 100,
          n_cache_tokens: 80,
          n_output_tokens: 20,
          cost_usd: 0.01,
        },
      },
    ],
  });
  writeJson(join(success, "steps/run/agent/trajectory.json"), {
    steps: [
      {
        step_id: 1,
        source: "agent",
        timestamp: "2026-01-01T00:00:01Z",
        message: "working",
        tool_calls: [
          {
            tool_call_id: "call-1",
            function_name: "execute_playwright_code",
            arguments: { code: "return 'done'" },
          },
        ],
        observation: {
          results: [{ source_call_id: "call-1", content: "done" }],
        },
      },
    ],
  });
  writeJson(join(success, "steps/run/verifier/kernel-mcp/run-manifest.json"), {
    kernel_mcp_server_sha: "server-sha",
    clawbench_source_sha: "clawbench-sha",
  });

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
      ungraded: 0,
      kernelMcpValid: 1,
      medianCalls: 1,
      totalCostUsd: 0.01,
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
    const root = first.find((event) => event.span_attributes.type === "eval");
    expect(root?.input).toEqual({
      source: "clawbench-v2",
      taskName: "v2-task-one",
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
  });

  test("re-publishes the same rows and spans by deterministic ID", async () => {
    const arm = readBenchmarkArm({ name: "candidate", path: fixture() });
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

  test("uses the lenient reward per trial and reports incomplete arms", () => {
    expect(selectPrimaryReward({ reward: 0, reward_lenient: 1 })).toEqual({
      key: "reward_lenient",
      value: 1,
    });
    const arm = readBenchmarkArm({ name: "candidate", path: fixture() });
    const second = arm.trials[1];
    second.error = undefined;
    second.errorClass = undefined;
    second.rewards = { reward: 0 };
    second.scores = {
      accuracy: 0,
      false_positive_rate: 0,
      false_negative_rate: 1,
      infra_error_rate: 0,
      reward: 0,
      ungraded_rate: 0,
    };
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
        'Bearer super-secret-value sk-proj-abcdefghijklmnop?access_token=visible&token=plain&jwt=opaque "password":"generated-password" Cookie: session=visible\nhttps://example.com/browser/live/replay-slug user@example.com',
      ),
    ).toBe(
      'Bearer [REDACTED] [REDACTED]?access_token=[REDACTED]&token=[REDACTED]&jwt=[REDACTED] "password":"[REDACTED]" Cookie: [REDACTED]\nhttps://example.com/browser/live/[REDACTED] [REDACTED_EMAIL]',
    );
    expect(
      redactValue({
        api_key: "visible",
        Cookie: "session=visible",
        nested: ["bt-abcdefghijklmnop"],
      }),
    ).toEqual({
      api_key: "[REDACTED]",
      Cookie: "[REDACTED]",
      nested: ["[REDACTED]"],
    });
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
    expect(workflow).toContain('CODEX_BENCHMARK_VERSION: "0.120.0"');
    expect(workflow).toContain(
      'statuses=(--status "candidate=${CANDIDATE_STATUS:-1}")',
    );
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
    expect(dockerignore.split("\n")).toContain("*.pem");
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
