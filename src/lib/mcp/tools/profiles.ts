import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createKernelClient, type KernelClient } from "@/lib/mcp/kernel-client";
import { registerJsonResourceTemplate } from "@/lib/mcp/resource-templates";
import {
  errorMessage,
  jsonResponse,
  paginatedJsonResponse,
  textResponse,
} from "@/lib/mcp/responses";

type ProfileListParams = NonNullable<
  Parameters<KernelClient["profiles"]["list"]>[0]
>;

async function listProfiles(client: KernelClient, query?: ProfileListParams) {
  const profiles: Awaited<ReturnType<typeof client.profiles.retrieve>>[] = [];
  for await (const profile of client.profiles.list(query)) {
    profiles.push(profile);
  }
  return profiles;
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
    'Manage browser profiles that persist cookies, logins, and session data across browser sessions. Use action "setup" to create/update a profile with a guided live browser session, "list" to search profiles with pagination, "get" to retrieve one, or "delete" to remove one.',
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
      limit: z.number().describe("(list) Max results per page.").optional(),
      offset: z.number().describe("(list) Pagination offset.").optional(),
    },
    async (params, extra) => {
      if (!extra.authInfo) throw new Error("Authentication required");
      const client = createKernelClient(extra.authInfo.token);

      try {
        switch (params.action) {
          case "setup": {
            if (!params.profile_name)
              return textResponse("Error: profile_name is required for setup.");
            const existingProfiles = await listProfiles(client, {
              query: params.profile_name,
            });
            const existingProfile = existingProfiles?.find(
              (p) => p.name === params.profile_name,
            );
            let profile;
            let isNewProfile = false;

            if (existingProfile) {
              if (!params.update_existing) {
                return textResponse(
                  `Profile "${params.profile_name}" already exists (ID: ${existingProfile.id}). Set update_existing: true to update it, or choose a different name.`,
                );
              }
              profile = existingProfile;
            } else {
              profile = await client.profiles.create({
                name: params.profile_name,
              });
              if (!profile) return textResponse("Failed to create profile");
              isNewProfile = true;
            }

            const browser = await client.browsers.create({
              stealth: true,
              timeout_seconds: 300,
              profile: { name: params.profile_name, save_changes: true },
            });
            if (!browser)
              return textResponse("Failed to create browser for profile setup");

            return textResponse(
              `Profile "${params.profile_name}" ${isNewProfile ? "created" : "loaded for update"}.\n\n` +
                `**Setup:** Open ${browser.browser_live_view_url} and sign into accounts to save.\n` +
                `**When done:** Use manage_browsers with action "delete" and session_id "${browser.session_id}" to save the profile.\n\n` +
                `Profile ID: ${profile.id} | Session ID: ${browser.session_id}`,
            );
          }
          case "list": {
            const page = await client.profiles.list({
              ...(params.query && { query: params.query }),
              ...(params.limit !== undefined && { limit: params.limit }),
              ...(params.offset !== undefined && { offset: params.offset }),
            });
            return paginatedJsonResponse(
              page,
              "No profiles found. Use manage_profiles with action 'setup' to create one.",
            );
          }
          case "get": {
            if (params.profile_name && params.profile_id) {
              return textResponse(
                "Error: Cannot specify both profile_name and profile_id.",
              );
            }
            const identifier = params.profile_name || params.profile_id;
            if (!identifier) {
              return textResponse(
                "Error: profile_name or profile_id is required for get.",
              );
            }
            const profile = await client.profiles.retrieve(identifier);
            return jsonResponse(profile);
          }
          case "delete": {
            if (params.profile_name && params.profile_id) {
              return textResponse(
                "Error: Cannot specify both profile_name and profile_id.",
              );
            }
            const identifier = params.profile_name || params.profile_id;
            if (!identifier)
              return textResponse(
                "Error: profile_name or profile_id is required for delete.",
              );
            await client.profiles.delete(identifier);
            return textResponse(
              `Profile "${identifier}" deleted successfully.`,
            );
          }
        }
      } catch (error) {
        return textResponse(
          `Error in manage_profiles (${params.action}): ${errorMessage(error)}`,
        );
      }
    },
  );
}
