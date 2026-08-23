import { verifyToken } from "@clerk/nextjs/server";
import { isValidJwtFormat } from "@/lib/auth-utils";
import {
  getOAuthAccessTokenSession,
  type OAuthAccessTokenSession,
} from "@/lib/redis";
import { isKernelOAuthAccessToken } from "@/lib/oauth-tokens";
import { oauthResourceAllowsRequest } from "@/lib/oauth-resource";

export interface PresentedCredentialDependencies {
  getAccessTokenSession: (
    token: string,
  ) => Promise<OAuthAccessTokenSession | null>;
  verify: (
    token: string,
    options: { secretKey?: string },
  ) => Promise<{ sub?: string }>;
}

const dependencies: PresentedCredentialDependencies = {
  getAccessTokenSession: getOAuthAccessTokenSession,
  verify: verifyToken,
};

export type PresentedCredential =
  | { kind: "api_key"; token: string }
  | {
      kind: "oauth";
      clientToken: string;
      providerToken: string;
      userId: string;
    }
  | { kind: "invalid"; description: string }
  | { kind: "unavailable" };

export async function resolvePresentedCredential(
  token: string,
  requestUrl: string,
  resolver: PresentedCredentialDependencies = dependencies,
): Promise<PresentedCredential> {
  let providerToken = token;
  if (isKernelOAuthAccessToken(token)) {
    let session: OAuthAccessTokenSession | null;
    try {
      session = await resolver.getAccessTokenSession(token);
    } catch {
      return { kind: "unavailable" };
    }
    if (!session) {
      return {
        kind: "invalid",
        description: "Access token is invalid or expired",
      };
    }
    try {
      if (
        !oauthResourceAllowsRequest({
          resource: session.resource,
          requestUrl,
        })
      ) {
        return {
          kind: "invalid",
          description: "Access token is not valid for this MCP server",
        };
      }
    } catch {
      return {
        kind: "invalid",
        description: "Access token is not valid for this MCP server",
      };
    }
    providerToken = session.providerJwt;
  } else if (!isValidJwtFormat(token)) {
    return { kind: "api_key", token };
  }

  try {
    const payload = await resolver.verify(providerToken, {
      secretKey: process.env.CLERK_SECRET_KEY,
    });
    if (!payload.sub) {
      return {
        kind: "invalid",
        description: "Invalid token: No user ID found in token payload",
      };
    }
    return {
      kind: "oauth",
      clientToken: token,
      providerToken,
      userId: payload.sub,
    };
  } catch (error) {
    return {
      kind: "invalid",
      description: `Invalid token: ${error instanceof Error ? error.message : "Authentication failed"}`,
    };
  }
}
