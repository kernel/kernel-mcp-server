# MCP Apps: browser live view and managed authentication

## Managed Auth App

The managed-auth flow is discovery-first and fail-closed:

```text
manage_auth_connections(action="list", domain_filter=...)
  -> ask the user to choose/consent
  -> open_auth_login(...)
  -> agent immediately starts manage_auth_connections(action="wait")
  -> user clicks Continue in the App
  -> begin_auth_login (app-only)
  -> bundled KernelManagedAuth uses the scoped relay
  -> App publishes verified status with ui/update-model-context
  -> read-only wait returns authenticated
  -> agent continues the pending task automatically
```

`open_auth_login` does not create a connection or flow until the user clicks Continue. The
single-file `ui://kernel/managed-auth-login-v7.html` resource bundles
`@onkernel/managed-auth-react`; it never iframes the hosted page. Passwords, MFA values,
managed-auth JWTs, and the Kernel/MCP bearer token never pass through tool calls. The handoff
code and hosted fallback URL exist only in the app-only `begin_auth_login` result (`_meta`,
duplicated into `structuredContent.app_private` because some hosts strip tool-result `_meta`).
App-only tools fail closed: `begin_auth_login`, `get_auth_login_status`, and
`delete_auth_login_connection` execute only when the connected client declared the
`io.modelcontextprotocol/ui` extension during initialize, so on hosts without MCP Apps
support the model cannot call them to bypass user consent or pull App-private material into
its context. The delete-authorizing `app_capability` is likewise issued only to
MCP Apps-capable clients and travels only in the launcher result `_meta`.
Because the streamable-HTTP transport is stateless (one `McpServer` per request), the route
layer (`src/app/[transport]/route.ts`) observes each `initialize` body and records the
declared capability per bearer token in Redis (sliding TTL, bound to the token lifetime for
OAuth tokens); persistent SSE transports are checked directly through the SDK server.
The component sends credential input directly to `/managed-auth-proxy`, which accepts only
exchange, retrieve, submit, and events paths and forwards only managed-auth scoped JWTs.

The bundled App resource is byte-checked in CI (`bun run check:managed-auth-app`) and Bun's
minifier output can change between releases, so CI pins Bun (see `.github/workflows/ci.yml`).
Regenerate the bundle with that exact Bun version after editing
`src/lib/mcp/apps/managed-auth-entry.tsx`: `bun run build:managed-auth-app`.

For clients without Apps, first confirm that no panel appeared, then call `open_auth_login`
with `text_only: true`. This explicit compatibility exception places the full hosted URL
(including its embedded handoff capability) in user-audience text. It never emits a separate
`handoff_code`, and the agent must run the same read-only wait instead of treating URL creation
as successful authentication. The wait is guarded by the pre-flow `previous_flow_expires_at`
baseline captured at begin time, and a connection that is `AUTHENTICATED` while a flow is
still `IN_PROGRESS` reads as pending — stale pre-flow state is never accepted as the result
of a re-auth.

Local QA:

```bash
MANAGED_AUTH_APP_ORIGIN=http://localhost:3002 bun run dev
KERNEL_API_KEY=sk_... bun scripts/mcp-apps-proxy.ts
# Open http://localhost:3003/qa/auth, or:
bun scripts/qa-harness-test.mjs --auth
```

The QA host intentionally logs only app tool names, never app-private tool results or hosted
URLs. Delete the test connection with the harness cleanup button.

## Embedded browser live view

