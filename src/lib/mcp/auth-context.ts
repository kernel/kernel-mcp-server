import type { AuthContext } from "@onkernel/sdk/resources/auth/context";
import { z } from "zod";
import {
  defaultMcpDependencies,
  type McpDependencies,
} from "@/lib/mcp/dependencies";

const authContextSchema: z.ZodType<AuthContext> = z.object({
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

type AuthContextDependencies = Pick<McpDependencies, "createKernelClient">;

type ResolveAuthContextOptions = {
  token: string;
  signal?: AbortSignal;
  dependencies?: AuthContextDependencies;
};

export async function resolveMcpAuthContext({
  token,
  signal,
  dependencies = defaultMcpDependencies,
}: ResolveAuthContextOptions): Promise<AuthContext | null> {
  try {
    const context = await dependencies
      .createKernelClient(token)
      .auth.context.retrieve({ signal });
    const parsed = authContextSchema.safeParse(context);
    if (parsed.success) return parsed.data;
    console.warn("Received invalid MCP auth context", parsed.error.issues);
  } catch (error) {
    console.warn(
      "Failed to resolve MCP auth context",
      error instanceof Error ? error.message : error,
    );
  }
  return null;
}

type ResolveConnectionAnalyticsOptions = ResolveAuthContextOptions & {
  authContext?: Promise<AuthContext | null>;
  serverProjectId?: string;
};

export async function resolveMcpConnectionAnalyticsContext({
  token,
  signal,
  dependencies,
  authContext,
  serverProjectId = process.env.KERNEL_PROJECT,
}: ResolveConnectionAnalyticsOptions): Promise<McpConnectionAnalyticsContext | null> {
  const context = await (authContext ??
    resolveMcpAuthContext({ token, signal, dependencies }));
  if (!context) return null;

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
  if (credentialProjectId && effectiveProjectId !== credentialProjectId) {
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
