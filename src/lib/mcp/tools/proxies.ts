import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  defaultMcpDependencies,
  type McpDependencies,
} from "@/lib/mcp/dependencies";
import {
  errorResponse,
  jsonResponse,
  paginatedJsonResponse,
  textResponse,
  throwToolError,
} from "@/lib/mcp/responses";
import { paginationParams } from "@/lib/mcp/schemas";
import { objectRejectingRemovedParams } from "@/lib/mcp/deprecated-params";
import {
  projectForOperation,
  projectSelectionInputSchema,
} from "@/lib/mcp/project-selection";

const httpUrlSchema = z
  .string()
  .url()
  .refine(
    (value) => {
      try {
        const url = new URL(value);
        return url.protocol === "http:" || url.protocol === "https:";
      } catch {
        return false;
      }
    },
    { message: "url must use http or https." },
  );

const proxyCreateConfigSchema = z.object({
  country: z
    .string()
    .describe('iso 3166 country code (e.g., "US").')
    .optional(),
  state: z.string().describe("two-letter state code.").optional(),
  city: z
    .string()
    .describe(
      "city name without spaces (e.g., 'sanfrancisco'). requires country.",
    )
    .optional(),
  zip: z.string().describe("(residential) us zip code.").optional(),
  asn: z
    .string()
    .describe("(residential) autonomous system number.")
    .optional(),
  ip_address: z
    .ipv4()
    .describe(
      "(isp) reserved exit ip to pin the proxy to. available only to organizations with a reserved isp allocation; country defaults to the ip's country when omitted.",
    )
    .optional(),
  host: z.string().describe("(custom) proxy host address.").optional(),
  port: z.number().int().describe("(custom) proxy port.").optional(),
  username: z.string().describe("(custom) auth username.").optional(),
  password: z.string().describe("(custom) auth password.").optional(),
  ca_bundle: z
    .string()
    .describe(
      "(custom) pem-encoded ca certificate bundle the proxy re-signs upstream tls with. provide when the proxy terminates tls.",
    )
    .optional(),
});

