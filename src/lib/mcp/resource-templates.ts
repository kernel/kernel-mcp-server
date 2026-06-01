import {
  ResourceTemplate,
  type McpServer,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { createKernelClient, type KernelClient } from "@/lib/mcp/kernel-client";

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

function templateVariableValue(
  variables: Record<string, string | string[]>,
  name: string,
) {
  const value = variables[name];
  return Array.isArray(value) ? value[0] : value;
}

export function registerJsonResourceTemplate(
  server: McpServer,
  options: JsonResourceTemplateOptions,
) {
  server.resource(
    options.name,
    new ResourceTemplate(options.uriTemplate, { list: undefined }),
    async (uri, variables, extra) => {
      if (!extra.authInfo) {
        throw new Error("Authentication required");
      }

      const identifier = templateVariableValue(variables, options.variableName);
      if (!identifier) {
        throw new Error(`Invalid ${options.resourceLabel} URI: ${uri}`);
      }

      const client = createKernelClient(extra.authInfo.token);
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
