import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  defaultMcpDependencies,
  type McpDependencies,
} from "@/lib/mcp/dependencies";
import type { KernelClient } from "@/lib/mcp/kernel-client";
import { registerJsonResourceTemplate } from "@/lib/mcp/resource-templates";
import {
  errorResponse,
  itemsJsonResponse,
  jsonResponse,
  paginatedJsonResponse,
  textResponse,
  throwToolError,
} from "@/lib/mcp/responses";
import { paginationParams } from "@/lib/mcp/schemas";
import {
  projectSelectionInputSchema,
  type ProjectSelectionOptions,
} from "@/lib/mcp/project-selection";

type ProfileListParams = NonNullable<
  Parameters<KernelClient["profiles"]["list"]>[0]
>;
type Profile = Awaited<ReturnType<KernelClient["profiles"]["retrieve"]>>;

async function listProfiles(client: KernelClient, query?: ProfileListParams) {
  const profiles: Profile[] = [];
  for await (const profile of client.profiles.list(query)) {
    profiles.push(profile);
  }
  return profiles;
}

function fullProfileListResponse(profiles: Profile[], query?: string) {
  return itemsJsonResponse(profiles, {
    has_more: false,
    next_offset: null,
    // A search that matches nothing shouldn't claim the inventory is empty or
    // suggest setup — other profiles may exist that just don't match the query.
    emptyText: query
      ? `No profiles match "${query}".`
      : "No profiles found. Use manage_profiles with action 'setup' to create one.",
  });
}

function requireProfileIdentifier(
  params: { profile_name?: string; profile_id?: string },
  action: "get" | "rename" | "delete",
) {
  if (params.profile_name && params.profile_id) {
    return {
      ok: false as const,
      error: "Error: Cannot specify both profile_name and profile_id.",
    };
  }

  const identifier = params.profile_name || params.profile_id;
  if (!identifier) {
    return {
      ok: false as const,
      error: `Error: profile_name or profile_id is required for ${action}.`,
    };
  }

  return { ok: true as const, value: identifier };
}

