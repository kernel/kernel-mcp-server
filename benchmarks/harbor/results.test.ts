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
  collectSensitiveValues,
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
      estimated_cost: 0.01,
    });
    expect(root?.metrics).toMatchObject({
      prompt_tokens: 100,
      prompt_cached_tokens: 80,
      completion_tokens: 20,
      tokens: 120,
      estimated_cost: 0.01,
    });
    expect(root?.metrics).not.toHaveProperty("input_tokens");
    expect(root?.metrics).not.toHaveProperty("cost_usd");
  });

  test("retains row cost when ATIF has no per-turn cost", () => {
    const root = fixture();
    const trajectoryPath = join(
      root,
      "task-one__abc",
      "steps/run/agent/trajectory.json",
    );
    const trajectory = JSON.parse(readFileSync(trajectoryPath, "utf8")) as {
      steps: Array<{ metrics?: Record<string, number> }>;
    };
    delete trajectory.steps[2].metrics?.cost_usd;
    writeJson(trajectoryPath, trajectory);

    const events = buildExperimentEvents(
      [readBenchmarkArm({ name: "candidate", path: root })],
      "row-cost-fallback",
    );
    const row = events.find((event) => event.span_attributes.type === "eval");
    const llm = events.find((event) => event.span_attributes.type === "llm");
    expect(row?.metrics).toMatchObject({ estimated_cost: 0.01 });
    expect(llm?.metrics).not.toHaveProperty("estimated_cost");
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

  test("includes context added after the previous agent turn", () => {
    const root = fixture();
    writeJson(join(root, "task-one__abc", "steps/run/agent/trajectory.json"), {
      steps: [
        { source: "system", message: "system prompt" },
        { source: "user", message: "first request" },
        { source: "agent", message: "first response" },
        { source: "user", message: "follow-up" },
        { source: "system", message: "updated constraint" },
        { source: "agent", message: "second response" },
      ],
    });
    const llmEvents = buildExperimentEvents(
      [readBenchmarkArm({ name: "candidate", path: root })],
      "multi-turn-context",
    ).filter((event) => event.span_attributes.type === "llm");

    expect(llmEvents[1].input).toEqual([
      {
        source: "agent",
        message: "first response",
        toolCalls: [],
        observations: [],
      },
      {
        source: "user",
        message: "follow-up",
        toolCalls: [],
        observations: [],
      },
      {
        source: "system",
        message: "updated constraint",
        toolCalls: [],
        observations: [],
      },
    ]);
  });

  test("keeps login-page snapshots publishable", () => {
    const root = fixture();
    const trajectoryPath = join(
      root,
      "task-one__abc",
      "steps/run/agent/trajectory.json",
    );
    const trajectory = JSON.parse(readFileSync(trajectoryPath, "utf8")) as {
      steps: Array<{
        observation?: { results?: Array<{ content?: string }> };
      }>;
    };
    trajectory.steps[2].observation!.results![0].content = JSON.stringify({
      success: true,
      result: `- text: "Email:"
- textbox "Email:"
- text: "Password:"
- textbox "Password:" [disabled] [ref=e12]: Filled2Pass
Password: don't reuse one from another site`,
    });
    writeJson(trajectoryPath, trajectory);

    const events = buildExperimentEvents(
      [readBenchmarkArm({ name: "candidate", path: root })],
      "login-snapshot",
    );
    const published = JSON.stringify(events);
    expect(published).toContain("Password:");
    expect(published).toContain("[REDACTED] reuse one from another site");
    expect(published).not.toContain("Filled2Pass");
    expect(published).not.toContain("don't");
    expect(() => assertSafeToPublish(events)).not.toThrow();
  });

  test("harvests only sensitive values from private-info output", () => {
    const root = fixture();
    writeJson(join(root, "task-one__abc", "steps/run/agent/trajectory.json"), {
      steps: [
        { source: "user", message: "perform the task" },
        {
          source: "agent",
          message: "",
          tool_calls: [
            {
              tool_call_id: "private-read",
              function_name: "Read",
              arguments: { file_path: "/my-info/personal.json" },
            },
          ],
          observation: {
            results: [
              {
                source_call_id: "private-read",
                content:
                  '{"name":"Close Window","width":"1208","account_number":"12345678","government_ids":{"passport":{"number":"JK456789"},"drivers_license":{"number":"G4567-89018-05501"},"health_card":{"number":"6789-012-345"},"sin":"472-345-678"},"financial":{"bank_accounts":[{"transit_number":"10202"}],"credit_cards":[{"number":"4519873424604532"}]}}',
              },
            ],
          },
        },
        {
          source: "agent",
          message:
            "Close Window width 1208 account 12345678 passport JK456789 licence G4567-89018-05501 health 6789-012-345 sin 472-345-678 transit 10202 card 4519873424604532",
        },
      ],
    });
    const llmEvents = buildExperimentEvents(
      [readBenchmarkArm({ name: "candidate", path: root })],
      "private-info-values",
    ).filter((event) => event.span_attributes.type === "llm");

    expect(llmEvents[1].output).toBe(
      "Close Window width 1208 account [REDACTED] passport [REDACTED] licence [REDACTED] health [REDACTED] sin [REDACTED] transit [REDACTED] card [REDACTED]",
    );
  });
});

