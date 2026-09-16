import { description } from "../../../server.json";

/**
 * Returned on `initialize` as the server's `instructions`. Hosts surface this
 * to the model, so it answers what an agent can accomplish here and when to
 * reach for it, rather than describing the infrastructure underneath.
 *
 * The registry `description` in server.json is capped at 100 characters by the
 * MCP server schema, so the longer framing has to live here.
 */
export const MCP_SERVER_INSTRUCTIONS = `${description}

Kernel runs real Chrome browsers in the cloud. Reach for it when the task is on a website: navigating a site, acting inside an authenticated account, filling and submitting forms, uploading or downloading files, or driving a page that offers no other interface. When a purpose-built integration covers the same task, use that instead.

Once a session exists, try these in order and stop at the first one that works:

1. webmcp: tools the site itself exposes to agents. Fastest and least brittle where a site provides them.
2. execute_playwright_code: structured DOM interaction.
3. computer_action: visual control, for pages the DOM cannot drive.

Create sessions with manage_browsers and delete them when finished. Set timeout_seconds so an abandoned session cleans itself up.`;
