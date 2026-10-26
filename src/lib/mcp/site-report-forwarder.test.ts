import { describe, expect, test } from "bun:test";
import type { McpDependencies } from "@/lib/mcp/dependencies";
import type { KernelClient } from "@/lib/mcp/kernel-client";
import {
  forwardSiteReport,
  siteReportFromFeedback,
} from "@/lib/mcp/site-report-forwarder";
import type { KernelFeedback } from "@/lib/mcp/tools/feedback";

const siteFeedback: KernelFeedback = {
  summary: "checkout blocked by an access denied page",
  feedback_type: "site_compatibility",
  sentiment: "negative",
  task_outcome: "blocked",
  task_completed: false,
  friction_points: "- the page showed an access denied reference id",
  user_request: "add an item to the cart and open checkout",
  site_compatibility: {
    registrable_domain: "example.com",
    observed_outcome: "blocked",
    access_provider: "akamai",
    challenge_type: "access_denied",
    reproducibility: "consistent",
    browser_session_id: "sess_123",
  },
};

function fakeDependencies(calls: { path: string; body: unknown }[]) {
  const tokens: string[] = [];
  const dependencies: McpDependencies = {
    createKernelClient: (token) => {
      tokens.push(token);
      return {
        post: async (path: string, opts?: { body?: unknown }) => {
          calls.push({ path, body: opts?.body });
          return {};
        },
      } as unknown as KernelClient;
    },
  };
  return { dependencies, tokens };
}

describe("siteReportFromFeedback", () => {
  test("maps site-compatibility feedback with a session onto a site report", () => {
    expect(siteReportFromFeedback(siteFeedback)).toEqual({
      browserSessionId: "sess_123",
      request: {
        url: "https://example.com/",
        outcome: "blocked",
        challenge_type: "access_denied",
        access_provider: "akamai",
        reproducibility: "consistent",
        task: "add an item to the cart and open checkout",
        notes:
          "checkout blocked by an access denied page\n- the page showed an access denied reference id",
        config_source: "custom",
      },
    });
  });

  test("attributes config registry feedback to the analysis", () => {
    const report = siteReportFromFeedback({
      ...siteFeedback,
      feedback_type: "config_registry",
      site_compatibility: {
        ...siteFeedback.site_compatibility!,
        reproducibility: "unknown",
      },
      config_registry: {
        request_method: "resolve",
        analysis_id: "analysis_1",
        recommendation_evidence: { sample_size: 3, success_rate: 1 },
        applied_browser: {
          stealth: true,
          headless: false,
          gpu: false,
          viewport: { width: 1280, height: 720 },
        },
        applied_proxy: { mode: "direct" },
      },
    });
    expect(report?.request.config_source).toBe("config_registry");
    expect(report?.request.config_registry_analysis_id).toBe("analysis_1");
    expect(report?.request.reproducibility).toBeUndefined();
  });

  test("returns null without a session or site outcome", () => {
    expect(
      siteReportFromFeedback({
        ...siteFeedback,
        site_compatibility: {
          ...siteFeedback.site_compatibility!,
          browser_session_id: undefined,
        },
      }),
    ).toBeNull();
    expect(
      siteReportFromFeedback({
        summary: "manage_browsers worked well",
        feedback_type: "product",
        sentiment: "positive",
        product_area: "browsers",
      }),
    ).toBeNull();
  });
});

describe("forwardSiteReport", () => {
  test("posts the report with the caller's token", async () => {
    const calls: { path: string; body: unknown }[] = [];
    const { dependencies, tokens } = fakeDependencies(calls);

    await forwardSiteReport(
      siteFeedback,
      { http: { authInfo: { token: "kernel-token" } } },
      dependencies,
    );

    expect(tokens).toEqual(["kernel-token"]);
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe("/browsers/sess_123/site-reports");
    expect(calls[0].body).toMatchObject({
      url: "https://example.com/",
      outcome: "blocked",
    });
  });

  test("skips feedback without a token or a session", async () => {
    const calls: { path: string; body: unknown }[] = [];
    const { dependencies } = fakeDependencies(calls);

    await forwardSiteReport(siteFeedback, {}, dependencies);
    await forwardSiteReport(
      { ...siteFeedback, site_compatibility: undefined },
      { http: { authInfo: { token: "kernel-token" } } },
      dependencies,
    );

    expect(calls).toHaveLength(0);
  });

  test("swallows api failures", async () => {
    const dependencies: McpDependencies = {
      createKernelClient: () =>
        ({
          post: async () => {
            throw new Error("boom");
          },
        }) as unknown as KernelClient,
    };

    await expect(
      forwardSiteReport(
        siteFeedback,
        { http: { authInfo: { token: "kernel-token" } } },
        dependencies,
      ),
    ).resolves.toBeUndefined();
  });
});