describe("Braintrust redaction", () => {
  test("redacts configured secrets and credential-shaped strings", () => {
    process.env.TEST_API_KEY = "super-secret-value";
    expect(
      redactString(
        'Bearer super-secret-value sk-proj-abcdefghijklmnop?access_token=visible&token=plain&jwt=opaque "password":"generated-password" "session_id":"session-123" Cookie: session=visible\nhttps://example.com/browser/live/replay-slug user@example.com await page.locator("#password").fill("typed-password"); await page.fill("#password", "two-arg-secret")',
      ),
    ).toBe(
      'Bearer [REDACTED] [REDACTED]?access_token=[REDACTED]&token=[REDACTED]&jwt=[REDACTED] "password":"[REDACTED]" "session_id":"[REDACTED]" Cookie: [REDACTED]\nhttps://example.com/browser/live/[REDACTED] [REDACTED_EMAIL] await page.locator("#password").fill("[REDACTED]"); await page.fill("#password", "[REDACTED]")',
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
    expect(() =>
      assertSafeToPublish({
        code: "page.fill('#password', 'still-visible')",
      }),
    ).toThrow("typed form value");
    expect(() =>
      assertSafeToPublish({
        nested: { code: "page.fill('#password', 'still-visible')" },
      }),
    ).toThrow("$.nested.code");
    expect(
      privateInfoRead("exec_command", {
        cmd: "cat /my-info/email_credentials.json",
      }),
    ).toBe(true);
    expect(
      privateInfoRead("Bash", {
        command: "cat ./my-info/alex_green_personal_info.json",
      }),
    ).toBe(true);
    expect(
      privateInfoRead("Read", {
        file_path: "/workspace/my-info/email_credentials.json",
      }),
    ).toBe(true);
    expect(
      privateInfoRead("exec_command", {
        cmd: "cat /my-info/kernel_browser.json",
      }),
    ).toBe(false);
    delete process.env.TEST_API_KEY;
  });

  test("redacts normalized cookie headers and compound secret keys", () => {
    const redacted = redactValue({
      "Set-Cookie": "session=visible",
      client_secret: "client-value",
      secret_key: "key-value",
      webhook_secret: "webhook-value",
      apiKey: "camel-api-value",
      sessionId: "camel-session-value",
      clientSecret: "camel-secret-value",
      accountNumber: "camel-account-value",
    });
    expect(redacted).toEqual({
      "Set-Cookie": "[REDACTED]",
      client_secret: "[REDACTED]",
      secret_key: "[REDACTED]",
      webhook_secret: "[REDACTED]",
      apiKey: "[REDACTED]",
      sessionId: "[REDACTED]",
      clientSecret: "[REDACTED]",
      accountNumber: "[REDACTED]",
    });
    expect(() => assertSafeToPublish(redacted)).not.toThrow();
    expect(() =>
      assertSafeToPublish({ "Set-Cookie": "session=visible" }),
    ).toThrow("Set-Cookie");
    expect(() =>
      assertSafeToPublish({ client_secret: "client-value" }),
    ).toThrow("client_secret");
    expect(() =>
      assertSafeToPublish({ clientSecret: "camel-secret-value" }),
    ).toThrow("clientSecret");

    const text = redactString(
      `'client_secret': 'client-value'&webhook_secret=webhook-value; 'address': '123 Main St'; "apiKey":"camel-api-value"; "sessionId":"camel-session-value"; "clientSecret":"camel-secret-value"`,
    );
    for (const secret of [
      "client-value",
      "webhook-value",
      "123 Main St",
      "camel-api-value",
      "camel-session-value",
      "camel-secret-value",
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  test("redacts nested and unterminated sensitive assignments", () => {
    const nested =
      '{"success": true, "result": "Account created.\\nTemporary password: Hunter2Pass"}';
    const unterminated =
      '{"text": "Step 1...' + "\\n".repeat(30) + "password: Unterminated2Pass";
    const escapedNested =
      '{"success":true,"result":"{\\"password\\":\\"Escaped2Pass\\"}"}';
    const escapedValue = String.raw`password: \"EscapedValue2Pass\"`;
    const escapedWrapped = String.raw`result: \"wrapper password: \\\"EscapedWrapped2Pass\\\"\"`;

    for (const [source, secret] of [
      [nested, "Hunter2Pass"],
      [unterminated, "Unterminated2Pass"],
      [escapedNested, "Escaped2Pass"],
      [escapedValue, "EscapedValue2Pass"],
      [escapedWrapped, "EscapedWrapped2Pass"],
    ]) {
      const redacted = redactString(source);
      expect(redacted).not.toContain(secret);
      expect(redacted).toContain("[REDACTED]");
      expect(collectSensitiveValues(source)).toContain(secret);
      expect(() => assertSafeToPublish(redacted)).not.toThrow();
      expect(() => assertSafeToPublish(source)).toThrow(
        "sensitive field value",
      );
    }
    expect(() =>
      assertSafeToPublish('password: [REDACTED]"StillVisible"'),
    ).toThrow("data after a redacted field value");

    const objectValue =
      'credentials: {"username":"alex","password":"Nested2Pass"}';
    const arrayValue = 'credentials: ["first", {"token":"NestedToken"}]';
    for (const source of ['password: ""', "token=", objectValue, arrayValue]) {
      const redacted = redactString(source);
      expect(redacted).toContain("[REDACTED]");
      expect(() => assertSafeToPublish(redacted)).not.toThrow();
      expect(() => assertSafeToPublish(source)).toThrow(
        "sensitive field value",
      );
    }
    expect(collectSensitiveValues(objectValue)).toContain("Nested2Pass");
    expect(collectSensitiveValues(arrayValue)).toContain("NestedToken");
  });

  test("keeps aria labels publishable and redacts prose values", () => {
    const ariaSnapshot = `- text: "Email:"
- textbox "Email:"
- text: "Password:"
- textbox "Password:" [disabled] [ref=e12]`;
    const escapedLabel = String.raw`- text: \"Password:\"`;
    for (const label of [ariaSnapshot, escapedLabel]) {
      expect(redactString(label)).toBe(label);
      expect(collectSensitiveValues(label)).toEqual([]);
      expect(() => assertSafeToPublish(label)).not.toThrow();
    }

    const prose = "Password: don't reuse one from another site";
    const redacted = redactString(prose);
    expect(redacted).toBe("Password: [REDACTED] reuse one from another site");
    expect(collectSensitiveValues(prose)).toContain("don't");
    expect(() => assertSafeToPublish(redacted)).not.toThrow();

    const filledSnapshot =
      '- textbox "Password:" [disabled] [ref=e12]: Filled2Pass';
    const redactedSnapshot = redactString(filledSnapshot);
    expect(redactedSnapshot).not.toContain("Filled2Pass");
    expect(collectSensitiveValues(filledSnapshot)).toContain("Filled2Pass");
    expect(() => assertSafeToPublish(redactedSnapshot)).not.toThrow();
    expect(() => assertSafeToPublish(filledSnapshot)).toThrow(
      "sensitive field value",
    );
  });

  test("redacts complex Playwright typing calls and rejects originals", () => {
    const calls = [
      `page.fill('#password', 'Str0ng)Pass!')`,
      `page.type('#password', 'type)value')`,
      `page.locator('#pw').fill('abc)def')`,
      `page.locator('#pw').fill('forced)value', { force: true })`,
      `page.locator('#pw').pressSequentially(\`multi\nline)pass\`)`,
      `page.keyboard.insertText("typed)secret")`,
      `page.fill(buildSelector('nested)selector'), 'last)value')`,
      `// Fill in the user's password\nawait page.locator('#password').fill('Comment2Pass')`,
      `/* we'll sign up now */\nawait page.fill('#password', 'Block2Pass')`,
      `node -e 'await page.fill("#pw", "Shell2Pass")'`,
    ];
    const source = calls.join(";\n");
    const redacted = redactString(source);

    for (const secret of [
      "Str0ng)Pass!",
      "type)value",
      "abc)def",
      "forced)value",
      "multi\nline)pass",
      "typed)secret",
      "last)value",
      "Comment2Pass",
      "Block2Pass",
      "Shell2Pass",
    ]) {
      expect(redacted).not.toContain(secret);
      expect(collectSensitiveValues({ code: source })).toContain(secret);
    }
    expect(redacted).toContain("buildSelector('nested)selector')");
    expect(redacted.match(/\[REDACTED\]/g)).toHaveLength(calls.length);
    expect(() => assertSafeToPublish({ code: redacted })).not.toThrow();
    for (const call of calls) {
      expect(() => assertSafeToPublish({ code: call })).toThrow(
        "typed form value",
      );
    }
  });
});

describe("benchmark workflow hardening", () => {
  test("uses merge-base comparisons, fixed configs, and arm statuses", () => {
    const workflow = readFileSync(
      join(process.cwd(), ".github/workflows/benchmark-clawbench.yml"),
      "utf8",
    );
    const runner = readFileSync(
      join(process.cwd(), "benchmarks/harbor/clawbench/run.sh"),
      "utf8",
    );
    const readme = readFileSync(
      join(process.cwd(), "benchmarks/harbor/README.md"),
      "utf8",
    );
    const refMatch = runner.match(
      /clawbench_ref=\$\{CLAWBENCH_REF:-([0-9a-f]{40})\}/,
    );
    if (!refMatch) throw new Error("runner is missing the ClawBench pin");
    const clawbenchRef = refMatch[1];

    expect(workflow).toContain("github.rest.repos.compareCommits");
    expect(workflow).not.toContain("baseSha = pull.base.sha");
    expect(workflow).toContain('HARBOR_VERSION: "0.21.0"');
    expect(workflow).toContain('HARBOR_HYPEMAN_VERSION: "0.1.2"');
    expect(workflow).toContain('CODEX_BENCHMARK_VERSION: "0.120.0"');
    expect(workflow.match(new RegExp(clawbenchRef, "g"))).toHaveLength(1);
    expect(workflow).toContain(`CLAWBENCH_REF: ${clawbenchRef}`);
    expect(workflow).toContain("ref: ${{ env.CLAWBENCH_REF }}");
    expect(readme).toContain("https://github.com/kernel/ClawBench");
    expect(readme).toContain(clawbenchRef);
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
