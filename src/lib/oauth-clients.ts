import { clerkClient } from "@clerk/nextjs/server";
import {
  getOAuthClientRedirectUris,
  setOAuthClientRedirectUris,
} from "@/lib/redis";
import { oauthProxyCallbackUrl } from "@/lib/oauth-proxy";

interface OAuthApplicationRecord {
  id: string;
  clientId: string;
  name: string;
  redirectUris: string[];
  scopes: string;
  isPublic: boolean;
}

export interface OAuthClientResolverDependencies {
  getCachedRedirectUris: (clientId: string) => Promise<string[] | null>;
  storeRedirectUris: (input: {
    clientId: string;
    redirectUris: string[];
  }) => Promise<void>;
  listApplications: (input: {
    limit: number;
    offset: number;
  }) => Promise<{ data: OAuthApplicationRecord[]; totalCount: number }>;
  updateApplication: (input: {
    oauthApplicationId: string;
    name: string;
    redirectUris: string[];
    scopes: string;
    public: boolean;
  }) => Promise<void>;
}

const dependencies: OAuthClientResolverDependencies = {
  getCachedRedirectUris: getOAuthClientRedirectUris,
  storeRedirectUris: setOAuthClientRedirectUris,
  listApplications: async (input) => {
    const clerk = await clerkClient();
    return clerk.oauthApplications.list(input);
  },
  updateApplication: async (input) => {
    const clerk = await clerkClient();
    await clerk.oauthApplications.update(input);
  },
};

export async function resolveOAuthClientRedirectUris(
  {
    clientId,
    issuer,
  }: {
    clientId: string;
    issuer: string;
  },
  resolver: OAuthClientResolverDependencies = dependencies,
): Promise<string[] | null> {
  const cached = await resolver.getCachedRedirectUris(clientId);
  if (cached) return cached;

  const limit = 100;
  let offset = 0;
  let application: OAuthApplicationRecord | undefined;
  do {
    const page = await resolver.listApplications({ limit, offset });
    application = page.data.find(
      (candidate) => candidate.clientId === clientId,
    );
    if (application) break;
    offset += page.data.length;
    if (page.data.length === 0 || offset >= page.totalCount) break;
  } while (!application);

  if (!application) return null;

  const callback = oauthProxyCallbackUrl(issuer);
  const clientRedirectUris = application.redirectUris.filter(
    (uri) => uri !== callback,
  );
  if (!application.redirectUris.includes(callback)) {
    await resolver.updateApplication({
      oauthApplicationId: application.id,
      name: application.name,
      redirectUris: [...application.redirectUris, callback],
      scopes: application.scopes,
      public: application.isPublic,
    });
  }
  await resolver.storeRedirectUris({
    clientId,
    redirectUris: clientRedirectUris,
  });
  return clientRedirectUris;
}
