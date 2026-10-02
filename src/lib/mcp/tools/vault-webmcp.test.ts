import { describe, expect, test } from "bun:test";
import { connectTestMcp, toolResultJSON } from "@/lib/mcp/mcp-test-fixtures";
import { registerVaultCapabilities } from "@/lib/mcp/tools/vaults";
import { connectVaultTest } from "./vaults.test-fixtures";

const target = { vault: "user-123", key: "resy" };
const resyLogin = {
  id: "item-1",
  key: "resy",
  type: "credential",
  version: 2,
  spec: {
    provider: "kernel",
    description: "Resy",
    fields: [
      { name: "email", type: "email", required: true, sensitive: false },
      { name: "password", type: "password", required: true, sensitive: true },
    ],
  },
  state: {
    status: "ready",
    fields: {
      email: { has_value: true, value: "diner@example.com" },
      password: { has_value: true },
    },
  },
  available_operations: [
    { type: "collect", description: "Reopen form" },
    { type: "fill", description: "Fill browser" },
    { type: "webmcp_invoke", description: "Invoke a WebMCP tool" },
  ],
  available_expansions: [],
};
const inputs = {
  browser_id: "browser-1",
  tool_ref: "wmt_live_ref",
  page_url: "https://resy.com/login",
  input: { email: null, password: null, remember_me: true },
  bindings: [
    { field: "email", input_path: "/email" },
    { field: "password", input_path: "/password" },
  ],
};
const invoke = {
  ...target,
  action: "invoke",
  operation: "webmcp_invoke",
  inputs,
};

