#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  type BenchmarkArm,
  type BenchmarkPhase,
  type BenchmarkTrial,
  parseArmSpec,
  readBenchmarkArm,
  selectPrimaryReward,
  summarizeArm,
} from "./results";
import {
  assertSafeToPublish,
  collectSensitiveValues,
  privateInfoRead,
  redactString,
  redactValue,
  redactValueWithSecrets,
  REDACTED_PRIVATE_INFO,
} from "./redact";

interface CliOptions {
  arms: string[];
  experiment?: string;
  project?: string;
  output?: string;
}

interface AtifStep {
  step_id?: number;
  timestamp?: string;
  source?: string;
  model_name?: string;
  message?: unknown;
  tool_calls?: Array<{
    tool_call_id?: string;
    function_name?: string;
    arguments?: unknown;
  }>;
  observation?: {
    results?: Array<{ source_call_id?: string; content?: unknown }>;
  };
  metrics?: Record<string, unknown>;
}

interface BraintrustEvent {
  id: string;
  span_id: string;
  root_span_id: string;
  span_parents: string[];
  span_attributes: { name: string; type: "eval" | "llm" | "tool" | "task" };
  created?: string;
  input?: unknown;
  output?: unknown;
  expected?: unknown;
  error?: string;
  scores?: Record<string, number>;
  metadata?: Record<string, unknown>;
  metrics?: Record<string, number>;
  _is_merge: false;
}

interface BraintrustProject {
  id: string;
  org_id: string;
  name: string;
}

interface BraintrustExperiment {
  id: string;
  project_id: string;
  name: string;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { arms: [] };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value || !flag.startsWith("--"))
      throw new Error(`Missing value for ${flag}`);
    index += 1;
    switch (flag) {
      case "--arm":
        options.arms.push(value);
        break;
      case "--experiment":
        options.experiment = value;
        break;
      case "--project":
        options.project = value;
        break;
      case "--output":
        options.output = value;
        break;
      default:
        throw new Error(`Unknown argument ${flag}`);
    }
  }
  if (options.arms.length === 0)
    throw new Error("At least one --arm name=/job/path is required");
  return options;
}

