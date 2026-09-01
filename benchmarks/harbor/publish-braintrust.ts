#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  type BenchmarkArm,
  type BenchmarkTrial,
  parseArmSpec,
  readBenchmarkArm,
  selectPrimaryReward,
  summarizeArm,
} from "./results";
import { redactString, redactValue } from "./redact";

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
  span_attributes: { name: string; type: "eval" | "llm" | "tool" };
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
      input_tokens: trial.metrics.inputTokens,
      cached_tokens: trial.metrics.cacheTokens,
      output_tokens: trial.metrics.outputTokens,
      cost_usd: trial.metrics.costUsd,
      duration_ms: trial.metrics.durationMs,
      tool_calls: trial.metrics.toolCalls,
    }).filter((entry): entry is [string, number] => entry[1] !== undefined),
  );
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

function atifEvents(trial: BenchmarkTrial, rowId: string): BraintrustEvent[] {
  const events: BraintrustEvent[] = [];
  const agentSteps = trajectorySteps(trial).filter(
    (candidate) => candidate.source === "agent",
  );
  for (const [stepIndex, step] of agentSteps.entries()) {
    const stepId = step.step_id;
    const stepKey = `${stepId ?? "missing"}:${stepIndex}`;
    const llmId = uuidV5(`${rowId}:llm:${stepKey}`);
    const start = step.timestamp
      ? Date.parse(step.timestamp) / 1000
      : undefined;
    const llmMetrics = Object.fromEntries(
      Object.entries({
        start,
        end: start,
        prompt_tokens: number(step.metrics?.prompt_tokens),
        completion_tokens: number(step.metrics?.completion_tokens),
        cost_usd: number(step.metrics?.cost_usd),
      }).filter((entry): entry is [string, number] => entry[1] !== undefined),
    );
    events.push({
      id: llmId,
      span_id: llmId,
      root_span_id: rowId,
      span_parents: [rowId],
      span_attributes: { name: "agent", type: "llm" },
      created: step.timestamp,
      output: redactValue(step.message),
      metadata: {
        phase: "agent_execution",
        stepId,
        stepIndex,
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
      events.push({
        id: toolId,
        span_id: toolId,
        root_span_id: rowId,
        span_parents: [llmId],
        span_attributes: { name: call.function_name ?? "tool", type: "tool" },
        created: step.timestamp,
        input: redactValue(call.arguments),
        output: redactValue(observation?.content),
        metadata: {
          phase: "agent_execution",
          stepId,
          stepIndex,
          toolCallId: call.tool_call_id,
        },
        metrics: start === undefined ? undefined : { start: start, end: start },
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
        input: { source: trial.source, taskName: trial.taskName },
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
      events.push(...atifEvents(trial, rowId));
    }
  }
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
