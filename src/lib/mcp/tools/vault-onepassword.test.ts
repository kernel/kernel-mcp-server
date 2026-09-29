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
  spec: { provider: "1password", account: account.key, requests },
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
      entries: [{ ...requests.entries[0], id: "entry-1" }],
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
      expect(credentials).toContain("where their login for the site lives");
      expect(credentials).toContain("First list the vault");
      expect(credentials).toContain("not shared-vault items or passkeys");
      expect(credentials).toContain("not through MCP");
      expect(descriptionOf("manage_vaults")).toContain(
        "Reuse an existing credential for the site first",
      );
      const items = descriptionOf("manage_vault_items");
      expect(items).toContain("1pw_create_access_request");
      expect(items).toContain("1pw_access_request_status");
      expect(items).toContain("recover a failed account link");
      for (const { description } of tools) {
        expect(description).not.toContain("reconcile_access");
        expect(description).not.toMatch(/Family/i);
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
      spec: {
        account: "onepassword",
        logins: [{ website: "https://example.com" }],
      },
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
      spec: {
        account: "onepassword",
        logins: [{ website: "http://example.com" }],
      },
    },
    {
      action: "create",
      provider: "1password",
      spec: {
        account: "onepassword",
        logins: [{ website: "https://example.com" }],
        integration_key: "private-integration-key",
      },
    },
    {
      action: "create",
      provider: "1password",
      spec: {
        logins: [{ website: "https://example.com" }],
        access_token: "private-access-token",
        integration_key: "private-integration-key",
      },
    },
    {
      action: "create",
      provider: "1password",
      spec: {
        account: "onepassword",
        logins: [{ website: "https://example.com", keywords: [] }],
      },
    },
    {
      action: "create",
      provider: "1password",
      spec: { account: "onepassword", logins: [] },
    },
    {
      action: "create",
      provider: "1password",
      spec: {
        account: "onepassword",
        logins: Array.from({ length: 6 }, (_, i) => ({
          website: `https://site${i}.example/login`,
        })),
      },
    },
    {
      action: "create",
      provider: "1password",
      spec: { account_id: "vi_account", website: "https://example.com" },
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
      expect(JSON.stringify(result)).not.toContain("private-access-token");
      expect(fixture.requests).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  });

  test.each([
    {
      action: "create",
      provider: "1password",
      spec: {
        fields: [{ name: "password", type: "password", value: "hunter2" }],
      },
    },
    {
      action: "create",
      provider: "kernel",
      spec: {
        account: "onepassword",
        logins: [{ website: "https://example.com" }],
      },
    },
    {
      action: "update",
      version: 1,
      spec: {
        fields: [{ name: "password", type: "password", value: "hunter2" }],
      },
    },
  ])(
    "rejects a spec that does not match $provider $action before sending",
    async (args) => {
      const fixture = await connectVaultTest([]);
      try {
        const result = await fixture.call("manage_vault_credentials", {
          ...target,
          ...args,
        });
        expect(result.isError).toBe(true);
        const text = JSON.stringify(result);
        expect(text).toContain("No request was sent");
        expect(text).not.toContain("hunter2");
        expect(text).not.toContain("payment");
        expect(fixture.requests).toHaveLength(0);
      } finally {
        await fixture.close();
      }
    },
  );

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
      expect(result.guidance.join(" ")).toContain(
        "account set to this item's key",
      );
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
          account: account.key,
          goal: requests.goal,
          logins: [
            {
              website: "https://example.com/login",
              reason: "Check order status",
              keywords: ["example"],
            },
          ],
        },
      });
      expect(result.isError).toBeUndefined();
      expect(fixture.requests).toHaveLength(1);
      expect(fixture.requests[0]).toMatchObject({
        method: "PUT",
        body: {
          type: "credential",
          spec: { provider: "1password", account: account.key, requests },
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
          entries: [{ ...requests.entries[0], id: "entry-1" }],
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
        expect(body.guidance).toContain("not that login succeeded");
        expectNoReferences(result);
      } finally {
        await fixture.close();
      }
    },
  );

  test("requests several logins and fills the one the owner picks", async () => {
    const logins = [
      { website: "https://example.com/login" },
      { website: "https://example.com/login", reason: "Work account" },
      { website: "https://shop.example/signin" },
    ];
    const multiRequests = {
      version: 2,
      entries: logins.map(({ website, ...rest }) => ({
        type: "login",
        parameters: { website },
        ...rest,
      })),
    };
    const ready = {
      ...readyCredential,
      spec: {
        provider: "1password",
        account: account.key,
        requests: multiRequests,
      },
      state: {
        ...readyCredential.state,
        access_request: {
          ...readyCredential.state.access_request,
          granted_count: 3,
          entries: multiRequests.entries.map((entry, i) => ({
            ...entry,
            id: `entry-${i + 1}`,
          })),
        },
      },
    };
    const fixture = await connectVaultTest([
      Response.json({ ...pendingCredential, spec: ready.spec }),
      Response.json(ready),
      Response.json(ready),
      Response.json({ type: "1pw_fill", status: "fill_submitted" }),
    ]);
    try {
      await fixture.call("manage_vault_credentials", {
        ...target,
        action: "create",
        provider: "1password",
        spec: { account: account.key, logins },
      });
      expect(fixture.requests[0].body).toMatchObject({
        spec: {
          provider: "1password",
          account: account.key,
          requests: multiRequests,
        },
      });
      const read = toolResultJSON(
        await fixture.call("manage_vault_items", { ...target, action: "get" }),
      );
      expect(
        read.item.state.access_request.entries.map(
          (entry: { id: string }) => entry.id,
        ),
      ).toEqual(["entry-1", "entry-2", "entry-3"]);
      expect(read.guidance.join(" ")).toContain(
        "ask the owner which one to use and add entry_id",
      );
      await fixture.call("manage_vault_items", {
        ...target,
        action: "invoke",
        operation: "1pw_fill",
        inputs: {
          browser_id: "browser-1",
          page_url: "https://example.com/login",
          entry_id: "entry-2",
        },
      });
      expect(fixture.requests[3].body).toEqual({
        type: "1pw_fill",
        browser_id: "browser-1",
        page_url: "https://example.com/login",
        entry_id: "entry-2",
      });
    } finally {
      await fixture.close();
    }
  });

  test.each([
    {
      status: "failed",
      expected: "ask the end-user before deleting and recreating",
    },
    { status: "declined", expected: "do not request again unless they ask" },
  ])(
    "tells the agent what a $status request allows",
    async ({ status, expected }) => {
      const fixture = await connectVaultTest([
        Response.json({
          ...pendingCredential,
          state: { provider: "1password", status },
          action: undefined,
          available_operations: [],
        }),
      ]);
      try {
        const read = toolResultJSON(
          await fixture.call("manage_vault_items", {
            ...target,
            action: "get",
          }),
        );
        const guidance = read.guidance.join(" ");
        expect(guidance).toContain(expected);
        expect(guidance).toContain("offer Kernel-hosted collection");
        expect(fixture.requests).toHaveLength(1);
      } finally {
        await fixture.close();
      }
    },
  );

  test("describes stored-token credentials without exposing or accepting tokens", async () => {
    const storedToken = {
      ...readyCredential,
      spec: {
        provider: "1password",
        requests,
        access_token_expires_at: "2026-10-01T00:00:00Z",
        access_token: "private-access-token",
        integration_key: "private-integration-key",
      },
      available_operations: [
        ...readyCredential.available_operations,
        { type: "1pw_update_access_token", description: "Replace the token." },
      ],
    };
    const fixture = await connectVaultTest([Response.json(storedToken)]);
    try {
      const read = await fixture.call("manage_vault_items", {
        ...target,
        action: "get",
      });
      const body = toolResultJSON(read);
      expect(body.item.spec).toEqual({
        provider: "1password",
        requests,
        access_token_expires_at: "2026-10-01T00:00:00Z",
      });
      expect(body.guidance.join(" ")).toContain(
        "1pw_update_access_token is not available through MCP",
      );
      expect(
        body.hints.invocation.map(
          (hint: { arguments: { operation: string } }) =>
            hint.arguments.operation,
        ),
      ).toEqual(["1pw_fill"]);
      const update = await fixture.call("manage_vault_items", {
        ...target,
        action: "invoke",
        operation: "1pw_update_access_token",
        inputs: { access_token: "private-access-token" },
      });
      expect(update.isError).toBe(true);
      for (const result of [read, update]) {
        const text = JSON.stringify(result);
        expect(text).not.toContain("private-access-token");
        expect(text).not.toContain("private-integration-key");
      }
      expect(fixture.requests).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  test("keeps account-backed guidance free of stored-token steps", async () => {
    const fixture = await connectVaultTest([Response.json(readyCredential)]);
    try {
      const read = toolResultJSON(
        await fixture.call("manage_vault_items", { ...target, action: "get" }),
      );
      expect(read.item.spec.account).toBe(account.key);
      expect(read.guidance.join(" ")).not.toContain("customer-supplied");
    } finally {
      await fixture.close();
    }
  });

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
        expect(read.guidance.join(" ")).toContain(
          "first check that the credential_account named by spec.account is connected",
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

  test("passes 1Password operation errors through without retrying", async () => {
    const fixture = await connectVaultTest([
      Response.json({
        ...pendingCredential,
        action: undefined,
        available_operations: [
          { type: "1pw_create_access_request", description: "Request access." },
        ],
      }),
      Response.json(
        {
          code: "conflict",
          message: "1Password access request is already in progress",
        },
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
      const text = JSON.stringify(result.content);
      expect(text).toContain("1Password access request is already in progress");
      expect(text).toContain("Do not retry automatically");
      expect(fixture.requests).toHaveLength(2);
    } finally {
      await fixture.close();
    }
  });
});
