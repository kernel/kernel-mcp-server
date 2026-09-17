import { describe, expect, test } from "bun:test";
import { toolResultJSON } from "@/lib/mcp/mcp-test-fixtures";
import { vaultItemResponse } from "@/lib/mcp/vault-responses";
import { connectVaultTest, item } from "@/lib/mcp/tools/vaults.test-fixtures";

const target = { vault: "user-123", key: "login" };
const credential = {
  id: "credential-1",
  key: "login",
  type: "credential",
  version: 7,
  spec: {
    description: "Hacker News",
    fields: [
      {
        name: "username",
        type: "text",
        required: true,
        sensitive: false,
        value: "private-user",
      },
      {
        name: "password",
        type: "password",
        required: true,
        sensitive: true,
        value: "private-password",
      },
      {
        name: "otp",
        type: "totp",
        required: false,
        sensitive: true,
        value: "private-seed",
      },
    ],
  },
  state: {
    status: "ready",
    fields: {
      username: { has_value: true, value: "private-user" },
      password: { has_value: true, value: "private-password" },
      otp: { has_value: true, value: "private-seed" },
    },
  },
  action: {
    name: "collect",
    url: "https://vault.example/collect#token=collection-token",
    expires_at: "2026-09-16T00:00:00Z",
  },
  available_operations: [
    { type: "collect", description: "Open the full form" },
    { type: "fill", description: "Fill selected fields" },
  ],
  available_expansions: [],
};