function uuidV5(name: string): string {
  const namespace = Buffer.from("cf5141b9e00051a9b55482e0567b5c88", "hex");
  const digest = createHash("sha1")
    .update(namespace)
    .update(name)
    .digest()
    .subarray(0, 16);
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function trajectorySteps(trial: BenchmarkTrial): AtifStep[] {
  if (!trial.trajectoryPath) return [];
  const trajectory = JSON.parse(readFileSync(trial.trajectoryPath, "utf8")) as {
    steps?: AtifStep[];
  };
  return Array.isArray(trajectory.steps) ? trajectory.steps : [];
}

function metricRecord(trial: BenchmarkTrial): Record<string, number> {
  return Object.fromEntries(
    Object.entries({
      start: trial.metrics.start,
      end: trial.metrics.end,
      duration_ms: trial.metrics.durationMs,
      tool_calls: trial.metrics.toolCalls,
    }).filter((entry): entry is [string, number] => entry[1] !== undefined),
  );
}

function taskInstruction(trial: BenchmarkTrial): unknown {
  const userSteps = trajectorySteps(trial).filter(
    (step) => step.source === "user" && step.message !== undefined,
  );
  return redactValue(userSteps.at(-1)?.message);
}

function trialMetadata(trial: BenchmarkTrial): Record<string, unknown> {
  return {
    trialName: trial.trialName,
    arm: trial.arm,
    verdict:
      trial.errorClass === "infra"
        ? "error"
        : trial.scores.ungraded_rate === 1
          ? "ungraded"
          : trial.scores.accuracy === 1
            ? "correct"
            : "false_negative",
    agent: trial.agent,
    agentVersion: trial.agentVersion,
    agentConfigHash: trial.agentConfigHash,
    model: trial.model,
    kernelMcpSha: trial.kernelMcpSha,
    clawbenchSha: trial.clawbenchSha,
    errorClass: trial.errorClass,
    rewards: trial.rewards,
    durationMs: trial.metrics.durationMs,
  };
}

function timestampSeconds(value?: string): number | undefined {
  if (!value) return undefined;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis / 1000 : undefined;
}

function timestampIso(value?: number): string | undefined {
  return value === undefined ? undefined : new Date(value * 1000).toISOString();
}

function stepContext(
  step: AtifStep,
  sensitiveValues: string[],
): Record<string, unknown> {
  const calls = step.tool_calls ?? [];
  return {
    source: step.source,
    message: redactValueWithSecrets(step.message, sensitiveValues),
    toolCalls: calls.map((call) => ({
      name: call.function_name ?? "tool",
      arguments: redactValueWithSecrets(call.arguments, sensitiveValues),
    })),
    observations: (step.observation?.results ?? []).map((result) => {
      const call = calls.find(
        (candidate) => candidate.tool_call_id === result.source_call_id,
      );
      const toolName = call?.function_name ?? "tool";
      return {
        source_call_id: result.source_call_id,
        content:
          call && privateInfoRead(toolName, call.arguments)
            ? REDACTED_PRIVATE_INFO
            : redactValueWithSecrets(result.content, sensitiveValues),
      };
    }),
  };
}

function llmInput(
  steps: AtifStep[],
  stepIndex: number,
  sensitiveValues: string[],
): unknown {
  const prior = steps.slice(0, stepIndex);
  let previousAgent = -1;
  for (let index = prior.length - 1; index >= 0; index -= 1) {
    if (prior[index].source === "agent") {
      previousAgent = index;
      break;
    }
  }
  const context =
    previousAgent === -1
      ? prior
      : prior.slice(previousAgent, previousAgent + 1);
  return context.map((step) => stepContext(step, sensitiveValues));
}

function llmOutput(step: AtifStep, sensitiveValues: string[]): unknown {
  if ((step.tool_calls ?? []).length === 0) {
    return redactValueWithSecrets(step.message, sensitiveValues);
  }
  return {
    message: redactValueWithSecrets(step.message, sensitiveValues),
    toolCalls: (step.tool_calls ?? []).map((call) => ({
      name: call.function_name ?? "tool",
      arguments: redactValueWithSecrets(call.arguments, sensitiveValues),
    })),
  };
}

function privateInfoValues(steps: AtifStep[]): string[] {
  const values = new Set<string>();
  for (const step of steps) {
    for (const call of step.tool_calls ?? []) {
      const toolName = call.function_name ?? "tool";
      if (!privateInfoRead(toolName, call.arguments)) continue;
      const observation = step.observation?.results?.find(
        (result) => result.source_call_id === call.tool_call_id,
      );
      if (typeof observation?.content !== "string") continue;
      for (const match of observation.content.matchAll(
        /["']\s*:\s*["']([^"'\\]{4,})["']/g,
      )) {
        values.add(match[1]);
      }
    }
  }
  return [...values];
}

function phaseEvent(
  rowId: string,
  name: string,
  phase: BenchmarkPhase,
  metadata: Record<string, unknown> = {},
): BraintrustEvent | undefined {
  if (phase.start === undefined || phase.end === undefined) return undefined;
  const id = uuidV5(`${rowId}:phase:${name}`);
  return {
    id,
    span_id: id,
    root_span_id: rowId,
    span_parents: [rowId],
    span_attributes: { name, type: "task" },
    created: timestampIso(phase.start),
    metadata: { phase: name, ...metadata },
    metrics: {
      start: phase.start,
      end: phase.end,
      ...(phase.durationMs === undefined
        ? {}
        : { duration_ms: phase.durationMs }),
    },
    _is_merge: false,
  };
}

function phaseEvents(trial: BenchmarkTrial, rowId: string): BraintrustEvent[] {
  const events: BraintrustEvent[] = [];
  for (const [name, phase] of Object.entries({
    environment_setup: trial.phases.environmentSetup,
    agent_setup: trial.phases.agentSetup,
    agent_execution: trial.phases.agentExecution,
    verifier: trial.phases.verifier,
  })) {
    if (!phase) continue;
    const event = phaseEvent(rowId, name, phase);
    if (event) events.push(event);
  }

  const stepSetupStart = trial.phases.agentSetup?.end;
  const stepSetupEnd = trial.phases.agentExecution?.start;
  if (
    stepSetupStart !== undefined &&
    stepSetupEnd !== undefined &&
    stepSetupEnd > stepSetupStart
  ) {
    const event = phaseEvent(rowId, "step_setup", {
      start: stepSetupStart,
      end: stepSetupEnd,
      durationMs: (stepSetupEnd - stepSetupStart) * 1000,
    });
    if (event) events.push(event);
  }

  if (trial.browser?.start !== undefined && trial.browser.end !== undefined) {
    const event = phaseEvent(
      rowId,
      "browser_session",
      {
        start: trial.browser.start,
        end: trial.browser.end,
        durationMs: (trial.browser.end - trial.browser.start) * 1000,
      },
      {
        timeoutSeconds: trial.browser.timeoutSeconds,
        deletionVerified: trial.browser.deletionVerified,
      },
    );
    if (event) events.push(event);
  }

  const finalizeStart = trial.phases.verifier?.end;
  const finalizeEnd = trial.metrics.end;
  if (
    finalizeStart !== undefined &&
    finalizeEnd !== undefined &&
    finalizeEnd > finalizeStart
  ) {
    const event = phaseEvent(rowId, "finalize", {
      start: finalizeStart,
      end: finalizeEnd,
      durationMs: (finalizeEnd - finalizeStart) * 1000,
    });
    if (event) events.push(event);
  }
  return events;
}

function atifEvents(trial: BenchmarkTrial, rowId: string): BraintrustEvent[] {
  const events: BraintrustEvent[] = [];
  const steps = trajectorySteps(trial);
  const sensitiveValues = [
    ...collectSensitiveValues(steps),
    ...privateInfoValues(steps),
  ];
  const agentExecutionId = uuidV5(`${rowId}:phase:agent_execution`);
  let previousEnd = trial.phases.agentExecution?.start;

  for (const [trajectoryIndex, step] of steps.entries()) {
    if (step.source !== "agent") continue;
    const stepId = step.step_id;
    const stepKey = `${stepId ?? "missing"}:${trajectoryIndex}`;
    const llmId = uuidV5(`${rowId}:llm:${stepKey}`);
    const end = timestampSeconds(step.timestamp);
    const start =
      previousEnd === undefined || end === undefined
        ? end
        : Math.min(previousEnd, end);
    if (end !== undefined) previousEnd = end;
    const promptTokens = number(step.metrics?.prompt_tokens);
    const completionTokens = number(step.metrics?.completion_tokens);
    const llmMetrics = Object.fromEntries(
      Object.entries({
        start,
        end,
        prompt_tokens: promptTokens,
        prompt_cached_tokens: number(step.metrics?.cached_tokens),
        completion_tokens: completionTokens,
        tokens:
          promptTokens === undefined || completionTokens === undefined
            ? undefined
            : promptTokens + completionTokens,
        cost_usd: number(step.metrics?.cost_usd),
      }).filter((entry): entry is [string, number] => entry[1] !== undefined),
    );
    events.push({
      id: llmId,
      span_id: llmId,
      root_span_id: rowId,
      span_parents: [
        trial.phases.agentExecution?.start !== undefined &&
        trial.phases.agentExecution.end !== undefined
          ? agentExecutionId
          : rowId,
      ],
      span_attributes: { name: "agent", type: "llm" },
      created: timestampIso(start) ?? step.timestamp,
      input: llmInput(steps, trajectoryIndex, sensitiveValues),
      output: llmOutput(step, sensitiveValues),
      metadata: {
        phase: "agent_execution",
        timing: "ATIF turn completion interval",
        stepId,
        trajectoryIndex,
        model: step.model_name ?? trial.model,
      },
      metrics: llmMetrics,
      _is_merge: false,
    });

    for (const [toolIndex, call] of (step.tool_calls ?? []).entries()) {
      const toolId = uuidV5(
        `${rowId}:tool:${stepKey}:${call.tool_call_id ?? toolIndex}`,
      );
      const observation = step.observation?.results?.find(
        (result) => result.source_call_id === call.tool_call_id,
      );
      const toolName = call.function_name ?? "tool";
      const sessionId =
        call.arguments !== null && typeof call.arguments === "object"
          ? (call.arguments as Record<string, unknown>).session_id
          : undefined;
      const sessionIdMatchesExpected =
        typeof sessionId === "string" && trial.expectedBrowserSessionId
          ? sessionId === trial.expectedBrowserSessionId
          : undefined;
      events.push({
        id: toolId,
        span_id: toolId,
        root_span_id: rowId,
        span_parents: [llmId],
        span_attributes: { name: toolName, type: "tool" },
        created: step.timestamp,
        input: redactValueWithSecrets(call.arguments, sensitiveValues),
        output: privateInfoRead(toolName, call.arguments)
          ? REDACTED_PRIVATE_INFO
          : redactValueWithSecrets(observation?.content, sensitiveValues),
        metadata: {
          phase: "agent_execution",
          timing: "not available in ATIF",
          stepId,
          trajectoryIndex,
          toolCallId: call.tool_call_id,
          sessionIdMatchesExpected,
        },
        _is_merge: false,
      });
    }
  }
  return events;
}

export function buildExperimentEvents(
  arms: BenchmarkArm[],
  experimentName: string,
): BraintrustEvent[] {
  const events: BraintrustEvent[] = [];
  for (const arm of arms) {
    for (const trial of arm.trials) {
      const rowId = uuidV5(`${experimentName}:${arm.name}:${trial.id}`);
      const primaryReward =
        trial.errorClass === "infra"
          ? undefined
          : selectPrimaryReward(trial.rewards);
      events.push({
        id: rowId,
        span_id: rowId,
        root_span_id: rowId,
        span_parents: [],
        span_attributes: { name: trial.taskName, type: "eval" },
        created: trial.startedAt,
        input: {
          source: trial.source,
          taskName: trial.taskName,
          instruction: taskInstruction(trial),
        },
        output: {
          reward: primaryReward?.value,
          rewardKey: primaryReward?.key,
          error: trial.error ? redactString(trial.error, 400) : undefined,
        },
        expected: { reward: 1 },
        error: trial.error ? redactString(trial.error, 400) : undefined,
        scores: trial.scores,
        metadata: trialMetadata(trial),
        metrics: metricRecord(trial),
        _is_merge: false,
      });
      events.push(...phaseEvents(trial, rowId));
      events.push(...atifEvents(trial, rowId));
    }
  }
  assertSafeToPublish(events);
  return events;
}

function experimentMetadata(arms: BenchmarkArm[]): Record<string, unknown> {
  return {
    product: "kernel-mcp-server",
    execution_mode: "harbor",
    benchmark: "clawbench",
    harborVersion: "0.21.0",
    environment: "ci",
    gitSha: process.env.BENCHMARK_HEAD_SHA ?? process.env.GITHUB_SHA,
    githubRunId: process.env.GITHUB_RUN_ID,
    githubRunAttempt: process.env.GITHUB_RUN_ATTEMPT,
    githubEvent: process.env.GITHUB_EVENT_NAME,
    pullRequest: process.env.BENCHMARK_PR_NUMBER || undefined,
    concurrency: process.env.HARBOR_N_CONCURRENT,
    benchByArm: Object.fromEntries(
      arms.map((arm) => [arm.name, summarizeArm(arm)]),
    ),
    sources: Object.fromEntries(
      arms.map((arm) => [
        arm.name,
        {
          jobId: arm.jobId,
          jobName: arm.jobName,
          startedAt: arm.startedAt,
          finishedAt: arm.finishedAt,
          stats: {
            nTotalTrials: arm.nTotalTrials,
            nCompletedTrials: arm.nCompletedTrials,
            nErroredTrials: arm.nErroredTrials,
            nCancelledTrials: arm.nCancelledTrials,
            nRetries: arm.nRetries,
          },
          kernelMcpShas: [
            ...new Set(arm.trials.flatMap((trial) => trial.kernelMcpSha ?? [])),
          ],
          clawbenchShas: [
            ...new Set(arm.trials.flatMap((trial) => trial.clawbenchSha ?? [])),
          ],
        },
      ]),
    ),
  };
}

class BraintrustApi {
  private readonly baseUrl =
    process.env.BRAINTRUST_API_URL ?? "https://api.braintrust.dev";

  constructor(private readonly apiKey: string) {}

  async request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(
        `Braintrust ${method} ${path} returned ${response.status}: ${redactString(await response.text(), 400)}`,
      );
    }
    return (await response.json()) as T;
  }
}

