import { describe, expect, test } from "bun:test";
import { connectTestMcp, toolResultJSON } from "@/lib/mcp/mcp-test-fixtures";
import {
  KERNEL_FEEDBACK_TOOL_NAME,
  type KernelFeedback,
  registerFeedbackTool,
} from "@/lib/mcp/tools/feedback";

describe("submit_feedback", () => {
  test("advertises the feedback schema and records a submission", async () => {
    const captured: KernelFeedback[] = [];
    const { client, close } = await connectTestMcp(
      (server) =>
        registerFeedbackTool(server, (feedback) => {
          captured.push(feedback);
        }),
      {},
    );

    try {
      const tools = await client.listTools();
      const tool = tools.tools.find(
        ({ name }) => name === KERNEL_FEEDBACK_TOOL_NAME,
      );
      expect(tool?.title).toBe("submit KERNEL feedback");
      expect(tool?.annotations?.readOnlyHint).toBe(false);
      expect(tool?.inputSchema.required).toEqual([
        "context",
        "summary",
        "feedback_type",
        "sentiment",
      ]);

      const result = await client.callTool({
        name: KERNEL_FEEDBACK_TOOL_NAME,
        arguments: {
          context:
            "Reporting that browser creation timeout responses did not explain when callers should retry.",
          summary: "Browser creation needs clearer timeout guidance",
          feedback_type: "product",
          sentiment: "mixed",
          product_area: "browsers",
          friction_points: "- The timeout response did not suggest a retry.",
          suggested_improvement:
            "Include retry timing in browser creation timeout responses.",
          task_completed: true,
          tools_used: ["manage_browsers"],
        },
      });

      expect(toolResultJSON(result)).toMatchObject({
        recorded: true,
        status: "recorded",
        summary: "Browser creation needs clearer timeout guidance",
        feedback_type: "product",
        sentiment: "mixed",
      });
      expect(captured).toEqual([
        {
          summary: "Browser creation needs clearer timeout guidance",
          feedback_type: "product",
          sentiment: "mixed",
          product_area: "browsers",
          friction_points: "- The timeout response did not suggest a retry.",
          suggested_improvement:
            "Include retry timing in browser creation timeout responses.",
          task_completed: true,
          tools_used: ["manage_browsers"],
        },
      ]);
    } finally {
      await close();
    }
  });

  test("records structured bot-detection outcomes for config registry prioritization", async () => {
    const captured: KernelFeedback[] = [];
    const { client, close } = await connectTestMcp(
      (server) =>
        registerFeedbackTool(server, (feedback) => {
          captured.push(feedback);
        }),
      {},
    );

    try {
      const tools = await client.listTools();
      const tool = tools.tools.find(
        ({ name }) => name === KERNEL_FEEDBACK_TOOL_NAME,
      );
      expect(JSON.stringify(tool?.inputSchema)).toContain('"bot_detection"');
      expect(JSON.stringify(tool?.inputSchema)).toContain(
        '"registrable_domain"',
      );
      expect(JSON.stringify(tool?.inputSchema)).toContain('"datacenter"');
      expect(JSON.stringify(tool?.inputSchema)).toContain('"config_registry"');

      const result = await client.callTool({
        name: KERNEL_FEEDBACK_TOOL_NAME,
        arguments: {
          context:
            "Reporting a repeatable site block so the affected domain can be prioritized for a working browser configuration.",
          summary: "Stealth sessions were consistently blocked",
          feedback_type: "bot_detection",
          sentiment: "negative",
          task_completed: false,
          tools_used: ["manage_browsers", "execute_playwright_code"],
          bot_detection: {
            registrable_domain: "Example.COM",
            observed_outcome: "blocked",
            suspected_vendor: "Akamai Bot Manager",
            challenge_type: "access_denied",
            stealth: "enabled",
            proxy_type: "isp",
            region: "us-east",
            browser_version: "152.0.7977.42",
            browser_image_version: "2026.09.14",
            reproducibility: "consistent",
            browser_session_id: "session_123",
          },
        },
      });

      expect(toolResultJSON(result)).toMatchObject({
        recorded: true,
        feedback_type: "bot_detection",
        sentiment: "negative",
      });
      expect(captured).toEqual([
        {
          summary: "Stealth sessions were consistently blocked",
          feedback_type: "bot_detection",
          sentiment: "negative",
          task_completed: false,
          tools_used: ["manage_browsers", "execute_playwright_code"],
          bot_detection: {
            registrable_domain: "example.com",
            observed_outcome: "blocked",
            suspected_vendor: "Akamai Bot Manager",
            challenge_type: "access_denied",
            stealth: "enabled",
            proxy_type: "isp",
            region: "us-east",
            browser_version: "152.0.7977.42",
            browser_image_version: "2026.09.14",
            reproducibility: "consistent",
            browser_session_id: "session_123",
          },
        },
      ]);
    } finally {
      await close();
    }
  });

  test("records config-registry outcomes against the applied configuration", async () => {
    const captured: KernelFeedback[] = [];
    const { client, close } = await connectTestMcp(
      (server) =>
        registerFeedbackTool(server, (feedback) => {
          captured.push(feedback);
        }),
      {},
    );

    try {
      const result = await client.callTool({
        name: KERNEL_FEEDBACK_TOOL_NAME,
        arguments: {
          context:
            "Reporting that an applied config registry recommendation still failed so its quality can be measured.",
          summary: "The recommended configuration remained blocked",
          feedback_type: "config_registry",
          sentiment: "negative",
          task_completed: false,
          bot_detection: {
            registrable_domain: "example.com",
            observed_outcome: "blocked",
            challenge_type: "access_denied",
            reproducibility: "consistent",
            browser_session_id: "session_456",
          },
          config_registry: {
            request_method: "resolve",
            analysis_id: "analysis_123",
            recommendation_match_scope: "exact",
            recommendation_verification: "verified",
            applied_browser: {
              stealth: true,
              headless: false,
              gpu: false,
              viewport: {
                width: 1920,
                height: 1080,
                refresh_rate: 25,
              },
            },
            applied_proxy: {
              mode: "managed",
              type: "residential",
              country: "us",
            },
          },
        },
      });

      expect(toolResultJSON(result)).toMatchObject({
        recorded: true,
        feedback_type: "config_registry",
        sentiment: "negative",
      });
      expect(captured).toEqual([
        {
          summary: "The recommended configuration remained blocked",
          feedback_type: "config_registry",
          sentiment: "negative",
          task_completed: false,
          bot_detection: {
            registrable_domain: "example.com",
            observed_outcome: "blocked",
            challenge_type: "access_denied",
            reproducibility: "consistent",
            browser_session_id: "session_456",
          },
          config_registry: {
            request_method: "resolve",
            analysis_id: "analysis_123",
            recommendation_match_scope: "exact",
            recommendation_verification: "verified",
            applied_browser: {
              stealth: true,
              headless: false,
              gpu: false,
              viewport: {
                width: 1920,
                height: 1080,
                refresh_rate: 25,
              },
            },
            applied_proxy: {
              mode: "managed",
              type: "residential",
              country: "US",
            },
          },
        },
      ]);
    } finally {
      await close();
    }
  });

  test("requires structured fields for site and config-registry feedback", async () => {
    const captured: KernelFeedback[] = [];
    const { client, close } = await connectTestMcp(
      (server) =>
        registerFeedbackTool(server, (feedback) => {
          captured.push(feedback);
        }),
      {},
    );

    try {
      const missingReport = await client.callTool({
        name: KERNEL_FEEDBACK_TOOL_NAME,
        arguments: {
          context:
            "Reporting a site-specific browser block without the structured observation required for config registry prioritization.",
          summary: "A site blocked the browser",
          feedback_type: "bot_detection",
          sentiment: "negative",
        },
      });
      expect(missingReport.isError).toBe(true);
      expect(captured).toEqual([]);

      const missingConfig = await client.callTool({
        name: KERNEL_FEEDBACK_TOOL_NAME,
        arguments: {
          context:
            "Reporting a failed recommendation without the applied settings needed to attribute its outcome.",
          summary: "The recommended configuration remained blocked",
          feedback_type: "config_registry",
          sentiment: "negative",
          task_completed: false,
          bot_detection: {
            registrable_domain: "example.com",
            observed_outcome: "blocked",
            reproducibility: "single_observation",
          },
        },
      });
      expect(missingConfig.isError).toBe(true);
      expect(captured).toEqual([]);

      const reportOnProductFeedback = await client.callTool({
        name: KERNEL_FEEDBACK_TOOL_NAME,
        arguments: {
          context:
            "Reporting general browser feedback without routing it into the site-specific bot-detection prioritization queue.",
          summary: "Browser startup was clear",
          feedback_type: "product",
          sentiment: "positive",
          bot_detection: {
            registrable_domain: "example.com",
            observed_outcome: "passed",
            reproducibility: "single_observation",
          },
        },
      });
      expect(reportOnProductFeedback.isError).toBe(true);
      expect(captured).toEqual([]);
    } finally {
      await close();
    }
  });

  test("rejects URLs, subdomains, and private hosts in domain reports", async () => {
    const captured: KernelFeedback[] = [];
    const { client, close } = await connectTestMcp(
      (server) =>
        registerFeedbackTool(server, (feedback) => {
          captured.push(feedback);
        }),
      {},
    );

    try {
      for (const registrableDomain of [
        "https://example.com/account?user=1",
        "auth.example.com",
        "service.local",
      ]) {
        const result = await client.callTool({
          name: KERNEL_FEEDBACK_TOOL_NAME,
          arguments: {
            context:
              "Reporting a site outcome while ensuring sensitive host details cannot enter the prioritization event.",
            summary: "A site blocked the browser",
            feedback_type: "bot_detection",
            sentiment: "negative",
            task_completed: false,
            bot_detection: {
              registrable_domain: registrableDomain,
              observed_outcome: "blocked",
              reproducibility: "single_observation",
            },
          },
        });

        expect(result.isError).toBe(true);
      }
      expect(captured).toEqual([]);
    } finally {
      await close();
    }
  });

  test("keeps analytics failures from failing the tool call", async () => {
    const { client, close } = await connectTestMcp(
      (server) =>
        registerFeedbackTool(server, () => {
          throw new Error("analytics unavailable");
        }),
      {},
    );

    try {
      const result = await client.callTool({
        name: KERNEL_FEEDBACK_TOOL_NAME,
        arguments: {
          context:
            "Reporting that the MCP response directly supported the user's task without additional parsing.",
          summary: "The MCP response was easy to use",
          feedback_type: "mcp",
          sentiment: "positive",
        },
      });

      expect(toolResultJSON(result)).toMatchObject({
        recorded: false,
        status: "failed",
        summary: "The MCP response was easy to use",
        message: expect.stringContaining("was not recorded"),
      });
    } finally {
      await close();
    }
  });

  test("reports when feedback analytics are unavailable", async () => {
    const { client, close } = await connectTestMcp(
      (server) => registerFeedbackTool(server),
      {},
    );

    try {
      const result = await client.callTool({
        name: KERNEL_FEEDBACK_TOOL_NAME,
        arguments: {
          context:
            "Reporting product feedback while analytics delivery is unavailable for this server instance.",
          summary: "Browser feedback could not be delivered",
          feedback_type: "product",
          sentiment: "negative",
        },
      });

      expect(toolResultJSON(result)).toMatchObject({
        recorded: false,
        status: "unavailable",
        summary: "Browser feedback could not be delivered",
        message: expect.stringContaining("was not recorded"),
      });
    } finally {
      await close();
    }
  });
});
