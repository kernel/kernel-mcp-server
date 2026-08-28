import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildExperimentEvents, publishBenchmark } from "./publish-braintrust";
import { readBenchmarkArm, summarizeArm } from "./results";
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
      ungraded: 1,
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
  });

  test("re-publishes the same rows and spans by deterministic ID", async () => {
    const arm = readBenchmarkArm({ name: "candidate", path: fixture() });
    const originalFetch = globalThis.fetch;
    const inserts: string[][] = [];
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
      expect(first.url).toBe(
        "https://www.braintrust.dev/app/Kernel/p/project%20name/experiments/experiment%20name",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("Braintrust redaction", () => {
  test("redacts configured secrets and credential-shaped strings", () => {
    process.env.TEST_API_KEY = "super-secret-value";
    expect(
      redactString(
        'Bearer super-secret-value sk-proj-abcdefghijklmnop?access_token=visible "password":"generated-password" user@example.com',
      ),
    ).toBe(
      'Bearer [REDACTED] [REDACTED]?access_token=[REDACTED] "password":"[REDACTED]" [REDACTED_EMAIL]',
    );
    expect(
      redactValue({ api_key: "visible", nested: ["bt-abcdefghijklmnop"] }),
    ).toEqual({
      api_key: "[REDACTED]",
      nested: ["[REDACTED]"],
    });
    delete process.env.TEST_API_KEY;
  });
});