async function insertEvents(
  api: BraintrustApi,
  experimentId: string,
  events: BraintrustEvent[],
): Promise<void> {
  const batchSize = 100;
  for (let offset = 0; offset < events.length; offset += batchSize) {
    await api.request(`/v1/experiment/${experimentId}/insert`, "POST", {
      events: events.slice(offset, offset + batchSize),
    });
  }
}

export async function publishBenchmark(
  arms: BenchmarkArm[],
  projectName: string,
  experimentName: string,
  apiKey: string,
): Promise<Record<string, unknown>> {
  const incomplete = arms
    .map(summarizeArm)
    .filter((summary) => !summary.complete);
  if (incomplete.length > 0) {
    throw new Error(
      `Cannot publish incomplete benchmark arms: ${incomplete
        .map(
          (summary) =>
            `${summary.arm} (${summary.incompleteReasons.join(", ")})`,
        )
        .join("; ")}`,
    );
  }

  const api = new BraintrustApi(apiKey);
  const project = await api.request<BraintrustProject>("/v1/project", "POST", {
    name: projectName,
  });
  const metadata = experimentMetadata(arms);
  const experiment = await api.request<BraintrustExperiment>(
    "/v1/experiment",
    "POST",
    {
      project_id: project.id,
      name: experimentName,
      public: false,
      metadata,
    },
  );
  await api.request(`/v1/experiment/${experiment.id}`, "PATCH", { metadata });
  const events = buildExperimentEvents(arms, experimentName);
  await insertEvents(api, experiment.id, events);
  const organization = await api.request<{ name: string }>(
    `/v1/organization/${project.org_id}`,
  );
  const url = `https://www.braintrust.dev/app/${encodeURIComponent(organization.name)}/p/${encodeURIComponent(project.name)}/experiments/${encodeURIComponent(experiment.name)}`;
  return {
    project: project.name,
    experiment: experiment.name,
    experimentId: experiment.id,
    url,
    rows: arms.reduce((total, arm) => total + arm.trials.length, 0),
    spans: events.length,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const project = options.project ?? process.env.BRAINTRUST_PROJECT;
  const experimentName = options.experiment;
  const apiKey = process.env.BRAINTRUST_API_KEY;
  if (!project) throw new Error("BRAINTRUST_PROJECT or --project is required");
  if (!experimentName) throw new Error("--experiment is required");
  if (!apiKey) throw new Error("BRAINTRUST_API_KEY is required");

  const arms = options.arms.map(parseArmSpec).map(readBenchmarkArm);
  const publication = await publishBenchmark(
    arms,
    project,
    experimentName,
    apiKey,
  );
  const serialized = `${JSON.stringify(publication, undefined, 2)}\n`;
  if (options.output) {
    mkdirSync(dirname(options.output), { recursive: true });
    writeFileSync(options.output, serialized);
  }
  process.stdout.write(serialized);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
