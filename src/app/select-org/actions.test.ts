import { beforeEach, describe, expect, it, mock } from "bun:test";

const auth = mock(
  async (): Promise<{ userId: string | null }> => ({
    userId: "user_1",
  }),
);
const updateUserMetadata = mock(
  async (_userId: string, _params: unknown): Promise<unknown> => ({}),
);
const getOAuthClientMetadata = mock(
  async (): Promise<{
    clientName: string;
    clientUri: string;
    redirectUris: string[];
  } | null> => ({
    clientName: "Claude",
    clientUri: "https://claude.ai",
    redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
  }),
);

mock.module("@/lib/oauth-client-metadata", () => ({
  getOAuthClientMetadata,
  saveOAuthClientMetadata: async () => {},
}));

mock.module("@clerk/nextjs/server", () => ({
  auth,
  clerkClient: async () => ({ users: { updateUserMetadata } }),
  verifyToken: async () => ({ sub: "user_1" }),
}));

const { saveOAuthAttribution } = await import("./actions");

beforeEach(() => {
  auth.mockReset();
  auth.mockImplementation(async () => ({ userId: "user_1" }));
  updateUserMetadata.mockReset();
  updateUserMetadata.mockImplementation(async () => ({}));
  getOAuthClientMetadata.mockReset();
  getOAuthClientMetadata.mockImplementation(async () => ({
    clientName: "Claude",
    clientUri: "https://claude.ai",
    redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
  }));
});

describe("saveOAuthAttribution", () => {
  it("persists both answers and the signup path in one metadata update", async () => {
    const result = await saveOAuthAttribution({
      firstDiscoverySource: "ai_answer",
      connectorTrigger: "claude_suggestion",
      oauthClientId: "client_1",
      oauthRedirectUri: "https://claude.ai/api/mcp/auth_callback",
    });

    expect(result).toEqual({ success: true });
    expect(updateUserMetadata).toHaveBeenCalledWith("user_1", {
      publicMetadata: {
        firstDiscoverySource: "ai_answer",
        connectorTrigger: "claude_suggestion",
        signupPath: "oauth_picker",
        oauthClientId: "client_1",
        oauthClientName: "Claude",
        oauthClientUri: "https://claude.ai",
        oauthRedirectOrigin: "https://claude.ai",
        oauthClientType: "dynamically_registered",
      },
    });
  });

  it("does not mutate metadata for an invalid answer", async () => {
    const result = await saveOAuthAttribution({
      firstDiscoverySource: "ai_answer",
      connectorTrigger: "not-a-choice",
    });

    expect(result).toEqual({ success: false });
    expect(updateUserMetadata).not.toHaveBeenCalled();
  });

  it("does not mutate metadata for a signed-out request", async () => {
    auth.mockImplementation(async () => ({ userId: null }));

    const result = await saveOAuthAttribution({
      firstDiscoverySource: "ai_answer",
      connectorTrigger: "claude_suggestion",
    });

    expect(result).toEqual({ success: false });
    expect(updateUserMetadata).not.toHaveBeenCalled();
  });

  it("keeps survey capture working when registered client metadata is missing", async () => {
    getOAuthClientMetadata.mockImplementation(async () => null);

    const result = await saveOAuthAttribution({
      firstDiscoverySource: "ai_answer",
      connectorTrigger: "manual_connector_url",
      oauthClientId: "client_unknown",
      oauthRedirectUri: "cursor://callback/oauth",
    });

    expect(result).toEqual({ success: true });
    expect(updateUserMetadata).toHaveBeenCalledWith("user_1", {
      publicMetadata: {
        firstDiscoverySource: "ai_answer",
        connectorTrigger: "manual_connector_url",
        signupPath: "oauth_picker",
        oauthClientId: "client_unknown",
        oauthRedirectOrigin: "cursor:",
        oauthClientType: "pre_registered_or_unknown",
      },
    });
  });
});
