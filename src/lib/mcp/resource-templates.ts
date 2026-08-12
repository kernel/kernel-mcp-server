import {
  ResourceTemplate,
  type McpServer,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  defaultMcpDependencies,
  type McpDependencies,
} from "@/lib/mcp/dependencies";
import type { KernelClient } from "@/lib/mcp/kernel-client";
import {
  connectionContextFromAuthInfo,
  projectIDForOperation,
} from "@/lib/mcp/project-selection";

type JsonResourceTemplateOptions = {
  name: string;
  uriTemplate: string;
  variableName: string;
  resourceLabel: string;
  read: (
    client: KernelClient,
    identifier: string,
  ) => Promise<unknown | null | undefined>;
};

type JsonResourceCollectionOptions = {
  name: string;
  uriTemplate: string;
  emptyText: string;
  read: (client: KernelClient) => Promise<unknown[]>;
};

function templateVariableValue(
  variables: Record<string, string | string[]>,
  name: string,
) {
  const value = variables[name];
  return Array.isArray(value) ? value[0] : value;
}

function projectScopedClient(
  uri: URL,
  variables: Record<string, string | string[]>,
  authInfo: AuthInfo,
  dependencies: McpDependencies,
) {
  const organizationId = templateVariableValue(variables, "organizationId");
  const projectId = templateVariableValue(variables, "projectId");
  if (!organizationId || !projectId) {
    throw new Error(`Invalid project-scoped resource URI: ${uri}`);
  }

  const { scope } = connectionContextFromAuthInfo(authInfo);
  if (organizationId !== scope.organizationId) {
    throw new Error(
      `Resource organization must match this connection (${scope.organizationId})`,
    );
  }
  return dependencies.createKernelClient(
    authInfo.token,
    projectIDForOperation(authInfo, projectId),
  );
}

export function registerJsonResourceCollection(
  server: McpServer,
  options: JsonResourceCollectionOptions,
  dependencies: McpDependencies = defaultMcpDependencies,
) {
  server.resource(
    options.name,
    new ResourceTemplate(options.uriTemplate, { list: undefined }),
    async (uri, variables, extra) => {
      if (!extra.authInfo) throw new Error("Authentication required");
      const client = projectScopedClient(
        uri,
        variables,
        extra.authInfo,
        dependencies,
      );
      const resources = await options.read(client);
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: "application/json",
            text:
              resources.length > 0
                ? JSON.stringify(resources, null, 2)
                : options.emptyText,
          },
        ],
      };
    },
  );
}

export function registerJsonResourceTemplate(
  server: McpServer,
  options: JsonResourceTemplateOptions,
  dependencies: McpDependencies = defaultMcpDependencies,
) {
  server.resource(
    options.name,
    new ResourceTemplate(options.uriTemplate, { list: undefined }),
    async (uri, variables, extra) => {
      if (!extra.authInfo) throw new Error("Authentication required");

      const identifier = templateVariableValue(variables, options.variableName);
      if (!identifier) {
        throw new Error(`Invalid ${options.resourceLabel} URI: ${uri}`);
      }

      const client = projectScopedClient(
        uri,
        variables,
        extra.authInfo,
        dependencies,
      );
      const resource = await options.read(client, identifier);
      if (!resource) {
        throw new Error(`${options.resourceLabel} "${identifier}" not found`);
      }

      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: "application/json",
            text: JSON.stringify(resource, null, 2),
          },
        ],
      };
    },
  );
}