export function registerProxyTools(
  server: McpServer,
  options: McpDependencies = {
    ...defaultMcpDependencies,
  },
) {
  // manage_proxies -- Manage proxies and reserved ISP exit IPs
  server.registerTool(
    "manage_proxies",
    {
      description:
        'manage proxy configurations for routing browser traffic. use "create" to add a proxy, "list" to see proxies, "get" to retrieve one by id or exact name, "rename" to change its name, "move" to move an isp proxy to another reserved exit ip, "check" to test connectivity, or "delete" to remove one. organizations with reserved isp allocations can use "list_reserved_ips" and "get_reserved_ip" to inspect organization-wide addresses; scoped keys need project- or organization-wide proxies:read, not an individual-proxy grant. excluded addresses remain listed but cannot be assigned. names are not unique, so ids are the stable selector for writes. moving probes the new endpoint before changing anything; live browsers move new connections within seconds while established connections drain. choose a proxy type that fits the workload and target-site terms.',
      inputSchema: objectRejectingRemovedParams("manage_proxies")({
        ...projectSelectionInputSchema(),
        action: z
          .enum([
            "create",
            "list",
            "get",
            "rename",
            "move",
            "check",
            "delete",
            "list_reserved_ips",
            "get_reserved_ip",
          ])
          .describe("operation to perform."),
        id_or_name: z
          .string()
          .min(1)
          .describe(
            "(get) proxy id or exact name. ids take precedence if a value matches both; ambiguous names fail. (rename, move, check, delete) use the proxy id.",
          )
          .optional(),
        proxy_id: z
          .string()
          .min(1)
          .describe(
            "deprecated alias for id_or_name. use the proxy id for rename, check, and delete.",
          )
          .optional(),
        check_url: httpUrlSchema
          .describe(
            "(check) optional http(s) url to test through the proxy instead of KERNEL's default check target.",
          )
          .optional(),
        type: z
          .enum(["isp", "residential", "mobile", "custom"])
          .describe(
            "(create) proxy type. datacenter proxies are deprecated; use isp.",
          )
          .optional(),
        name: z
          .string()
          .describe(
            "(create, rename) readable name for the proxy. (list) exact-match name filter; names are not unique, so several proxies can match.",
          )
          .optional(),
        query: z
          .string()
          .describe(
            "(list) case-insensitive substring match against proxy name, host, or ip address. ids match by exact value.",
          )
          .optional(),
        ip_address: z
          .ipv4()
          .describe(
            "(list) exact primary exit ip filter for isp proxies. (move) active reserved exit ip in the proxy's country. (get_reserved_ip) reserved ip to retrieve. for create, use config.ip_address.",
          )
          .optional(),
        ip_country: z
          .string()
          .min(1)
          .describe(
            "(list_reserved_ips) iso 3166 country code supported by isp proxies.",
          )
          .optional(),
        status: z
          .enum(["active", "excluded"])
          .describe(
            "(list_reserved_ips) whether the reserved ip can currently be assigned.",
          )
          .optional(),
        config: proxyCreateConfigSchema
          .describe(
            "(create) settings for the selected type. isp accepts country and reserved ip_address; residential accepts country, state, city, zip, and asn; mobile accepts country, state, and city; custom requires host and port.",
          )
          .optional(),
        bypass_hosts: z
          .array(z.string().min(1))
          .describe(
            "(create) hostnames that connect directly instead of through this proxy.",
          )
          .optional(),
        protocol: z
          .enum(["http", "https"])
          .describe("(create) protocol for the proxy connection.")
          .optional(),
        ...paginationParams,
      }),
      annotations: {
        title: "manage KERNEL proxy configurations",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params, ctx) => {
      if (!ctx.http?.authInfo) throw new Error("authentication required");
      const client = options.createKernelClient(
        ctx.http.authInfo.token,
        projectForOperation(ctx.http.authInfo, params),
      );

      try {
        if (params.id_or_name && params.proxy_id) {
          return errorResponse(
            "error: cannot specify both id_or_name and proxy_id.",
          );
        }
        const idOrName = params.id_or_name ?? params.proxy_id;
        if (
          params.action !== "list_reserved_ips" &&
          (params.ip_country !== undefined || params.status !== undefined)
        ) {
          return errorResponse(
            "error: ip_country and status apply only to list_reserved_ips.",
          );
        }
        if (
          params.ip_address !== undefined &&
          !["create", "list", "move", "get_reserved_ip"].includes(params.action)
        ) {
          return errorResponse(
            "error: ip_address applies only to list, move, and get_reserved_ip; for create use config.ip_address.",
          );
        }
        switch (params.action) {
          case "create": {
            if (!params.type)
              return errorResponse("error: type is required for create.");
            if (params.ip_address !== undefined) {
              return errorResponse(
                "error: use config.ip_address to pin a new isp proxy to a reserved ip.",
              );
            }
            const { config } = params;
            if (config?.ip_address !== undefined && params.type !== "isp") {
              return errorResponse(
                "error: config.ip_address is supported only for isp proxies.",
              );
            }
            if (params.type === "custom" && (!config?.host || !config.port)) {
              return errorResponse(
                "error: config.host and config.port are required for custom proxy type.",
              );
            }
            const createParams: Parameters<typeof client.proxies.create>[0] = {
              type: params.type,
              ...(params.name && { name: params.name }),
              ...(config && { config }),
              ...(params.bypass_hosts !== undefined && {
                bypass_hosts: params.bypass_hosts,
              }),
              ...(params.protocol && { protocol: params.protocol }),
            };
            const proxy = await client.proxies.create(createParams);
            if (!proxy) return errorResponse("failed to create proxy");
            return jsonResponse(proxy);
          }
          case "list": {
            const page = await client.proxies.list({
              ...(params.name && { name: params.name }),
              ...(params.query && { query: params.query }),
              ...(params.ip_address !== undefined && {
                ip_address: params.ip_address,
              }),
              ...(params.limit !== undefined && { limit: params.limit }),
              ...(params.offset !== undefined && { offset: params.offset }),
            });
            return paginatedJsonResponse(page, {
              emptyText: "no proxies found",
            });
          }
          case "list_reserved_ips": {
            const page = await client.proxyIPs.list({
              ...(params.ip_country !== undefined && {
                country: params.ip_country,
              }),
              ...(params.status !== undefined && { status: params.status }),
              ...(params.limit !== undefined && { limit: params.limit }),
              ...(params.offset !== undefined && { offset: params.offset }),
            });
            return paginatedJsonResponse(page, {
              emptyText: "no reserved ips found",
            });
          }
          case "get_reserved_ip": {
            if (!params.ip_address) {
              return errorResponse(
                "error: ip_address is required for get_reserved_ip.",
              );
            }
            const reservedIP = await client.proxyIPs.retrieve(
              params.ip_address,
            );
            return jsonResponse(reservedIP);
          }
          case "get": {
            if (!idOrName) {
              return errorResponse("error: id_or_name is required for get.");
            }
            const proxy = await client.proxies.retrieve(idOrName);
            return jsonResponse(proxy);
          }
          case "rename": {
            if (!idOrName) {
              return errorResponse("error: id_or_name is required for rename.");
            }
            if (!params.name) {
              return errorResponse("error: name is required for rename.");
            }
            const proxy = await client.proxies.update(idOrName, {
              name: params.name,
            });
            return jsonResponse(proxy);
          }
          case "move": {
            if (!idOrName) {
              return errorResponse("error: id_or_name is required for move.");
            }
            if (!params.ip_address) {
              return errorResponse("error: ip_address is required for move.");
            }
            const proxy = await client.proxies.update(
              idOrName,
              { config: { ip_address: params.ip_address } },
              { maxRetries: 0, signal: ctx.mcpReq.signal },
            );
            return jsonResponse(proxy);
          }
          case "check": {
            if (!idOrName) {
              return errorResponse("error: id_or_name is required for check.");
            }
            const result = await client.proxies.check(
              idOrName,
              params.check_url ? { url: params.check_url } : undefined,
            );
            return jsonResponse(result);
          }
          case "delete": {
            if (!idOrName)
              return errorResponse("error: id_or_name is required for delete.");
            await client.proxies.delete(idOrName);
            return textResponse("proxy deleted successfully");
          }
        }
      } catch (error) {
        throwToolError("manage_proxies", params.action, error);
      }
    },
  );
}
