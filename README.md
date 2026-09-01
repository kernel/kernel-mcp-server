# Kernel MCP Server

[![MIT License](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org/)
[![Next.js](https://img.shields.io/badge/Next.js-15.3%2B-black.svg)](https://nextjs.org/)
[![smithery badge](https://smithery.ai/badge/kernel)](https://smithery.ai/server/kernel)

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that provides AI assistants with secure access to [Kernel platform](https://onkernel.com) tools and browser automation capabilities.

![Architecture Overview](public/architecture_overview.png)

🌐 **Use instantly** at `https://mcp.onkernel.com/mcp` — no installation required!

## What is this?

The Kernel MCP Server bridges AI assistants (like Claude, Cursor, fx, or other MCP-compatible tools) with the Kernel platform, enabling them to:

- 🚀 Deploy and manage Kernel apps in the cloud
- 🌐 Launch and control headless Chromium sessions for web automation
- 📊 Monitor deployments and track invocations
- 🔍 Search Kernel documentation and inject context
- 💻 Execute arbitrary Playwright code against live browsers
- 🎥 Record MP4 video replays of browser automation

**Open-source & fully-managed** — the complete codebase is available here, and we run the production instance so you don't need to deploy anything.

The server uses OAuth 2.0 authentication via [Clerk](https://clerk.com) to ensure secure access to your Kernel resources. During authorization, users can grant organization-wide access or restrict the resulting access and refresh tokens to one Kernel project. Project-scoped tokens cannot switch projects; organization-wide authorization remains available for existing workflows.

For a deeper dive into why and how we built this server, see our blog post: [Introducing Kernel MCP Server](https://blog.onkernel.com/p/introducing-kernel-mcp-server).

## Setup Instructions

### General (Transports)

- Streamable HTTP (recommended): `https://mcp.onkernel.com/mcp`
- stdio via `mcp-remote` (for clients without remote MCP support): `npx -y mcp-remote https://mcp.onkernel.com/mcp`

Use the streamable HTTP endpoint where supported for increased reliability. If your client does not support remote MCP, use `mcp-remote` over stdio.

Kernel's server is a centrally hosted, authenticated remote MCP using OAuth 2.1 with dynamic client registration.

## Quick Setup with Kernel CLI

The fastest way to configure the MCP server is using the [Kernel CLI](https://github.com/onkernel/cli):

```bash
# Install the CLI
brew install onkernel/tap/kernel
# or: npm install -g @onkernel/cli

# Install MCP for your tool
kernel mcp install --target <target>
```

### Supported Targets

| Target         | Command                                   |
| -------------- | ----------------------------------------- |
| Cursor         | `kernel mcp install --target cursor`      |
| Claude Desktop | `kernel mcp install --target claude`      |
| Claude Code    | `kernel mcp install --target claude-code` |
| VS Code        | `kernel mcp install --target vscode`      |
| Windsurf       | `kernel mcp install --target windsurf`    |
| Zed            | `kernel mcp install --target zed`         |
| Goose          | `kernel mcp install --target goose`       |
| fx             | `kernel mcp install --target fx`          |

The CLI automatically locates your tool's config file and adds the Kernel MCP server configuration.

## Connect in your client

### Claude

> Our remote MCP server is not compatible with the method Free users of Claude use to add MCP servers.

#### Pro, Max, Team & Enterprise (Claude.ai and Claude Desktop)

1. Go to **Settings → Connectors → Add custom connector**.
2. Enter: **Integration name:** `Kernel`, **Integration URL:** `https://mcp.onkernel.com/mcp`, then click **Add**.
3. In **Settings → Connectors**, click **Connect** next to `Kernel` to launch OAuth and approve.
4. In chat, click **Search and tools** and enable the Kernel tools if needed.

> On Claude for Work (Team/Enterprise), only Primary Owners or Owners can enable custom connectors for the org. After it's configured, each user still needs to go to **Settings → Connectors** and click **Connect** to authorize it for their account.

#### Claude Code CLI

```bash
claude mcp add --transport http kernel https://mcp.onkernel.com/mcp
# Then in the REPL run once to authenticate:
/mcp
```

### Cursor

### Automatic setup

[![Install MCP Server](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=Kernel&config=eyJ1cmwiOiAiaHR0cHM6Ly9tY3Aub25rZXJuZWwuY29tL21jcCJ9)

#### Manual setup

1. Press **⌘/Ctrl Shift J**.
2. Go to **MCP & Integrations → New MCP server**.
3. Add this configuration:

```json
{
  "mcpServers": {
    "kernel": {
      "url": "https://mcp.onkernel.com/mcp"
    }
  }
}
```

4. Save. The server will appear in Tools.

### OpenCode

Add the following to your `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "mcp": {
    "kernel": {
      "type": "remote",
      "url": "https://mcp.onkernel.com/mcp",
    },
  },
}
```

Then authenticate using the OpenCode CLI:

```bash
# Authenticate with Kernel
opencode mcp auth kernel

# If you need to re-authenticate, first logout then auth again
opencode mcp logout kernel
opencode mcp auth kernel
```

### fx

Configure Kernel with the Kernel CLI:

```bash
kernel mcp install --target fx
```

Or add Kernel to the `mcp` map in `~/.fx/mcp.json` manually:

```json
{
  "mcp": {
    "kernel": {
      "type": "http",
      "url": "https://mcp.onkernel.com/mcp",
      "oauth": {}
    }
  }
}
```

Start fx, or reload the configuration in an existing session:

```text
/mcp reload
```

Then authenticate with Kernel:

```text
/mcp auth kernel --open
```

Authorize access in the browser window that opens. Run `/mcp list` to verify that Kernel is connected.

### Goose

Click [here](goose://extension?cmd=npx&arg=-y&arg=mcp-remote&arg=https%3A%2F%2Fmcp.onkernel.com%2Fmcp&timeout=300&id=kernel&name=Kernel&description=Access%20Kernel%27s%20cloud-based%20browsers%20via%20MCP) to install Kernel on Goose in one click.

#### Goose Desktop

1. Click `Extensions` in the sidebar of the Goose Desktop.
2. Click `Add custom extension`.
3. On the `Add custom extension` modal, enter:
   - **Extension Name**: `Kernel`
   - **Type**: `STDIO`
   - **Description**: `Access Kernel's cloud-based browsers via MCP`
   - **Command**: `npx -y mcp-remote https://mcp.onkernel.com/mcp`
   - **Timeout**: `300`
4. Click `Save Changes` button.

#### Goose CLI

1. Run the following command:
   ```bash
   goose configure
   ```
2. Select `Add Extension` from the menu.
3. Choose `Command-line Extension`.
4. Follow the prompts:
   - **Extension name**: `Kernel`
   - **Command**: `npx -y mcp-remote https://mcp.onkernel.com/mcp`
   - **Timeout**: `300`
   - **Description**: `Access Kernel's cloud-based browsers via MCP`

### Visual Studio Code

```json
{
  "mcpServers": {
    "kernel": {
      "url": "https://mcp.onkernel.com/mcp",
      "type": "http"
    }
  }
}
```

1. Press **⌘/Ctrl P** → search **MCP: Add Server**.
2. Select **HTTP (HTTP or Server-Sent Events)**.
3. Enter: `https://mcp.onkernel.com/mcp`
4. Name the server **Kernel** → Enter.

### Windsurf

1. Press **⌘/Ctrl ,** to open settings.
2. Navigate **Cascade → MCP servers → View raw config**.
3. Paste:

```json
{
  "mcpServers": {
    "kernel": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mcp.onkernel.com/mcp"]
    }
  }
}
```

4. On **Manage MCPs**, click **Refresh** to load Kernel MCP.

### Zed

1. Press **⌘/Ctrl ,** to open settings.
2. Paste:

```json
{
  "context_servers": {
    "kernel": {
      "source": "custom",
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mcp.onkernel.com/mcp"]
    }
  }
}
```

### Smithery

You can connect directly to `https://mcp.onkernel.com/mcp`, or use Smithery as a proxy using its provided URL.

- Use Smithery URL in any MCP client:
  1. Open [Smithery: Kernel](https://smithery.ai/server/kernel).
  2. Copy the URL from "Get connection URL".
  3. Paste it into your MCP client's "Add server" flow.

- Use Kernel in Smithery's Playground MCP client:
  1. Open [Smithery Playground](https://smithery.ai/playground).
  2. Click "Add servers", search for "Kernel", and add it.
  3. Sign in and authorize Kernel when prompted.

### Others

Many other MCP-capable tools accept:

- **Command:** `npx`
- **Arguments:** `-y mcp-remote https://mcp.onkernel.com/mcp`

```json
{
  "kernel": {
    "command": "npx",
    "args": ["-y", "mcp-remote", "https://mcp.onkernel.com/mcp"]
  }
}
```

Configure these values wherever the tool expects MCP server settings.

## Tools (19 model-facing, plus 1 app-only helper)

Each Kernel feature has a single `manage_*` tool with an `action` parameter, keeping the tool set small and consistent. Standalone tools handle high-frequency and interactive workflows.

One additional Managed Auth helper (`begin_auth_login`) is marked app-only (`_meta.ui.visibility: ["app"]`); it refuses to execute on hosts that do not declare MCP Apps support. The App forwards the server-issued signed flow checkpoint to the shared `manage_auth_connections` `wait` action, so flow identity and terminal-state decisions stay on the server.

Self-hosted deployments can select tool families with `KERNEL_MCP_ENABLED_TOOLSETS` or hide them with `KERNEL_MCP_DISABLED_TOOLSETS`. Both accept comma- or space-separated toolset names and standalone aliases. For example, `KERNEL_MCP_ENABLED_TOOLSETS="playwright computer"` exposes browser-control tools without browser lifecycle or managed-auth tools, while `KERNEL_MCP_DISABLED_TOOLSETS=api_keys` only removes `manage_api_keys`. `get_connection_context` remains available in either mode.

Call `get_connection_context` before deciding whether to create or select a project. Its canonical `connection_scope` reports whether the connection is organization-wide or fixed to a project. Project-scoped tools advertise an optional `project` (name or ID) and a deprecated `project_id`: organization-wide connections may omit them to preserve organization-wide reads and API default-project behavior, while fixed-project connections may omit them or pass the matching project. Project resources use project-qualified `kernel://orgs/{organizationId}/projects/{projectId}/...` URIs. Authorization remains enforced by the Kernel API; selecting a project never grants access to it.

### manage\_\* tools

- `manage_browsers` - Create, update, list, get, and delete browser sessions, and read archived telemetry for active or deleted sessions. Supports headless/stealth modes, profiles, proxies, viewports, extensions, and SSH tunneling.
- `manage_profiles` - Setup (with guided live browser session), search/list with pagination, get, and delete browser profiles for persisting cookies and logins.
- `manage_projects` - Create, list, get, update, and delete organization projects. Inspect and update per-project resource limits.
- `manage_api_keys` - Create, list, get, update, and delete org-wide or project-scoped API keys. Create returns the plaintext key once.
- `manage_browser_pools` - Create, list, get, delete, and flush pools of pre-warmed browsers. Acquire and release browsers from pools.
- `manage_proxies` - Create, list, get, check, and delete proxy configurations (datacenter, ISP, residential, mobile, custom).
- `manage_replays` - Start, stop, and list MP4 video replay recordings for a browser session. Session-scoped: start once, run your automation, then stop. Requires a paid Kernel plan.
- `manage_extensions` - List and delete uploaded browser extensions.
- `manage_apps` - List/search apps, invoke actions, get/list/delete deployments, and get invocation results.
- `manage_auth_connections` - Create, list, get, update, delete, login, submit, inspect timelines, and wait for managed-auth connections in every client. Supports health-check and automatic re-auth settings, managed-auth browser configuration, and canonical interaction-bound field/choice submissions. Use domain-filtered `list` for discovery. App-capable clients additionally receive `open_auth_login`; the programmatic actions remain available there too.
- `manage_credentials` - Create, list, get, update, and delete stored credentials; fetch a current TOTP code for credentials with a configured totp_secret.
- `manage_credential_providers` - Create, list, get, update, and delete external credential providers (e.g. 1Password); list available items and test the provider connection.

### Standalone tools

- `get_connection_context` - Inspect the authenticated principal, organization, credential scope, and effective project scope.
- `computer_action` - Mouse, keyboard, clipboard, and screenshot controls for browser sessions (click, type, press_key, scroll, move, get_position, read_clipboard, write_clipboard, screenshot).
- `browser_curl` - Send HTTP requests through an existing browser session's Chrome network stack.
- `execute_playwright_code` - Execute Playwright/TypeScript code against an existing browser session. Does not create or delete browsers - use `manage_browsers` for session lifecycle.
- `exec_command` - Run shell commands inside a browser VM. Returns decoded stdout/stderr.
- `search_docs` - Search Kernel platform documentation and guides.
- `submit_feedback` - send product, mcp, or documentation feedback directly to the KERNEL team without interrupting the current task.
- `open_auth_login` - Open a secure interactive Managed Auth MCP App after user consent. Registered only for clients that declare MCP Apps support; credentials and MFA never enter MCP/model traffic.

## Resources

Project resources use the prefix `kernel://orgs/{organization_id}/projects/{project_id}`.

- `/browsers` and `/browsers/{session_id}` - List or access browser sessions
- `/browser-pools` and `/browser-pools/{id_or_name}` - List or access browser pools
- `/profiles` and `/profiles/{profile_name}` - List or access browser profiles
- `/apps` and `/apps/{app_name}` - List or access deployed apps

## Prompts

- `kernel-concepts` - Get explanations of Kernel's core concepts (browsers, apps, overview)
- `debug-browser-session` - Get a comprehensive debugging guide for troubleshooting browser sessions (VM issues, network problems, Chrome errors)

## Troubleshooting

- Cursor clean reset: ⌘/Ctrl Shift P → run `Cursor: Clear All MCP Tokens` (resets all MCP servers and auth; re-enable Kernel and re-authenticate).
- Clear saved auth and retry: `rm -rf ~/.mcp-auth`
- Ensure a recent Node.js version when using `npx mcp-remote`
- If behind strict networks, try stdio via `mcp-remote`, or explicitly set the transport your client supports

## Examples

### Invoke apps from anywhere

```
Human: Run my web-scraper app to get data from reddit.com
Assistant: I'll execute your web-scraper action with reddit.com as the target.
[Uses manage_apps tool with action: "invoke" to run your deployed app in the cloud]
```

### Execute Playwright code dynamically

```
Human: Go to example.com and get me the page title
Assistant: I'll create a browser session, then execute Playwright code against it to navigate to the site and retrieve the title.
[Uses manage_browsers tool with action: "create" to get a session_id]
[Uses execute_playwright_code tool with session_id and code: "await page.goto('https://example.com'); return await page.title();"]
Returns: { success: true, result: "Example Domain" }
```

### Use managed authentication for a protected site

1. Call `manage_auth_connections` with `action: "list"` and the exact `domain_filter`.
2. Fetch all pages. Reuse an authenticated connection; ask only when multiple relevant accounts match.
3. A direct request to log in is consent. If authentication is discovered incidentally, ask before opening the App.
4. For a new connection, choose a concise service-derived profile name unless the user supplied one; do not ask solely for a profile name.
5. Call `open_auth_login`, then immediately follow its `next_action` and repeat the read-only wait while it reports `pending`.
6. The user enters credentials/MFA only in the secure App. Once the wait reports `authenticated`, resume the original task with the verified `profile_name`.

Example: “Log me into my Hacker News account and update my profile to add a random emoji at the bottom.” The agent should discover `news.ycombinator.com`, open the App when needed, wait for authentication, then continue the profile edit without asking for credentials or a profile name in chat.

The secure App defaults `record_session` and `browser_telemetry.enabled` to `true`, recording replay video plus the operational telemetry categories (`control`, `connection`, `system`, and `captcha`) for managed-auth browser sessions. Callers can explicitly disable either setting. The programmatic `manage_auth_connections` create, update, and login actions pass browser telemetry through the API’s current nested `browser.telemetry` configuration while preserving defaults and inheritance when the MCP parameter is omitted.

### Set up browser profiles for authentication

```
Human: Set up a profile for my work accounts
Assistant: I'll create a profile and guide you through the setup process.
[Uses manage_profiles tool with action: "setup"]

Human: I'm done setting up my accounts
Assistant: Perfect! I'll close the browser session and save your profile.
[Uses manage_browsers tool with action: "delete" to save profile]
```

### Debug a browser session

> **Note:** Attach the `debug-browser-session` prompt to your conversation first, then ask for help debugging.

```
Human: [Attaches debug-browser-session prompt with session_id and issue_description]
       Help me debug this browser session.
Assistant: [Follows the debugging guide from the prompt: uses Kernel CLI to check session status,
            read VM logs, test network connectivity, and diagnose issues]
```

### Connect local dev server to cloud browser

This is perfect for AI coding workflows where you need to preview local changes in a real browser:

```
Human: I'm working on a React app running on localhost:3000. I want to test it in a cloud browser.
Assistant: I'll create a browser session with SSH port forwarding for you.
[Uses manage_browsers tool with action: "create" and remote_forward: "3000:localhost:3000"]
Returns: Session ID, live view URL, and SSH tunnel command.
```

## 🤝 Contributing

We welcome contributions! Please see our contributing guidelines:

1. **Fork the repository** and create your feature branch
2. **Make your changes** and add tests if applicable
3. **Run the linter and formatter**:
   ```bash
   bun run lint
   bun run format
   ```
4. **Test your changes** thoroughly
5. **Submit a pull request** with a clear description

### Development Guidelines

- Follow the existing code style and formatting
- Add TypeScript types for new functions and components
- Update documentation for any API changes
- Ensure all tests pass before submitting
- Run the required [OAuth conformance suite](docs/oauth-conformance.md) when changing discovery, registration, authorization, token exchange, refresh, or scope enforcement

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🔗 Related Projects

- [Model Context Protocol](https://modelcontextprotocol.io/) - The protocol specification
- [Kernel Platform](https://onkernel.com) - The platform this server integrates with
- [Clerk](https://clerk.com) - Authentication provider
- [@onkernel/sdk](https://www.npmjs.com/package/@onkernel/sdk) - Kernel JavaScript SDK

## 💬 Support

- **Issues & Bugs**: [GitHub Issues](https://github.com/onkernel/kernel-mcp-server/issues)
- **MCP Feedback**: [github.com/kernelxyz/mcp-feedback](https://github.com/kernelxyz/mcp-feedback)
- **Documentation**: [Kernel Docs](https://onkernel.com/docs) • [MCP Setup Guide](https://onkernel.com/docs/mcp-server)
- **Community**: [Kernel Discord](https://discord.gg/FBrveQRcud)

---

Built with ❤️ by the [Kernel Team](https://kernel.so)

# Running this server locally

```bash
cp .env .env.local # Values for the .env.local file are in 1Password > DevEnvVars > MCP section
bun install
bun run dev
```

This will start the server on port 3002.