Prototype of [MCP Apps (SEP-1865)](https://apps.extensions.modelcontextprotocol.io/) in the
Kernel MCP server: when an agent spins up a Kernel browser, it can render an **embedded,
read-only view** of that browser inline in the chat (auto-refreshing snapshots), so the user
watches the automation happen in real time. The full interactive live view is one click away
via `ui/open-link`.

## What was added

| File                                 | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/mcp/tools/live-view-app.ts` | The MCP App: a `ui://kernel/live-view.html` resource (`text/html;profile=mcp-app`) + a `show_browser_live_view` tool linked to it via `_meta.ui.resourceUri`. The view speaks raw postMessage JSON-RPC per the spec and renders read-only snapshots by polling the app-only `capture_live_view_frame` tool through the host.                                                                                                                                                                                   |
| `src/lib/mcp/register.ts`            | Registers the new `live_view_app` toolset.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `src/lib/mcp/tools/browsers.ts`      | `manage_browsers` create/update responses now hint the agent to call `show_browser_live_view` right after creating a session.                                                                                                                                                                                                                                                                                                                                                                                  |
| `scripts/mcp-apps-proxy.ts`          | Dev-only reverse proxy (port 3003) that injects `Authorization: Bearer $KERNEL_API_KEY` so Claude's custom connectors (which can't send static bearer tokens) can use the server as a "no auth" connector. It also 404s the server's OAuth surface (`/.well-known/*`, `/register`, `/authorize`, `/token`) — otherwise Claude discovers it and attempts dynamic client registration against the dummy Clerk config, failing with "Couldn't register with … sign-in service". Also serves a `/qa` harness page. |
| `scripts/qa-harness-test.mjs`        | Playwright smoke test that drives the `/qa` harness end to end.                                                                                                                                                                                                                                                                                                                                                                                                                                                |

How it works (per the spec):

1. `tools/list` exposes `show_browser_live_view` with `_meta.ui.resourceUri: "ui://kernel/live-view.html"`.
2. When the agent calls the tool, an MCP Apps-capable host fetches the resource via
   `resources/read` and renders the HTML in a sandboxed iframe.
3. The view does the `ui/initialize` → `ui/notifications/initialized` handshake and receives
   the tool result (`session_id` + live view URLs) via `ui/notifications/tool-result`.
4. The view then polls the app-only `capture_live_view_frame` tool through the host
   (`tools/call` over postMessage) every ~2.5s and swaps the returned PNG frames into an
   `<img>` as `data:` URIs.
5. **No nested iframe, no external origins**: the spec's restrictive default CSP is enough.
   We deliberately don't iframe the real live view — Claude blocks third-party `frameDomains`
   pending security review, and snapshots work identically in every host.
6. Hosts without MCP Apps support just see the URLs as text — graceful fallback.

## Running the stack locally

Three processes:

```bash
# 1. The MCP server (port 3002). .env.local only needs format-valid dummy Clerk
#    values — the API-key auth path never touches Clerk/Redis.
bun run dev

# 2. The auth-injecting proxy (port 3003 -> 3002)
KERNEL_API_KEY=sk_... bun scripts/mcp-apps-proxy.ts

# 3. The tunnel (points at the PROXY, not the server)
ngrok http --url=raf-kernel-mcp-server.ngrok.app 3003
```

MCP endpoint: `https://raf-kernel-mcp-server.ngrok.app/mcp`

> ⚠️ **Security**: anyone with the tunnel URL gets your Kernel account (the proxy injects your
> API key on every request). Tear the tunnel down when you're done. Never point the proxy at a
> production deployment.

## Adding to Claude (Desktop or claude.ai)

Requires a plan with custom connectors (Pro/Max/Team) and a recent Claude version with MCP
Apps support.

1. **Settings → Connectors → Add custom connector**
2. Name: `Kernel (dev)`, URL: `https://raf-kernel-mcp-server.ngrok.app/mcp` → **Add**.
   No OAuth/Connect prompt should appear (the proxy handles auth and hides the OAuth
   discovery endpoints); the connector should be immediately usable.
3. In a chat, open **Search and tools** and make sure the Kernel tools are enabled.

If you previously added the connector and got _"Couldn't register with … sign-in service"_,
**remove the connector and re-add it** — Claude caches the discovered OAuth metadata from
the first attempt.

## QA script (Claude)

1. Prompt: _"Create a Kernel browser and show me its live view, then go to
   news.ycombinator.com and tell me the top story."_
2. Expect the agent to call `manage_browsers` (create) → `show_browser_live_view` → the app
   renders inline: header "Kernel browser" with a green **READ-ONLY** badge, then browser
   snapshots appear within a few seconds and refresh every ~2.5s.
3. While the agent drives the browser (`execute_playwright_code` / `computer_action`), watch
   navigation happen live in the embedded view.
4. Read-only check: click/type inside the embedded view — the page should not react.
5. Click **Open interactive view ↗** — the full interactive live view should open in your
   browser (host shows a link confirmation first).
