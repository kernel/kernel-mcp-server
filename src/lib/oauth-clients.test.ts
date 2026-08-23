import { describe, expect, test } from "bun:test";
import {
  resolveOAuthClientRedirectUris,
  type OAuthClientResolverDependencies,
} from "./oauth-clients";

function dependencies({ cached = null }: { cached?: string[] | null } = {}) {
  const stored: Array<{ clientId: string; redirectUris: string[] }> = [];
  const updated: Parameters<
    OAuthClientResolverDependencies["updateApplication"]
  >[0][] = [];
  const listed: Array<{ limit: number; offset: number }> = [];
  return {
    stored,
    updated,
    listed,
    value: {
      getCachedRedirectUris: async () => cached,
      storeRedirectUris: async (value) => stored.push(value),
      listApplications: async (value) => {
        listed.push(value);
        return {
          data: [
            {
              id: "app_1",
              clientId: "other_client",
              name: "Other",
              redirectUris: ["https://other.test/callback"],
              scopes: "openid",
              isPublic: true,
            },
            {
              id: "app_2",
              clientId: "client_1",
              name: "Existing client",
              redirectUris: ["http://localhost:9999/callback"],
              scopes: "openid",
              isPublic: true,
            },
          ],
          totalCount: 2,
        };
      },
      updateApplication: async (value) => updated.push(value),
    } satisfies OAuthClientResolverDependencies,
  };
}

describe("OAuth client redirect resolution", () => {
  test("uses the cached registration without calling Clerk", async () => {
    const deps = dependencies({ cached: ["http://localhost:9999/callback"] });
    expect(
      await resolveOAuthClientRedirectUris(
        { clientId: "client_1", issuer: "https://auth.example.test" },
        deps.value,
      ),
    ).toEqual(["http://localhost:9999/callback"]);
    expect(deps.listed).toHaveLength(0);
    expect(deps.updated).toHaveLength(0);
  });

  test("migrates an existing Clerk registration to the proxy callback", async () => {
    const deps = dependencies();
    expect(
      await resolveOAuthClientRedirectUris(
        { clientId: "client_1", issuer: "https://auth.example.test" },
        deps.value,
      ),
    ).toEqual(["http://localhost:9999/callback"]);
    expect(deps.updated).toEqual([
      {
        oauthApplicationId: "app_2",
        name: "Existing client",
        redirectUris: [
          "http://localhost:9999/callback",
          "https://auth.example.test/oauth/callback",
        ],
        scopes: "openid",
        public: true,
      },
    ]);
    expect(deps.stored).toEqual([
      {
        clientId: "client_1",
        redirectUris: ["http://localhost:9999/callback"],
      },
    ]);
  });
});
