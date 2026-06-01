import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createKernelClient, type KernelClient } from "@/lib/mcp/kernel-client";
import { registerJsonResourceTemplate } from "@/lib/mcp/resource-templates";

async function listProfiles(client: KernelClient) {
  const profiles: Awaited<ReturnType<typeof client.profiles.retrieve>>[] = [];
  for await (const profile of client.profiles.list()) {
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
    'Manage browser profiles that persist cookies, logins, and session data across browser sessions. Use action "setup" to create/update a profile with a guided live browser session, "list" to see all profiles, or "delete" to remove one.',
    {
      action: z
        .enum(["setup", "list", "delete"])
        .describe("Operation to perform."),
      profile_name: z
        .string()
        .describe(
          "(setup, delete) Profile name. For setup: 1-255 chars. For delete: name of profile to remove.",
        )
        .optional(),
      profile_id: z
        .string()
        .describe("(delete) Profile ID to delete. Alternative to profile_name.")
        .optional(),
      update_existing: z
        .boolean()
        .describe("(setup) If true, update existing profile. Default false.")
        .optional(),
    },
    async (params, extra) => {
      if (!extra.authInfo) throw new Error("Authentication required");
      const client = createKernelClient(extra.authInfo.token);

      try {
        switch (params.action) {
          case "setup": {
            if (!params.profile_name)
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: profile_name is required for setup.",
                  },
                ],
              };
            const existingProfiles = await listProfiles(client);
            const existingProfile = existingProfiles?.find(
              (p) => p.name === params.profile_name,
            );
            let profile;
            let isNewProfile = false;

            if (existingProfile) {
              if (!params.update_existing) {
                return {
                  content: [
                    {
                      type: "text",
                      text: `Profile "${params.profile_name}" already exists (ID: ${existingProfile.id}). Set update_existing: true to update it, or choose a different name.`,
                    },
                  ],
                };
              }
              profile = existingProfile;
            } else {
              profile = await client.profiles.create({
                name: params.profile_name,
              });
              if (!profile)
                return {
                  content: [{ type: "text", text: "Failed to create profile" }],
                };
              isNewProfile = true;
            }

            const browser = await client.browsers.create({
              stealth: true,
              timeout_seconds: 300,
              profile: { name: params.profile_name, save_changes: true },
            });
            if (!browser)
              return {
                content: [
                  {
                    type: "text",
                    text: "Failed to create browser for profile setup",
                  },
                ],
              };

            return {
              content: [
                {
                  type: "text",
                  text:
                    `Profile "${params.profile_name}" ${isNewProfile ? "created" : "loaded for update"}.\n\n` +
                    `**Setup:** Open ${browser.browser_live_view_url} and sign into accounts to save.\n` +
                    `**When done:** Use manage_browsers with action "delete" and session_id "${browser.session_id}" to save the profile.\n\n` +
                    `Profile ID: ${profile.id} | Session ID: ${browser.session_id}`,
                },
              ],
            };
          }
          case "list": {
            const profiles = await listProfiles(client);
            return {
              content: [
                {
                  type: "text",
                  text:
                    profiles?.length > 0
                      ? JSON.stringify(profiles, null, 2)
                      : "No profiles found. Use manage_profiles with action 'setup' to create one.",
                },
              ],
            };
          }
          case "delete": {
            if (params.profile_name && params.profile_id) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: Cannot specify both profile_name and profile_id.",
                  },
                ],
              };
            }
            const identifier = params.profile_name || params.profile_id;
            if (!identifier)
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: profile_name or profile_id is required for delete.",
                  },
                ],
              };
            await client.profiles.delete(identifier);
            return {
              content: [
                {
                  type: "text",
                  text: `Profile "${identifier}" deleted successfully.`,
                },
              ],
            };
          }
        }
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error in manage_profiles (${params.action}): ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  );
}