export function registerProfileCapabilities(
  server: McpServer,
  options: ProjectSelectionOptions & McpDependencies = {
    ...defaultMcpDependencies,
  },
) {
  server.resource("profiles", "profiles://", async (uri, extra) => {
    if (!extra.authInfo) {
      throw new Error("Authentication required");
    }

    const client = options.createKernelClient(extra.authInfo.token);
    const profiles = await listProfiles(client);
    return {
      contents: [
        {
          uri: uri.toString(),
          mimeType: "application/json",
          text:
            profiles.length > 0
              ? JSON.stringify(profiles, null, 2)
              : "No profiles found",
        },
      ],
    };
  });

  registerJsonResourceTemplate(
    server,
    {
      name: "profile",
      uriTemplate: "profiles://{profileName}",
      variableName: "profileName",
      resourceLabel: "Profile",
      read: (client, profileName) => client.profiles.retrieve(profileName),
    },
    options,
  );

  server.tool(
    "manage_profiles",
    'Manage browser profiles when an agent needs persistent cookies, login state, or reusable browser state. Use "setup" for a guided login session, "list" to find a profile, "get" to retrieve one, "rename" to change its name, and "delete" only when a profile should be removed. Do not rename a profile while a browser is using it because that session may no longer save changes back to the profile.',
    {
      ...projectSelectionInputSchema(options.projectSelection),
      action: z
        .enum(["setup", "list", "get", "rename", "delete"])
        .describe("Operation to perform."),
      profile_name: z
        .string()
        .describe(
          "(setup, get, rename, delete) Profile name. For setup: 1-255 chars.",
        )
        .optional(),
      profile_id: z
        .string()
        .describe(
          "(get, rename, delete) Profile ID. Alternative to profile_name.",
        )
        .optional(),
      new_name: z.string().describe("(rename) New profile name.").optional(),
      update_existing: z
        .boolean()
        .describe("(setup) If true, update existing profile. Default false.")
        .optional(),
      query: z
        .string()
        .describe("(list) Search profiles by name or ID.")
        .optional(),
      ...paginationParams,
    },
    {
      title: "Manage Kernel browser profiles",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    async (params, extra) => {
      if (!extra.authInfo) throw new Error("Authentication required");
      const client = options.createKernelClient(
        extra.authInfo.token,
        params.project_id,
      );

      try {
        switch (params.action) {
          case "setup": {
            if (!params.profile_name)
              return errorResponse(
                "Error: profile_name is required for setup.",
              );
            const existingProfiles = await listProfiles(client, {
              name: params.profile_name,
            });
            if (existingProfiles.length > 1) {
              const matches = existingProfiles
                .map((profile) => `${profile.name} (ID: ${profile.id})`)
                .join(", ");
              return errorResponse(
                `Error: multiple profiles match the exact name "${params.profile_name}": ${matches}. Rename or delete duplicate profiles by ID, then retry setup.`,
              );
            }
            const existingProfile = existingProfiles[0];
            if (!existingProfile && params.update_existing) {
              return errorResponse(
                `Error: profile "${params.profile_name}" does not exist. Omit update_existing to create it.`,
              );
            }
            let profile;
            let isNewProfile = false;

            if (existingProfile) {
              if (!params.update_existing) {
                return errorResponse(
                  `Profile "${params.profile_name}" already exists (ID: ${existingProfile.id}). Set update_existing: true to update it, or choose a different name.`,
                );
              }
              profile = existingProfile;
            } else {
              profile = await client.profiles.create({
                name: params.profile_name,
              });
              if (!profile) return errorResponse("Failed to create profile");
              isNewProfile = true;
            }

            const browser = await client.browsers.create({
              stealth: true,
              timeout_seconds: 300,
              profile: { id: profile.id, save_changes: true },
            });
            if (!browser)
              return errorResponse(
                "Failed to create browser for profile setup",
              );

            return textResponse(
              `Profile "${params.profile_name}" ${isNewProfile ? "created" : "loaded for update"}.\n\n` +
                `**Setup:** Open ${browser.browser_live_view_url} and sign into accounts to save.\n` +
                `**When done:** Use manage_browsers with action "delete" and session_id "${browser.session_id}" to save the profile.\n\n` +
                `Profile ID: ${profile.id} | Session ID: ${browser.session_id}`,
            );
          }
          case "list": {
            if (params.limit === undefined && params.offset === undefined) {
              const profiles = await listProfiles(
                client,
                params.query ? { query: params.query } : undefined,
              );
              return fullProfileListResponse(profiles, params.query);
            }

            const page = await client.profiles.list({
              ...(params.query && { query: params.query }),
              ...(params.limit !== undefined && { limit: params.limit }),
              ...(params.offset !== undefined && { offset: params.offset }),
            } satisfies ProfileListParams);
            // On the first page of a search with no results, note the empty
            // match so agents can tell a failed search from an empty org. Skip
            // it past offset 0, where an empty page may just be beyond the
            // matches rather than a true miss.
            const emptySearch =
              params.query &&
              !params.offset &&
              page.getPaginatedItems().length === 0;
            return paginatedJsonResponse(
              page,
              emptySearch
                ? { note: `No profiles match "${params.query}".` }
                : {},
            );
          }
          case "get": {
            const identifier = requireProfileIdentifier(params, "get");
            if (!identifier.ok) return errorResponse(identifier.error);
            const profile = await client.profiles.retrieve(identifier.value);
            return jsonResponse(profile);
          }
          case "rename": {
            const identifier = requireProfileIdentifier(params, "rename");
            if (!identifier.ok) return errorResponse(identifier.error);
            if (!params.new_name) {
              return errorResponse("Error: new_name is required for rename.");
            }
            const profile = await client.profiles.update(identifier.value, {
              name: params.new_name,
            });
            return jsonResponse(profile);
          }
          case "delete": {
            const identifier = requireProfileIdentifier(params, "delete");
            if (!identifier.ok) return errorResponse(identifier.error);
            await client.profiles.delete(identifier.value);
            return textResponse(
              `Profile "${identifier.value}" deleted successfully.`,
            );
          }
        }
      } catch (error) {
        throwToolError("manage_profiles", params.action, error);
      }
    },
  );
}
