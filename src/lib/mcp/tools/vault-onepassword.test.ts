import { describe, expect, test } from "bun:test";
import { toolResultJSON } from "@/lib/mcp/mcp-test-fixtures";
import { connectVaultTest } from "./vaults.test-fixtures";

const target = { vault: "user-123", key: "example-login" };
const requestID = "private-access-request-id";
const reference = "eyJpZCI6InByaXZhdGUtYWNjZXNzLXJlcXVlc3QtaWQifQ";
const approvalLink = `onepassword://grant-brokered-access?access_request_reference=${reference}`;
const approvalInstructions = `Present ${approvalLink} for ${requestID}.`;
const oauthURL =
  "https://1password.example/oauth/authorize?client_id=kernel&state=opaque";

const account = {
  id: "vi_account",
  key: "onepassword",
  type: "credential_account",
  spec: {
    provider: "1password",
    authorization: { method: "oauth", client: { type: "kernel_managed" } },
  },
  state: { provider: "1password", status: "pending_authorization" },
  action: { name: "1password_oauth", url: oauthURL },
  available_operations: [],
  available_expansions: [],
  created_at: "2026-09-25T00:00:00Z",
  updated_at: "2026-09-25T00:00:00Z",
};

const requests = {
  version: 2,
  goal: "Sign in to Example",
  entries: [
    {
      type: "login",
      parameters: { website: "https://example.com/login" },
      reason: "Check order status",
      keywords: ["example"],
    },
  ],
};

const pendingCredential = {
  id: "vi_credential",
  key: target.key,
  type: "credential",
  version: 1,
  spec: { provider: "1password", account_id: account.id, requests },
  state: {
    provider: "1password",
    status: "pending_authorization",
    access_request_id: requestID,
    access_request: {
      id: requestID,
      path: "private-provider-path",
      identity: "private-provider-identity",
      createdAt: "2026-09-25T00:00:00Z",
      state: "pending",
      has_autofill_token: false,
      granted_count: 0,
      entries: [{ ...requests.entries[0], id: "private-entry-id" }],
    },
  },
  action: {
    name: "1password_access_approval",
    url: approvalLink,
    instructions: approvalInstructions,
  },
  available_operations: [
    { type: "1pw_access_request_status", description: "Check the request." },
  ],
  available_expansions: [],
  created_at: "2026-09-25T00:00:00Z",
  updated_at: "2026-09-25T00:00:00Z",
};

const readyCredential = {
  ...pendingCredential,
  state: {
    provider: "1password",
    status: "ready",
    access_request: {
      ...pendingCredential.state.access_request,
      state: "resolved",
      has_autofill_token: true,
      granted_count: 1,
    },
  },
  action: undefined,
  available_operations: [{ type: "1pw_fill", description: "Fill and submit." }],
};

function expectNoReferences(value: unknown, { approvalLink = false } = {}) {
  const text = JSON.stringify(value);
  for (const privateValue of [
    requestID,
    ...(approvalLink ? [] : [reference, "access_request_reference="]),
    "private-provider-path",
    "private-provider-identity",
    "private-entry-id",
    "/approval/",
  ])
    expect(text).not.toContain(privateValue);
}

