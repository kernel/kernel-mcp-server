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

KERNEL runs real chromium browsers in the cloud. reach for it when the task is on a website: navigating a site, acting inside an authenticated account, filling and submitting forms, uploading or downloading files, or driving a page that offers no other interface. when a purpose-built integration covers the same task, use that instead.

for each step, prefer these layers in order. move to the next when the current one is unavailable or insufficient:

1. webmcp: tools the site itself exposes to agents. prefer this where available, because the site defines the action contract rather than you inferring it from the dom.
2. execute_playwright_code: structured dom interaction.
3. computer_action: visual control, for pages the dom cannot drive.

a single task can mix layers. an \`awaiting_submission\` result from webmcp, for example, populates a form and then needs one of the other two to submit it.

create sessions with manage_browsers and delete them when finished. set timeout_seconds so an abandoned session cleans itself up.`;
