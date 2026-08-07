import { z } from "zod";

const authContextSchema = z.object({
  authentication: z.object({
    method: z.enum(["api_key", "jwt"]),
    source: z.enum(["api_key", "oauth", "dashboard"]),
    credential_id: z.string().nullable(),
  }),
  principal: z.object({
    type: z.enum(["api_key", "user"]),
    id: z.string().min(1),
  }),
  organization: z.object({
    id: z.string().min(1),
  }),
  authorization: z.object({
    credential_scope: z.object({ project_id: z.string().nullable() }),
    effective_scope: z.object({ project_id: z.string().nullable() }),
  }),
});

export type McpConnectionAnalyticsContext = {
  authMethod: "api_key" | "oauth";
  credentialScope: "organization" | "project";
  connectionScope: "organization" | "project";
  scopeSource: "credential" | "server_pin";
  organizationId: string;
  userId: string | null;
};

type Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type ResolveOptions = {
  token: string;
  enabled: boolean;
  signal?: AbortSignal;
  fetchImpl?: Fetch;
  apiBaseUrl?: string;
  serverProjectId?: string;
};

export async function resolveMcpConnectionAnalyticsContext({
  token,
  enabled,
  signal,
  fetchImpl = fetch,
  apiBaseUrl = process.env.API_BASE_URL ?? "https://api.onkernel.com",
  serverProjectId = process.env.KERNEL_PROJECT,
}: ResolveOptions): Promise<McpConnectionAnalyticsContext | null> {
  if (!enabled) return null;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "X-Source": "mcp-server",
    "X-Referral-Source": "mcp.onkernel.com",
  };
  if (serverProjectId) headers["X-Kernel-Project-Id"] = serverProjectId;

  let response: Response;
  try {
    response = await fetchImpl(
      new URL("auth/context", `${apiBaseUrl.replace(/\/$/, "")}/`),
      { headers, signal },
    );
  } catch {
    console.warn("Failed to resolve MCP connection analytics context");
    return null;
  }

  if (!response.ok) {
    console.warn("Failed to resolve MCP connection analytics context");
    return null;
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    console.warn("Received invalid MCP connection analytics context");
    return null;
  }
  const parsed = authContextSchema.safeParse(body);
  if (!parsed.success) {
    console.warn("Received invalid MCP connection analytics context");
    return null;
  }

  const context = parsed.data;
  const isApiKey =
    context.authentication.method === "api_key" &&
    context.authentication.source === "api_key" &&
    context.principal.type === "api_key";
  const isOAuth =
    context.authentication.method === "jwt" &&
    context.authentication.source === "oauth" &&
    context.principal.type === "user";
  if (!isApiKey && !isOAuth) return null;

  const credentialProjectId = context.authorization.credential_scope.project_id;
  const effectiveProjectId = context.authorization.effective_scope.project_id;
  if (
    credentialProjectId &&
    effectiveProjectId &&
    credentialProjectId !== effectiveProjectId
  ) {
    return null;
  }
  if (!credentialProjectId && effectiveProjectId && !serverProjectId) {
    return null;
  }
  if (serverProjectId && effectiveProjectId !== serverProjectId) {
    return null;
  }

  return {
    authMethod: isApiKey ? "api_key" : "oauth",
    credentialScope: credentialProjectId ? "project" : "organization",
    connectionScope: effectiveProjectId ? "project" : "organization",
    scopeSource:
      !credentialProjectId && effectiveProjectId ? "server_pin" : "credential",
    organizationId: context.organization.id,
    userId: isOAuth ? context.principal.id : null,
  };
}
