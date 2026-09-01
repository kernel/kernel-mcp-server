#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  type ArmSummary,
  parseArmSpec,
  readBenchmarkArm,
  summarizeArm,
} from "./results";

interface Options {
  arms: string[];
  statuses: Record<string, number>;
  json?: string;
  markdown?: string;
  publication?: string;
  title: string;
}

function parseArgs(args: string[]): Options {
  const options: Options = {
    arms: [],
    statuses: {},
    title: "ClawBench benchmark",
  };
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
      case "--status": {
        const separator = value.indexOf("=");
        const status = Number(value.slice(separator + 1));
        if (
          separator <= 0 ||
          separator === value.length - 1 ||
          !Number.isInteger(status)
        ) {
          throw new Error(
            `Invalid --status ${JSON.stringify(value)}; expected name=exit-code`,
          );
        }
        options.statuses[value.slice(0, separator)] = status;
        break;
      }
      case "--json":
        options.json = value;
        break;
      case "--markdown":
        options.markdown = value;
        break;
      case "--publication":
        options.publication = value;
        break;
      case "--title":
        options.title = value;
        break;
      default:
        throw new Error(`Unknown argument ${flag}`);
    }
  }
  if (options.arms.length === 0)
    throw new Error("At least one --arm name=/job/path is required");
  return options;
}

function ratio(value: number | undefined, denominator: number): string {
  return value === undefined ? "—" : `${value}/${denominator}`;
}

function duration(value: number | undefined): string {
  return value === undefined ? "—" : `${Math.round(value / 1000)}s`;
}

function cost(value: number | undefined): string {
  return value === undefined ? "—" : `$${value.toFixed(4)}`;
}

export function renderMarkdown(
  title: string,
  summaries: ArmSummary[],
  publication?: Record<string, unknown>,
  statuses: Record<string, number> = {},
): string {
  const lines = ["<!-- kernel-mcp-clawbench -->", `## ${title}`];
  const failed = Object.entries(statuses).filter(([, status]) => status !== 0);
  const infra = summaries.filter((summary) => summary.infraErrors > 0);
  const ungraded = summaries.filter((summary) => summary.ungraded > 0);
  const incomplete =
    failed.length > 0 || infra.length > 0 || ungraded.length > 0;
  if (incomplete) {
    const reasons = [
      ...failed.map(([arm, status]) => `${arm} exited ${status}`),
      ...infra.map(
        (summary) =>
          `${summary.arm} had ${summary.infraErrors} infrastructure ${summary.infraErrors === 1 ? "failure" : "failures"}`,
      ),
      ...ungraded.map(
        (summary) =>
          `${summary.arm} had ${summary.ungraded} ungraded ${summary.ungraded === 1 ? "trial" : "trials"}`,
      ),
    ];
    lines.push(
      "",
      `> [!WARNING]\n> Incomplete benchmark: ${reasons.join(", ")}. Scores below include only completed Harbor results; comparison deltas are suppressed.`,
    );
  }
  lines.push(
    "",
    "| Arm | Configuration | Lenient | Strict | Intercepted | Infra | Retries | Ungraded | Kernel MCP valid | Median calls | Median duration | Cost |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  );
  for (const summary of summaries) {
    lines.push(
      `| ${summary.arm} | ${summary.configuration ?? "—"} | ${ratio(summary.lenient, summary.trials)} | ${ratio(summary.strict, summary.trials)} | ${ratio(summary.intercepted, summary.trials)} | ${summary.infraErrors} | ${summary.retries} | ${summary.ungraded} | ${ratio(summary.kernelMcpValid, summary.kernelMcpChecked)} | ${summary.medianCalls ?? "—"} | ${duration(summary.medianDurationMs)} | ${cost(summary.totalCostUsd)} |`,
    );
  }

  const candidate = summaries.find((summary) => summary.arm === "candidate");
  const baseline = summaries.find((summary) => summary.arm === "baseline");
  if (candidate && baseline && !incomplete) {
    const signed = (value: number) => {
      const rounded = Number(value.toFixed(3));
      return `${rounded >= 0 ? "+" : ""}${rounded}`;
    };
    const deltas = [
      `**${signed(candidate.lenient - baseline.lenient)} lenient**`,
      candidate.strict !== undefined && baseline.strict !== undefined
        ? `**${signed(candidate.strict - baseline.strict)} strict**`
        : undefined,
      `**${signed(candidate.intercepted - baseline.intercepted)} intercepted**`,
    ].filter(Boolean);
    lines.push("", `Candidate minus baseline: ${deltas.join(", ")}.`);
  }
  if (typeof publication?.url === "string") {
    lines.push("", `[Open the Braintrust experiment](${publication.url})`);
  }
  if (
    process.env.GITHUB_SERVER_URL &&
    process.env.GITHUB_REPOSITORY &&
    process.env.GITHUB_RUN_ID
  ) {
    lines.push(
      "",
      `[Open the GitHub Actions run](${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID})`,
    );
  }
  lines.push(
    "",
    "Lenient reward is the primary ClawBench score. Infrastructure failures remain in the intended-task denominator.",
    "",
  );
  return lines.join("\n");
}

function write(path: string | undefined, content: string): void {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const arms = options.arms.map(parseArmSpec).map(readBenchmarkArm);
  const summaries = arms.map(summarizeArm);
  const publication = options.publication
    ? (JSON.parse(readFileSync(options.publication, "utf8")) as Record<
        string,
        unknown
      >)
    : undefined;
  const result = {
    benchmark: "clawbench",
    generatedAt: new Date().toISOString(),
    arms: summaries,
    statuses: options.statuses,
    publication,
  };
  const rendered = renderMarkdown(
    options.title,
    summaries,
    publication,
    options.statuses,
  );
  write(options.json, `${JSON.stringify(result, undefined, 2)}\n`);
  write(options.markdown, rendered);
  process.stdout.write(rendered);
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