describe("vault OpenAPI steering", () => {
  test("an omitted sensitivity flag does not hide other public values", () => {
    const result = toolResultJSON(
      vaultItemResponse(
        {
          ...credential,
          spec: {
            fields: [
              { name: "username", type: "text", sensitive: false },
              { name: "password", type: "password" },
            ],
          },
        },
        target,
      ),
    );
    expect(result.item.state.fields.username.value).toBe("private-user");
    expect(result.item.state.fields.password.value).toBeUndefined();
    expect(result.item.state.fields.otp.value).toBeUndefined();
  });
  test("fails closed on duplicate credential definitions", () => {
    const result = toolResultJSON(
      vaultItemResponse(
        {
          ...credential,
          spec: {
            fields: [
              { name: "username", type: "text", sensitive: false },
              { name: "username", type: "password", sensitive: true },
            ],
          },
        },
        target,
      ),
    );
    expect(result.item.state.fields.username).toEqual({ has_value: true });
    expect(JSON.stringify(result)).not.toContain("private-user");
  });
  test.each([
    { type: "text", sensitive: false, visible: true },
    { type: "email", sensitive: false, visible: true },
    { type: "text", sensitive: true, visible: false },
    { type: "password", sensitive: false, visible: false },
    { type: "totp", sensitive: false, visible: false },
    { type: "text", sensitive: undefined, visible: false },
  ])(
    "only exposes explicitly public text/email values",
    ({ type, sensitive, visible }) => {
      const result = toolResultJSON(
        vaultItemResponse(
          {
            ...credential,
            spec: { fields: [{ name: "field", type, sensitive }] },
            state: {
              status: "ready",
              fields: { field: { has_value: true, value: "test-value" } },
            },
          },
          target,
        ),
      );
      expect(result.item.state.fields.field.value).toBe(
        visible ? "test-value" : undefined,
      );
    },
  );
  test("tool discovery exposes credential creation and steers per-user collection", async () => {
    const fixture = await connectVaultTest([]);
    try {
      const { tools } = await fixture.client.listTools();
      const vaults = tools.find(({ name }) => name === "manage_vaults");
      const items = tools.find(({ name }) => name === "manage_vault_items");
      expect(vaults?.description).toContain("separate vault per end user");
      expect(vaults?.description).toContain("sensitive:false");
      expect(items?.description).toContain("without renewing collection links");
      expect(items?.description).toContain(
        'action: "invoke" with operation: "collect"',
      );
      const credentials = tools.find(
        ({ name }) => name === "manage_vault_credentials",
      );
      expect(credentials?.description).toContain(
        'action: "invoke" and operation: "collect"',
      );
      expect(credentials?.description).toContain("natural top-to-bottom order");
      expect(items?.description).toContain("API-only");
      expect(tools.map(({ name }) => name)).toContain(
        "manage_vault_credentials",
      );
      expect(fixture.requests).toEqual([]);
    } finally {
      await fixture.close();
    }
  });
  test.each(["ready", "pending_collection"])(
    "preserves %s public credential values, not secrets",
    (status) => {
      const result = toolResultJSON(
        vaultItemResponse(
          { ...credential, state: { ...credential.state, status } },
          target,
        ),
      );
      expect(result.item.version).toBe(7);
      expect(result.item.spec.description).toBe("Hacker News");
      expect(result.item.spec.fields[0]).toEqual({
        name: "username",
        type: "text",
        required: true,
        sensitive: false,
      });
      expect(result.item.state.fields.otp).toEqual({ has_value: true });
      expect(result.item.action.expires_at).toBe(credential.action.expires_at);
      expect(result.item.action.url).toBe(credential.action.url);
      expect(result.item.state.fields.username.value).toBe("private-user");
      expect(JSON.stringify(result)).not.toContain("private-password");
      expect(JSON.stringify(result)).not.toContain("private-seed");
      expect(
        result.hints.invocation.map(
          (hint: { arguments: { operation: string } }) =>
            hint.arguments.operation,
        ),
      ).toEqual(["collect"]);
      const guidance = result.guidance.join(" ");
      for (const text of [
        "bearer credential",
        "sensitive:false",
        "expected_item_id",
        "site-name-only",
        "natural top-to-bottom order",
        "wait observes readiness",
        "manage_vault_credentials",
        "Never retry an uncertain fill",
      ])
        expect(guidance).toContain(text);
      expect(guidance).not.toContain("Ready does not mean paid");
    },
  );

  test("collect remains parameterless and returns the safe credential projection", async () => {
    const fixture = await connectVaultTest([
      Response.json(credential),
      Response.json(credential),
    ]);
    try {
      const result = toolResultJSON(
        await fixture.call("manage_vault_items", {
          ...target,
          action: "invoke",
          operation: "collect",
        }),
      );
      expect(result.item.version).toBe(7);
      expect(result.item.spec.fields[1].sensitive).toBe(true);
      expect(result.item.state.fields.username.value).toBe("private-user");
      expect(JSON.stringify(result)).not.toContain("private-password");
      expect(JSON.stringify(result)).not.toContain("private-seed");
      expect(
        fixture.requests.map(({ method, body }) => ({ method, body })),
      ).toEqual([
        { method: "GET", body: undefined },
        { method: "POST", body: { type: "collect" } },
      ]);
    } finally {
      await fixture.close();
    }
  });

  test("list preserves presence metadata without renewing collection", async () => {
    const fixture = await connectVaultTest([Response.json([credential])]);
    try {
      const result = toolResultJSON(
        await fixture.call("manage_vault_items", {
          vault: target.vault,
          action: "list",
        }),
      );
      expect(result.items[0].state.fields.password).toEqual({
        has_value: true,
      });
      expect(result.items[0].state.fields.username.value).toBe("private-user");
      expect(JSON.stringify(result)).not.toContain("private-password");
      expect(JSON.stringify(result)).not.toContain("private-seed");
      expect(fixture.requests).toHaveLength(1);
      expect(fixture.requests[0].method).toBe("GET");
    } finally {
      await fixture.close();
    }
  });

  test("preserves preparation deadlines while withholding unsupported invocation hints", () => {
    const preparation = {
      id: "prep-1",
      browser_id: "browser-1",
      merchant_origin: "https://shop.example",
      environment: "production",
      status: "ready",
      expires_at: "2026-09-16T00:00:30Z",
      approval_url: "https://approve.example/prepare",
    };
    const result = toolResultJSON(
      vaultItemResponse(
        {
          ...item,
          spec: { ...item.spec, provider: "agentcard" },
          state: {
            provider: "agentcard",
            status: "ready_to_submit",
            preparation: { ...preparation, token: "private-token" },
          },
          available_operations: [
            { type: "prepare_checkout", description: "Prepare checkout" },
          ],
        },
        target,
      ),
    );
    expect(result.item.state.preparation).toEqual(preparation);
    expect(result.hints.invocation).toEqual([]);
    expect(result.guidance.join(" ")).toContain("Preparations are single-use");
    expect(result.guidance.join(" ")).toContain("Never fall back to aliases");
    expect(JSON.stringify(result)).not.toContain("private-token");
  });

  test("preserves ordered definitions without projecting unknown values", () => {
    const result = toolResultJSON(
      vaultItemResponse(
        {
          ...credential,
          spec: {
            ...credential.spec,
            fields: [
              { name: "password", type: "password", value: "private-value" },
              { name: "username", type: "text", sensitive: false },
            ],
          },
        },
        target,
      ),
    );
    expect(result.item.spec.fields).toEqual([
      { name: "password", type: "password" },
      { name: "username", type: "text", sensitive: false },
    ]);
    expect(JSON.stringify(result)).not.toContain("private-value");
  });
});