6. Say _"delete the browser"_ — after deletion the embed goes dark/disconnects (expected;
   the stream ended).

Failure modes to watch for:

- App doesn't render, tool result shows as plain text → host lacks MCP Apps support (old
  Claude version, or apps not enabled for connectors).
- App renders but frames never appear → the host is not proxying app-initiated `tools/call`
  (check the debug line for "snapshot failed" and the proxy log for
  `rpc tools/call name=capture_live_view_frame`).
- "Waiting for browser live view…" forever → tool result never reached the view; check the
  host delivered `ui/notifications/tool-result` (host devtools) and that the session wasn't
  headless (headless sessions have no live view).

## QA without Claude (any browser)

The proxy serves a minimal MCP Apps host at:

```
https://raf-kernel-mcp-server.ngrok.app/qa   (or http://localhost:3003/qa)
```

Click **1. Create browser & render app** (creates a real browser + renders the real
`ui://` resource and drives the postMessage lifecycle), **2. Navigate** to watch the stream
update live, **3. Delete browser** to clean up. If ngrok shows its interstitial page first,
click "Visit Site".

Automated version: `bun scripts/qa-harness-test.mjs` (screenshots in `/tmp/qa-*.png`).

Protocol-level checks with curl (API key as bearer):

```bash
# tool metadata carries the ui resource link
curl -s -X POST http://localhost:3002/mcp \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $KERNEL_API_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
# -> show_browser_live_view has _meta.ui.resourceUri = ui://kernel/live-view.html

# the UI resource itself
curl -s -X POST http://localhost:3002/mcp \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $KERNEL_API_KEY" \
  -d '{"jsonrpc":"2.0","id":2,"method":"resources/read","params":{"uri":"ui://kernel/live-view.html"}}'
# -> mimeType text/html;profile=mcp-app, _meta.ui.csp.frameDomains for *.onkernel.com
```

## Claude-specific findings (from QA)

- **Claude blocks nested third-party iframes entirely.** Per Claude's MCP Apps design
  guidelines: _"`frameDomains` (embedding third-party iframes) is currently restricted in
  Claude pending security review."_ An earlier iteration of this prototype iframed the real
  live view and hit `frame-src` CSP violations in Claude; that's why the app is now
  **snapshot-only** (polling `capture_live_view_frame`, visibility `["app"]`). If Kernel ever
  wants the true WebRTC stream inline, revisit once Claude ships frameDomains support.
- **Custom remote connectors in Claude may connect via a runtime that doesn't support MCP
  Apps** (`client=claude-code`, no `io.modelcontextprotocol/ui` extension — renders a blank
  box). The reliable path is a **local stdio server** in `claude_desktop_config.json` bridged
  with `mcp-remote`:

  ```json
  {
    "mcpServers": {
      "kernel-dev": {
        "command": "npx",
        "args": [
          "-y",
          "mcp-remote",
          "https://raf-kernel-mcp-server.ngrok.app/mcp"
        ]
      }
    }
  }
  ```

- Claude's getting-started docs list example packages as `@modelcontextprotocol/<name>-server`;
  the real npm names are `@modelcontextprotocol/server-<name>` (e.g. `server-shadertoy`).
- Debugging: Claude Desktop → Help → Troubleshooting → Enable Developer Mode, then
  `Cmd+Option+I`; the app is the inner of two nested iframes. The view also prints lifecycle
  state to a debug line at the bottom of the widget.

## Known limitations / next steps

- **Capability negotiation**: `mcp-handler` creates a fresh MCP server for every Streamable
  HTTP POST, so initialize capabilities are unavailable when a later `tools/list` request is
  handled. App-only helpers therefore use the MCP Apps `visibility: ["app"]` contract rather
  than server-side capability filtering; they also reject calls without a short-lived,
  bearer-bound capability delivered only in the launcher's App-private `_meta`.
- The `manage_browsers` tool itself could carry the UI metadata so the app renders on create
  without a second tool call; kept separate to limit blast radius.
- Production auth: this prototype's proxy is dev-only. Production would use the existing
  OAuth flow (mcp.onkernel.com) — no proxy needed since Claude does OAuth there.
- The live view URL expires with the session; the view could poll session state via an
  app-visible tool (`visibility: ["app"]`) and show a "session ended" state.
