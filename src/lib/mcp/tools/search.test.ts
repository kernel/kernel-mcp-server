import { describe, expect, test } from "bun:test";
import { Kernel } from "@onkernel/sdk";
import { connectTestMcp, toolResultJSON } from "@/lib/mcp/mcp-test-fixtures";
import { registerSearchTools } from "@/lib/mcp/tools/search";

async function fixture(status = 200) {
  const requests: Request[] = [];
  const response = {
    id: "search_test",
    results: [],
    warnings: ["approximation"],
    attempts: [],
    usage: { units: 1 },
  };
  const kernel = new Kernel({
    apiKey: "sk_test",
    baseURL: "https://api.example.test",
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json(response, { status });
    },
  });
  const projects: (string | undefined)[] = [];
  const mcp = await connectTestMcp((server, dependencies) => {
    registerSearchTools(server, {
      createKernelClient: (token, project) => {
        projects.push(project);
        return dependencies!.createKernelClient(token, project);
      },
    });
  }, kernel);
  return { ...mcp, requests, response, projects };
}

describe("manage_search", () => {
  test("forwards search options and preserves the API response without retrying", async () => {
    const f = await fixture();
    const request = {
      query: "test",
      strategy: {
        type: "pinned",
        provider: { provider: "brave", options: { spellcheck: false } },
      },
      max_results: 3,
      include_raw: false,
      content: true,
      timeout_ms: 1000,
    };
    try {
      const result = await f.client.callTool({
        name: "manage_search",
        arguments: { action: "create", request },
      });
      expect(result.isError).not.toBe(true);
      expect(toolResultJSON(result)).toEqual(f.response);
      expect(f.requests).toHaveLength(1);
      expect(f.requests[0].method).toBe("POST");
      expect(new URL(f.requests[0].url).pathname).toBe("/search");
      expect(await f.requests[0].json()).toEqual(request);
      expect(f.tokens).toEqual(["test-token"]);
      expect(f.projects).toEqual(["proj_test"]);
    } finally {
      await f.close();
    }
  });

  test.each([
    {
      args: { action: "get", search_id: "id/with?reserved" },
      path: "/search/id%2Fwith%3Freserved",
    },
    {
      args: { action: "providers", slug: "brave" },
      path: "/search/providers?slug=brave",
    },
  ])("routes read operations", async ({ args, path }) => {
    const f = await fixture();
    try {
      const result = await f.client.callTool({
        name: "manage_search",
        arguments: args,
      });
      expect(result.isError).not.toBe(true);
      expect(f.requests[0].method).toBe("GET");
      expect(f.requests[0].url).toBe(`https://api.example.test${path}`);
    } finally {
      await f.close();
    }
  });

  test.each([
    { action: "create" },
    { action: "get" },
    { action: "providers", project: "proj_other" },
    { action: "create", request: { query: "" } },
    { action: "create", request: { query: "test", max_results: 101 } },
    {
      action: "create",
      request: { query: "test", strategy: { type: "pinned" } },
    },
  ])("rejects invalid requests before calling the API", async (args) => {
    const f = await fixture();
    try {
      const result = await f.client.callTool({
        name: "manage_search",
        arguments: args,
      });
      expect(result.isError).toBe(true);
      expect(f.requests).toHaveLength(0);
    } finally {
      await f.close();
    }
  });

  test("does not retry a billable search on upstream failure", async () => {
    const f = await fixture(503);
    try {
      const result = await f.client.callTool({
        name: "manage_search",
        arguments: { action: "create", request: { query: "test" } },
      });
      expect(result.isError).toBe(true);
      expect(f.requests).toHaveLength(1);
    } finally {
      await f.close();
    }
  });
});