describe("vault WebMCP invocation", () => {
  test("binds Resy email and password slots and returns the raw tool output", async () => {
    const output = {
      content: [{ type: "text", text: "Signed in as diner@example.com" }],
      structuredContent: { authenticated: true, next: null, steps: [1, 2] },
    };
    const fixture = await connectVaultTest([
      Response.json(resyLogin),
      Response.json({
        type: "webmcp_invoke",
        status: "completed",
        invocation_id: "inv_1",
        output,
      }),
    ]);
    try {
      const result = await fixture.call("manage_vault_items", invoke);
      expect(result.isError).toBeUndefined();
      const body = toolResultJSON(result);
      expect(body.result).toEqual({
        type: "webmcp_invoke",
        status: "completed",
        invocation_id: "inv_1",
        output,
      });
      expect(body.guidance.join(" ")).toContain("untrusted");
      expect(
        fixture.requests.map(({ method, path, body }) => ({
          method,
          path,
          body,
        })),
      ).toEqual([
        {
          method: "GET",
          path: "/vaults/user-123/items/resy",
          body: undefined,
        },
        {
          method: "POST",
          path: "/vaults/user-123/items/resy/operations",
          body: { type: "webmcp_invoke", ...inputs, timeout_sec: 15 },
        },
      ]);
    } finally {
      await fixture.close();
    }
  });

  test("preserves null output and awaiting_submission without marking an error", async () => {
    const fixture = await connectVaultTest([
      Response.json(resyLogin),
      Response.json({
        type: "webmcp_invoke",
        status: "awaiting_submission",
        invocation_id: "inv_2",
        output: null,
      }),
    ]);
    try {
      const result = await fixture.call("manage_vault_items", invoke);
      expect(result.isError).toBeUndefined();
      const body = toolResultJSON(result);
      expect(body.result).toEqual({
        type: "webmcp_invoke",
        status: "awaiting_submission",
        invocation_id: "inv_2",
        output: null,
      });
      expect(body.guidance[0]).toContain("Do not invoke the tool again");
    } finally {
      await fixture.close();
    }
  });

  test.each([
    {
      status: "error",
      error_text: "Invalid email or password",
      guidance: "The tool reported an error",
    },
    { status: "canceled", guidance: "The invocation was canceled" },
    { status: "unknown", guidance: "Never retry automatically" },
    { status: "future_status", guidance: "Never retry automatically" },
  ])(
    "reports $status as an error without retrying",
    async ({ status, error_text, guidance }) => {
      const fixture = await connectVaultTest([
        Response.json(resyLogin),
        Response.json({
          type: "webmcp_invoke",
          status,
          invocation_id: "inv_3",
          ...(error_text && { error_text }),
        }),
      ]);
      try {
        const result = await fixture.call("manage_vault_items", invoke);
        expect(result.isError).toBe(true);
        const body = toolResultJSON(result);
        expect(body.result).toEqual({
          type: "webmcp_invoke",
          status,
          invocation_id: "inv_3",
          ...(error_text && { error_text }),
        });
        expect(body.guidance[0]).toContain(guidance);
        expect(
          fixture.requests.filter((request) => request.method === "POST"),
        ).toHaveLength(1);
      } finally {
        await fixture.close();
      }
    },
  );

  test.each([
    { status: 400, code: "target_changed" },
    { status: 400, code: "invalid_request" },
    { status: 403, code: "destination_denied" },
    { status: 409, code: "conflict" },
    { status: 500, code: "execution_failed" },
  ])(
    "passes through $status $code without retrying",
    async ({ status, code }) => {
      const fixture = await connectVaultTest([
        Response.json(resyLogin),
        Response.json({ code, message: "API diagnostic message" }, { status }),
      ]);
      try {
        const result = await fixture.call("manage_vault_items", invoke);
        const text = JSON.stringify(result);
        expect(result.isError).toBe(true);
        expect(text).toContain(`[code: ${code}]`);
        expect(text).toContain("Do not retry automatically.");
        expect(
          fixture.requests.filter((request) => request.method === "POST"),
        ).toHaveLength(1);
      } finally {
        await fixture.close();
      }
    },
  );

  test("does not retry a transport failure after submission", async () => {
    const fixture = await connectVaultTest([
      Response.json(resyLogin),
      new Error("socket hang up"),
    ]);
    try {
      const result = await fixture.call("manage_vault_items", invoke);
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain(
        "The operation may have partially completed",
      );
      expect(
        fixture.requests.filter((request) => request.method === "POST"),
      ).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  test("rejects an unrecognized response shape", async () => {
    const fixture = await connectVaultTest([
      Response.json(resyLogin),
      Response.json({ type: "webmcp_invoke", opaque: "hidden" }),
    ]);
    try {
      const result = await fixture.call("manage_vault_items", invoke);
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("unrecognized response");
      expect(JSON.stringify(result)).not.toContain("hidden");
    } finally {
      await fixture.close();
    }
  });

  test.each([
    { name: "missing bindings", inputs: { ...inputs, bindings: undefined } },
    { name: "empty bindings", inputs: { ...inputs, bindings: [] } },
    {
      name: "unknown input key",
      inputs: { ...inputs, password: "private-password" },
    },
    {
      name: "unknown binding key",
      inputs: {
        ...inputs,
        bindings: [
          { field: "password", input_path: "/password", value: "private-x" },
        ],
      },
    },
    { name: "timeout too long", inputs: { ...inputs, timeout_sec: 121 } },
    { name: "non-object input", inputs: { ...inputs, input: "private-text" } },
  ])(
    "rejects $name before any request without echoing values",
    async ({ inputs }) => {
      const fixture = await connectVaultTest([]);
      try {
        const result = await fixture.call("manage_vault_items", {
          ...invoke,
          inputs,
        });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result)).toContain(
          "Invalid webmcp_invoke inputs",
        );
        expect(JSON.stringify(result)).not.toContain("private-");
        expect(fixture.requests).toHaveLength(0);
      } finally {
        await fixture.close();
      }
    },
  );

  test("requires webmcp_invoke to be advertised", async () => {
    const fixture = await connectVaultTest([
      Response.json({
        ...resyLogin,
        available_operations: resyLogin.available_operations.filter(
          ({ type }) => type !== "webmcp_invoke",
        ),
      }),
    ]);
    try {
      const result = await fixture.call("manage_vault_items", invoke);
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("not advertised");
      expect(fixture.requests.map((request) => request.method)).toEqual([
        "GET",
      ]);
    } finally {
      await fixture.close();
    }
  });

  test("waits for the tool timeout plus API preflight without retries", async () => {
    const options: Array<{
      timeout: number;
      maxRetries: number;
      signal: AbortSignal;
    }> = [];
    const fixture = await connectTestMcp(registerVaultCapabilities, {
      vaults: {
        items: {
          retrieve: async () => resyLogin,
          performOperation: async (
            _key: string,
            _params: unknown,
            requestOptions: (typeof options)[number],
          ) => {
            options.push(requestOptions);
            return { type: "webmcp_invoke", status: "completed" };
          },
        },
      },
    });
    try {
      await fixture.client.callTool({
        name: "manage_vault_items",
        arguments: { ...invoke, inputs: { ...inputs, timeout_sec: 30 } },
      });
      expect(options).toHaveLength(1);
      expect(options[0].timeout).toBe(70_000);
      expect(options[0].maxRetries).toBe(0);
      expect(options[0].signal).toBeInstanceOf(AbortSignal);
    } finally {
      await fixture.close();
    }
  });

  test("adds WebMCP guidance when the item advertises webmcp_invoke", async () => {
    const fixture = await connectVaultTest([
      Response.json(resyLogin),
      Response.json({
        ...resyLogin,
        available_operations: resyLogin.available_operations.filter(
          ({ type }) => type !== "webmcp_invoke",
        ),
      }),
    ]);
    try {
      const get = { ...target, action: "get" };
      const advertised = toolResultJSON(
        await fixture.call("manage_vault_items", get),
      );
      expect(advertised.guidance.join(" ")).toContain(
        "webmcp_invoke supplies vault values",
      );
      expect(
        advertised.hints.invocation.find(
          (hint: { arguments: { operation: string } }) =>
            hint.arguments.operation === "webmcp_invoke",
        )?.requires_user_approval,
      ).toBe(true);
      const unadvertised = toolResultJSON(
        await fixture.call("manage_vault_items", get),
      );
      expect(unadvertised.guidance.join(" ")).not.toContain("webmcp_invoke");
    } finally {
      await fixture.close();
    }
  });
});
