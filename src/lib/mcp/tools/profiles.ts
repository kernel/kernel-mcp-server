import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createKernelClient, type KernelClient } from "@/lib/mcp/kernel-client";
import { registerJsonResourceTemplate } from "@/lib/mcp/resource-templates";
import {
  errorResponse,
  itemsJsonResponse,
  jsonResponse,
  paginatedJsonResponse,
  textResponse,
  toolErrorResponse,
} from "@/lib/mcp/responses";
import { paginationParams } from "@/lib/mcp/schemas";

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

function fullProfileListResponse(profiles: Profile[]) {
  return itemsJsonResponse(profiles, {
    has_more: false,
    next_offset: null,
    emptyText:
      "No profiles found. Use manage_profiles with action 'setup' to create one.",
  });
}

export function registerProfileCapabilities(server: McpServer) {
  server.resource("profiles", "profiles://", async (uri, extra) => {
    if (!extra.authInfo) {
      throw new Error("Authentication required");
    }

    const client = createKernelClient(extra.authInfo.token);
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

  registerJsonResourceTemplate(server, {
    name: "profile",
    uriTemplate: "profiles://{profileName}",
    variableName: "profileName",
    resourceLabel: "Profile",
    read: (client, profileName) => client.profiles.retrieve(profileName),
  });

  server.tool(
    "manage_profiles",
    'Manage browser profiles when an agent needs persistent cookies, login state, or reusable browser state. Use "setup" for a guided login session, "list" to find a profile, "get" to retrieve one, and "delete" only when a profile should be removed.',
    {
      action: z
        .enum(["setup", "list", "get", "delete"])
        .describe("Operation to perform."),
      profile_name: z
        .string()
        .describe("(setup, get, delete) Profile name. For setup: 1-255 chars.")
        .optional(),
      profile_id: z
        .string()
        .describe("(get, delete) Profile ID. Alternative to profile_name.")
        .optional(),
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
      const client = createKernelClient(extra.authInfo.token);

      try {
        switch (params.action) {
          case "setup": {
            if (!params.profile_name)
              return errorResponse(
                "Error: profile_name is required for setup.",
              );
            // Scan all profiles for an exact name match: the list `query` is a
            // search and may not reliably return an exact-named profile, which
            // would let setup create a duplicate.
            const existingProfiles = await listProfiles(client);
            const existingProfile = existingProfiles?.find(
              (p) => p.name === params.profile_name,
            );
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
              profile: { name: params.profile_name, save_changes: true },
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
              return fullProfileListResponse(profiles);
            }

            const page = await client.profiles.list({
              ...(params.query && { query: params.query }),
              ...(params.limit !== undefined && { limit: params.limit }),
              ...(params.offset !== undefined && { offset: params.offset }),
            } satisfies ProfileListParams);
            return paginatedJsonResponse(page);
          }
          case "get": {
            if (params.profile_name && params.profile_id) {
              return errorResponse(
                "Error: Cannot specify both profile_name and profile_id.",
              );
            }
            const identifier = params.profile_name || params.profile_id;
            if (!identifier) {
              return errorResponse(
                "Error: profile_name or profile_id is required for get.",
              );
            }
            const profile = await client.profiles.retrieve(identifier);
            return jsonResponse(profile);
          }
          case "delete": {
            if (params.profile_name && params.profile_id) {
              return errorResponse(
                "Error: Cannot specify both profile_name and profile_id.",
              );
            }
            const identifier = params.profile_name || params.profile_id;
            if (!identifier)
              return errorResponse(
                "Error: profile_name or profile_id is required for delete.",
              );
            await client.profiles.delete(identifier);
            return textResponse(
              `Profile "${identifier}" deleted successfully.`,
            );
          }
        }
      } catch (error) {
        return toolErrorResponse("manage_profiles", params.action, error);
      }
    },
  );
}
