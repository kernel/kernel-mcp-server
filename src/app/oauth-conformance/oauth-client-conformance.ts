import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import {
  CODE_VERIFIER,
  createFixture,
  formRequest,
  type OAuthClientConformanceContract,
} from "./oauth-client-fixture";

const { GET: authorizationServerMetadata } = await import(
  "@/app/.well-known/oauth-authorization-server/route"
);
const { GET: protectedResourceMetadata } = await import(
  "@/app/.well-known/oauth-protected-resource/mcp/route"
);
const { tokenRequest } = await import("@/app/token/route");

export function defineOAuthClientConformance(
  contract: OAuthClientConformanceContract,
): void {
  describe(`${contract.name} OAuth conformance`, () => {
    test("discovers the documented authorization-code, refresh, and PKCE contract", async () => {
      const response = await authorizationServerMetadata(
        new NextRequest(
          "https://auth.example.test/.well-known/oauth-authorization-server",
        ),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        issuer: "https://auth.example.test",
        authorization_endpoint: "https://auth.example.test/authorize",
        token_endpoint: "https://auth.example.test/token",
        registration_endpoint: "https://auth.example.test/register",
        scopes_supported: ["mcp"],
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        authorization_response_iss_parameter_supported: true,
        token_endpoint_auth_methods_supported: expect.arrayContaining(["none"]),
      });

      const resourceResponse = await protectedResourceMetadata(
        new NextRequest(
          "https://auth.example.test/.well-known/oauth-protected-resource/mcp",
        ),
      );
      expect(resourceResponse.status).toBe(200);
      expect(await resourceResponse.json()).toEqual({
        resource: "https://auth.example.test",
        authorization_servers: ["https://auth.example.test"],
        bearer_methods_supported: ["header"],
        scopes_supported: ["mcp"],
      });

      const cliMetadataResponse = await authorizationServerMetadata(
        new NextRequest(
          "https://auth.onkernel.com/.well-known/oauth-authorization-server",
        ),
      );
      const cliMetadata = await cliMetadataResponse.json();
      expect(cliMetadata).toMatchObject({
        issuer: "https://auth.onkernel.com",
        scopes_supported: ["openid"],
        jwks_uri: "https://clerk.example.test/.well-known/jwks.json",
      });
      expect(cliMetadata).not.toHaveProperty(
        "authorization_response_iss_parameter_supported",
      );
    });

    for (const accessScope of ["organization", "project"] as const) {
      test(`${accessScope} authorization and refresh preserve the selected boundary`, async () => {
        const fixture = createFixture(contract);
        const clientId = await fixture.registerClient();
        await fixture.authorize({ clientId, accessScope });
        const initial = await fixture.exchangeCode(clientId);

        const initialContext = fixture.refreshContexts.get(
          initial.refreshToken,
        );
        expect(initialContext).toMatchObject({
          clerk_user_id: "user_1",
          clerk_org_id: "org_1",
          access_scope: accessScope,
          ...(accessScope === "project" ? { project_id: "project_1" } : {}),
        });

        const refreshResponse = await tokenRequest(
          formRequest({
            grant_type: "refresh_token",
            client_id: clientId,
            refresh_token: initial.refreshToken,
            redirect_uri: contract.redirectUri,
            resource: "https://auth.example.test",
            access_scope:
              accessScope === "project" ? "organization" : "project",
            project_id: "attempted-scope-escalation",
            org_id: "attempted-org-switch",
          }),
          fixture.tokenDependencies,
        );

        expect(refreshResponse.status).toBe(200);
        const refreshed = (await refreshResponse.json()) as {
          refresh_token: string;
          org_id: string;
          access_scope: string;
          project_id?: string;
        };
        expect(refreshed).toMatchObject({
          org_id: "org_1",
          access_scope: accessScope,
          ...(accessScope === "project" ? { project_id: "project_1" } : {}),
        });
        if (accessScope === "organization") {
          expect(refreshed.project_id).toBeUndefined();
        }
        expect(fixture.refreshContexts.has(initial.refreshToken)).toBe(false);
        expect(fixture.refreshContexts.get(refreshed.refresh_token)).toEqual(
          initialContext,
        );
        expect(fixture.providerExchanges.at(-1)?.has("access_scope")).toBe(
          false,
        );
        expect(fixture.providerExchanges.at(-1)?.has("project_id")).toBe(false);
        expect(fixture.providerExchanges.at(-1)?.has("org_id")).toBe(false);
      });
    }

    test("rejects a wrong PKCE verifier before provider exchange", async () => {
      const fixture = createFixture(contract);
      const clientId = await fixture.registerClient();
      await fixture.authorize({ clientId, accessScope: "project" });

      const response = await tokenRequest(
        formRequest({
          grant_type: "authorization_code",
          client_id: clientId,
          code: "authorization-code",
          code_verifier: "wrong-verifier",
          redirect_uri: contract.redirectUri,
        }),
        fixture.tokenDependencies,
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_grant" });
      expect(fixture.providerExchanges).toHaveLength(0);
      expect(fixture.persisted).toHaveLength(0);
    });

    test("refresh rejects a different client identity", async () => {
      const fixture = createFixture(contract);
      const clientId = await fixture.registerClient();
      await fixture.authorize({ clientId, accessScope: "project" });
      const initial = await fixture.exchangeCode(clientId);

      const response = await tokenRequest(
        formRequest({
          grant_type: "refresh_token",
          client_id: "different-client",
          refresh_token: initial.refreshToken,
          redirect_uri: contract.redirectUri,
        }),
        fixture.tokenDependencies,
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_grant" });
      expect(fixture.refreshContexts.has(initial.refreshToken)).toBe(true);
      expect(fixture.refreshClientIds.get(initial.refreshToken)).toBe(clientId);
      expect(fixture.persisted).toHaveLength(1);
    });

    test("rejects redirect mismatch and invalid public-client authentication", async () => {
      const redirectFixture = createFixture(contract);
      const clientId = await redirectFixture.registerClient();
      await redirectFixture.authorize({
        clientId,
        accessScope: "organization",
      });

      const redirectResponse = await tokenRequest(
        formRequest({
          grant_type: "authorization_code",
          client_id: clientId,
          code: "authorization-code",
          code_verifier: CODE_VERIFIER,
          redirect_uri: "https://attacker.example/callback",
        }),
        redirectFixture.tokenDependencies,
      );
      expect(redirectResponse.status).toBe(400);
      expect(await redirectResponse.json()).toMatchObject({
        error: "invalid_request",
      });
      expect(redirectFixture.persisted).toHaveLength(0);

      const authFixture = createFixture(contract);
      const authClientId = await authFixture.registerClient();
      await authFixture.authorize({
        clientId: authClientId,
        accessScope: "organization",
      });
      const credentials = Buffer.from(
        `${authClientId}:unexpected-secret`,
      ).toString("base64");
      const authResponse = await tokenRequest(
        formRequest(
          {
            grant_type: "authorization_code",
            code: "authorization-code",
            code_verifier: CODE_VERIFIER,
            redirect_uri: contract.redirectUri,
          },
          { Authorization: `Basic ${credentials}` },
        ),
        authFixture.tokenDependencies,
      );
      expect(authResponse.status).toBe(400);
      expect(await authResponse.json()).toMatchObject({
        error: "invalid_grant",
      });
      expect(authFixture.persisted).toHaveLength(0);
    });
  });
}
