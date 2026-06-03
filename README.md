# Kernel MCP Server

[![MIT License](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org/)
[![Next.js](https://img.shields.io/badge/Next.js-15.3%2B-black.svg)](https://nextjs.org/)
[![smithery badge](https://smithery.ai/badge/kernel)](https://smithery.ai/server/kernel)

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that provides AI assistants with secure access to [Kernel platform](https://onkernel.com) tools and browser automation capabilities.

![Architecture Overview](public/architecture_overview.png)

🌐 **Use instantly** at `https://mcp.onkernel.com/mcp` — no installation required!

## What is this?

The Kernel MCP Server bridges AI assistants (like Claude, Cursor, or other MCP-compatible tools) with the Kernel platform, enabling them to:

- 🚀 Deploy and manage Kernel apps in the cloud
- 🌐 Launch and control headless Chromium sessions for web automation
- 📊 Monitor deployments and track invocations
- 🔍 Search Kernel documentation and inject context
- 💻 Execute arbitrary Playwright code against live browsers
- 🎥 Automatically record video replays of browser automation

**Open-source & fully-managed** — the complete codebase is available here, and we run the production instance so you don't need to deploy anything.

The server uses OAuth 2.0 authentication via [Clerk](https://clerk.com) to ensure secure access to your Kernel resources.

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

## Tools (16 total)

Each Kernel feature has a single `manage_*` tool with an `action` parameter, keeping the tool set small and consistent. Five standalone tools handle high-frequency workflows.

Self-hosted deployments can hide sensitive tool families by setting `KERNEL_MCP_DISABLED_TOOLSETS` to a comma-separated list. For example, `KERNEL_MCP_DISABLED_TOOLSETS=api_keys` prevents `manage_api_keys` from being registered.

### manage\_\* tools

- `manage_browsers` - Create, list, get, and delete browser sessions. Supports headless/stealth modes, profiles, proxies, viewports, extensions, and SSH tunneling.
- `manage_profiles` - Setup (with guided live browser session), list, and delete browser profiles for persisting cookies and logins.
- `manage_browser_pools` - Create, list, get, delete, and flush pools of pre-warmed browsers. Acquire and release browsers from pools.
- `manage_proxies` - Create, list, and delete proxy configurations (datacenter, ISP, residential, mobile, custom).
- `manage_extensions` - List and delete uploaded browser extensions.
- `manage_apps` - List apps, invoke actions, get/list deployments, and get invocation results.
- `manage_projects` - Create, list, get, update, and delete organization projects.
- `manage_api_keys` - Create, list, get, update, and delete Kernel API keys. Create returns the plaintext key once.
- `manage_auth_connections` - Create, list, get, delete managed auth connections; start login flows (returns a hosted URL and live view); submit MFA codes or SSO selections.
- `manage_credentials` - Create, list, get, update, and delete stored credentials; fetch a current TOTP code for credentials with a configured totp_secret.
- `manage_credential_providers` - Create, list, get, update, and delete external credential providers (e.g. 1Password); list available items and test the provider connection.

### Standalone tools

- `computer_action` - Mouse, keyboard, clipboard, and screenshot controls for browser sessions (click, type, press_key, scroll, move, get_position, read_clipboard, write_clipboard, screenshot).
- `browser_curl` - Send HTTP requests through an existing browser session's Chrome network stack.
- `execute_playwright_code` - Execute Playwright/TypeScript code against a browser with automatic video replay and cleanup.
- `exec_command` - Run shell commands inside a browser VM. Returns decoded stdout/stderr.
- `search_docs` - Search Kernel platform documentation and guides.

## Resources

- `browsers://` - List browser sessions
- `browser-pools://` - List browser pools
- `profiles://` - List browser profiles
- `apps://` - List deployed apps
- `browsers://{session_id}` - Access one browser session
- `browser-pools://{id_or_name}` - Access one browser pool
- `profiles://{profile_name}` - Access one browser profile
- `apps://{app_name}` - Access one deployed app

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
Assistant: I'll execute Playwright code to navigate to the site and retrieve the title.
[Uses execute_playwright_code tool with code: "await page.goto('https://example.com'); return await page.title();"]
Returns: { success: true, result: "Example Domain", replay_url: "https://..." }
```

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