describe("1Password vault credentials", () => {
  test("steers agents to ask which credential path the user prefers", async () => {
    const fixture = await connectVaultTest([]);
    try {
      const { tools } = await fixture.client.listTools();
      const descriptionOf = (name: string) =>
        tools.find((tool) => tool.name === name)?.description ?? "";
      const credentials = descriptionOf("manage_vault_credentials");
      expect(credentials).toContain("two credential paths");
      expect(credentials).toContain("ask the user which they prefer");
      expect(credentials).toContain("Kernel-hosted collection");
      expect(credentials).toContain("1Password brokered approval");
      expect(credentials).toContain("never open, decode, or approve");
      expect(descriptionOf("manage_vaults")).toContain(
        "Ask the user which they prefer",
      );
      const items = descriptionOf("manage_vault_items");
      expect(items).toContain("1pw_create_access_request");
      expect(items).toContain("1pw_access_request_status");
      expect(items).toContain("recover a failed account link");
      for (const { description } of tools) {
        expect(description).not.toContain("reconcile_access");
        expect(description).not.toMatch(/integration key|Family/i);
      }
      expect(fixture.requests).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  test.each([
    { action: "create", spec: { fields: [{ name: "a", type: "text" }] } },
    { action: "connect_account" },
  ])("requires an explicit provider for $action", async (args) => {
    const fixture = await connectVaultTest([]);
    try {
      const result = await fixture.call("manage_vault_credentials", {
        ...target,
        ...args,
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("Ask the user");
      expect(fixture.requests).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  });

  test.each([
    { action: "connect_account", provider: "kernel" },
    {
      action: "connect_account",
      provider: "1password",
      spec: { account_id: "vi_account", website: "https://example.com" },
    },
    {
      action: "update",
      provider: "1password",
      version: 1,
      spec: { description: "Example" },
    },
    {
      action: "create",
      provider: "1password",
      spec: { account_id: "vi_account", website: "http://example.com" },
    },
    {
      action: "create",
      provider: "1password",
      spec: {
        account_id: "vi_account",
        website: "https://example.com",
        integration_key: "private-integration-key",
      },
    },
    {
      action: "create",
      provider: "1password",
      spec: {
        account_id: "vi_account",
        website: "https://example.com",
        keywords: [],
      },
    },
  ])("rejects invalid 1Password writes without requests (%#)", async (args) => {
    const fixture = await connectVaultTest([]);
    try {
      const result = await fixture.call("manage_vault_credentials", {
        ...target,
        ...args,
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain("private-integration-key");
      expect(fixture.requests).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  });

  test("accepts the Kernel provider on update", async () => {
    const fixture = await connectVaultTest([
      Response.json({
        id: "vi_kernel",
        key: target.key,
        type: "credential",
        version: 3,
        spec: {
          provider: "kernel",
          description: "Example",
          fields: [{ name: "username", type: "text", sensitive: false }],
        },
        state: {
          provider: "kernel",
          status: "ready",
          fields: { username: { has_value: true, value: "alice" } },
        },
        available_operations: [],
        available_expansions: [],
      }),
    ]);
    try {
      const result = await fixture.call("manage_vault_credentials", {
        ...target,
        action: "update",
        provider: "kernel",
        version: 2,
        spec: { description: "Example" },
      });
      expect(result.isError).toBeUndefined();
      expect(fixture.requests[0].body).toEqual({
        type: "credential",
        version: 2,
        spec: { description: "Example" },
      });
    } finally {
      await fixture.close();
    }
  });

  test("connects a Kernel-managed 1Password account for human consent", async () => {
    const fixture = await connectVaultTest([Response.json(account)]);
    try {
      const result = toolResultJSON(
        await fixture.call("manage_vault_credentials", {
          vault: target.vault,
          key: account.key,
          action: "connect_account",
          provider: "1password",
        }),
      );
      expect(fixture.requests[0]).toMatchObject({
        method: "PUT",
        body: {
          type: "credential_account",
          spec: {
            provider: "1password",
            authorization: {
              method: "oauth",
              client: { type: "kernel_managed" },
            },
          },
        },
      });
      expect(result.item.action).toEqual({
        name: "1password_oauth",
        url: oauthURL,
      });
      expect(result.item.state.status).toBe("pending_authorization");
      expect(result.guidance.join(" ")).toContain("only to the account owner");
      expect(result.guidance.join(" ")).toContain("account_id");
    } finally {
      await fixture.close();
    }
  });

  test("offers recovery of a failed account link only when advertised", async () => {
    const recoverable = {
      ...account,
      state: { provider: "1password", status: "reconnect_required" },
      action: undefined,
      available_operations: [
        { type: "1pw_recover", description: "Get a recovery link." },
      ],
    };
    const fixture = await connectVaultTest([
      Response.json(recoverable),
      Response.json(recoverable),
      Response.json({ ...recoverable, action: account.action }),
    ]);
    try {
      const read = toolResultJSON(
        await fixture.call("manage_vault_items", {
          vault: target.vault,
          key: account.key,
          action: "get",
        }),
      );
      const guidance = read.guidance.join(" ");
      expect(guidance).toContain("recover a failed account link");
      expect(guidance).toContain("connect again on the same key");
      expect(guidance).not.toMatch(/integration key|Family/i);
      const result = toolResultJSON(
        await fixture.call("manage_vault_items", {
          vault: target.vault,
          key: account.key,
          action: "invoke",
          operation: "1pw_recover",
        }),
      );
      expect(fixture.requests[2].body).toEqual({ type: "1pw_recover" });
      expect(result.item.action).toEqual({
        name: "1password_oauth",
        url: oauthURL,
      });
    } finally {
      await fixture.close();
    }
  });

  test("creates a 1Password credential from a single login request", async () => {
    const fixture = await connectVaultTest([Response.json(pendingCredential)]);
    try {
      const result = await fixture.call("manage_vault_credentials", {
        ...target,
        action: "create",
        provider: "1password",
        spec: {
          account_id: account.id,
          website: "https://example.com/login",
          goal: requests.goal,
          reason: "Check order status",
          keywords: ["example"],
        },
      });
      expect(result.isError).toBeUndefined();
      expect(fixture.requests).toHaveLength(1);
      expect(fixture.requests[0]).toMatchObject({
        method: "PUT",
        body: {
          type: "credential",
          spec: { provider: "1password", account_id: account.id, requests },
        },
      });
      expectNoReferences(result, { approvalLink: true });
    } finally {
      await fixture.close();
    }
  });

  test("forwards only the native approval link for the account owner", async () => {
    const fixture = await connectVaultTest([Response.json(pendingCredential)]);
    try {
      const result = toolResultJSON(
        await fixture.call("manage_vault_items", { ...target, action: "get" }),
      );
      expectNoReferences(result, { approvalLink: true });
      expect(result.item.action).toEqual({
        name: "1password_access_approval",
        url: approvalLink,
      });
      expect(JSON.stringify(result)).not.toContain(approvalInstructions);
      expect(result.item.spec.requests).toEqual(requests);
      expect(result.item.state).toEqual({
        provider: "1password",
        status: "pending_authorization",
        access_request: {
          state: "pending",
          has_autofill_token: false,
          granted_count: 0,
          entries: requests.entries,
        },
      });
      const guidance = result.guidance.join(" ");
      expect(guidance).toContain("unmodified only to the account owner");
      expect(guidance).toContain("never open it in a browser");
      expect(guidance).toContain('action: "invoke"');
      expect(guidance).toContain('operation: "1pw_access_request_status"');
      expect(guidance).not.toContain("collection URL");
    } finally {
      await fixture.close();
    }
  });

  test("forwards the native approval link whatever the instructions hold", async () => {
    for (const instructions of [undefined, null, 42]) {
      const fixture = await connectVaultTest([
        Response.json({
          ...pendingCredential,
          action: { ...pendingCredential.action, instructions },
        }),
      ]);
      try {
        const result = toolResultJSON(
          await fixture.call("manage_vault_items", {
            ...target,
            action: "get",
          }),
        );
        expect(result.item.action).toEqual({
          name: "1password_access_approval",
          url: approvalLink,
        });
      } finally {
        await fixture.close();
      }
    }
  });

  test.each([
    `https://api.example/vault/onepassword/approval/vi_credential/${reference}`,
    `onepassword://grant-brokered-access?access_request_reference=${reference}&access_token=secret`,
    `onepassword://grant-brokered-access?access_request_reference=${reference}&access_request_reference=${reference}`,
    `onepassword://other-host?access_request_reference=${reference}`,
    `onepassword://user:pass@grant-brokered-access?access_request_reference=${reference}`,
    `onepassword://grant-brokered-access/path?access_request_reference=${reference}`,
    `onepassword://grant-brokered-access?access_request_reference=${reference}#fragment`,
    "onepassword://grant-brokered-access?access_request_reference=not%20base64url",
  ])(
    "reduces non-native approval links to the action name: %s",
    async (url) => {
      const fixture = await connectVaultTest([
        Response.json({
          ...pendingCredential,
          action: { ...pendingCredential.action, url },
        }),
      ]);
      try {
        const result = toolResultJSON(
          await fixture.call("manage_vault_items", {
            ...target,
            action: "get",
          }),
        );
        expectNoReferences(result);
        expect(JSON.stringify(result)).not.toContain("secret");
        expect(result.item.action).toEqual({
          name: "1password_access_approval",
        });
        expect(result.guidance.join(" ")).toContain(
          "tell the owner the approval link is unavailable",
        );
      } finally {
        await fixture.close();
      }
    },
  );

  test("request access returns the pending item with its approval link", async () => {
    const requestable = {
      ...pendingCredential,
      state: { provider: "1password", status: "pending_authorization" },
      action: undefined,
      available_operations: [
        { type: "1pw_create_access_request", description: "Request access." },
      ],
    };
    const fixture = await connectVaultTest([
      Response.json(requestable),
      Response.json(pendingCredential),
    ]);
    try {
      const result = await fixture.call("manage_vault_items", {
        ...target,
        action: "invoke",
        operation: "1pw_create_access_request",
        inputs: { browser_id: "browser-1", reason: "Check order status" },
      });
      expect(result.isError).toBeUndefined();
      expect(fixture.requests[1].body).toEqual({
        type: "1pw_create_access_request",
        browser_id: "browser-1",
        reason: "Check order status",
      });
      expectNoReferences(result, { approvalLink: true });
      expect(toolResultJSON(result).item.action.url).toBe(approvalLink);
    } finally {
      await fixture.close();
    }
  });

  test.each([
    { status: "fill_submitted", isError: undefined },
    { status: "fill_failed", error_code: "fillFailed", isError: true },
    { status: "fill_unknown", isError: true },
  ])(
    "reports 1pw_fill $status without treating it as login success",
    async ({ status, error_code, isError }) => {
      const fixture = await connectVaultTest([
        Response.json(readyCredential),
        Response.json({
          type: "1pw_fill",
          status,
          ...(error_code && { error_code }),
          detail: `private ${reference} ${requestID}`,
        }),
      ]);
      try {
        const result = await fixture.call("manage_vault_items", {
          ...target,
          action: "invoke",
          operation: "1pw_fill",
          inputs: {
            browser_id: "browser-1",
            page_url: "https://example.com/login",
          },
        });
        expect(result.isError).toBe(isError);
        const body = toolResultJSON(result);
        expect(body.result).toEqual({
          type: "1pw_fill",
          status,
          ...(error_code && { error_code }),
        });
        expectNoReferences(result);
      } finally {
        await fixture.close();
      }
    },
  );

  test.each(["1pw_create_access_request", "1pw_reconcile_access"])(
    "keeps an uncertain access request blocked: %s",
    async (operation) => {
      const uncertain = {
        ...pendingCredential,
        state: { provider: "1password", status: "pending_authorization" },
        action: undefined,
        available_operations: [],
      };
      const fixture = await connectVaultTest([
        Response.json(uncertain),
        Response.json(uncertain),
      ]);
      try {
        const read = toolResultJSON(
          await fixture.call("manage_vault_items", {
            ...target,
            action: "get",
          }),
        );
        expect(read.guidance.join(" ")).toContain(
          "never delete or recreate the item to retry",
        );
        const result = await fixture.call("manage_vault_items", {
          ...target,
          action: "invoke",
          operation,
          inputs: { browser_id: "browser-1" },
        });
        expect(result.isError).toBe(true);
        expect(fixture.requests).toHaveLength(2);
        expect(fixture.requests.every(({ method }) => method === "GET")).toBe(
          true,
        );
      } finally {
        await fixture.close();
      }
    },
  );

  test("curates 1Password operation errors", async () => {
    const fixture = await connectVaultTest([
      Response.json({
        ...pendingCredential,
        action: undefined,
        available_operations: [
          { type: "1pw_create_access_request", description: "Request access." },
        ],
      }),
      Response.json(
        { code: "conflict", message: `private ${approvalLink}` },
        { status: 409 },
      ),
    ]);
    try {
      const result = await fixture.call("manage_vault_items", {
        ...target,
        action: "invoke",
        operation: "1pw_create_access_request",
        inputs: { browser_id: "browser-1" },
      });
      expect(result.isError).toBe(true);
      expectNoReferences(result);
      expect(fixture.requests).toHaveLength(2);
    } finally {
      await fixture.close();
    }
  });
});
