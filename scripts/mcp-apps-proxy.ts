/**
 * Dev-only reverse proxy that injects a Kernel API key as the Authorization
 * header in front of the local MCP server.
 *
 * Why: Claude Desktop / claude.ai custom connectors can only do OAuth or
 * no-auth — they cannot send a static bearer token. The kernel-mcp-server
 * accepts non-JWT bearer tokens as Kernel API keys, so this proxy makes the
 * server usable as a "no auth" connector while still authenticating every
 * request upstream with your API key.
 *
 *   KERNEL_API_KEY=sk_... bun scripts/mcp-apps-proxy.ts
 *
 * Then point ngrok at this proxy (default port 3003), NOT at the Next server:
 *
 *   ngrok http --url=raf-kernel-mcp-server.ngrok.app 3003
 *
 * DO NOT run this against a production deployment or leave the tunnel up
 * unattended: anyone with the ngrok URL can use your Kernel account.
 */

// Bun provides this global at runtime; declared here so the repo's tsconfig
// (which has no Bun types) still typechecks.
declare const Bun: { serve(options: unknown): unknown };

const UPSTREAM = process.env.MCP_UPSTREAM ?? "http://localhost:3002";
const UPSTREAM_URL = new URL(UPSTREAM);
if (!["http:", "https:"].includes(UPSTREAM_URL.protocol)) {
  throw new Error("MCP_UPSTREAM must use http or https");
}
const PORT = Number(process.env.PORT ?? 3003);
const API_KEY = process.env.KERNEL_API_KEY;

if (!API_KEY) {
  console.error("KERNEL_API_KEY is required");
  process.exit(1);
}

const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
]);

function filterHeaders(source: Headers): Headers {
  const out = new Headers();
  source.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) out.set(key, value);
  });
  return out;
}

// Minimal MCP Apps "host" page for QA-ing the live view app in any browser
// (no MCP Apps-capable client needed). It drives the real MCP server through
// this proxy: initialize -> create browser -> show_browser_live_view ->
// resources/read -> render the view in an iframe and speak host-side
// postMessage JSON-RPC to it.
const QA_HARNESS_HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Kernel MCP Apps QA Harness</title>
<style>
  body { font-family: ui-sans-serif, system-ui, sans-serif; max-width: 900px; margin: 24px auto; padding: 0 16px; background: #111; color: #eee; }
  h1 { font-size: 18px; }
  #log { font-family: ui-monospace, monospace; font-size: 12px; white-space: pre-wrap; background: #000; border-radius: 8px; padding: 12px; min-height: 90px; }
  #view { width: 100%; height: 560px; border: 1px dashed #444; border-radius: 8px; background: #1a1a1a; }
  button { font: inherit; padding: 6px 14px; border-radius: 8px; border: 1px solid #555; background: #222; color: #eee; cursor: pointer; margin: 12px 8px 12px 0; }
  button:disabled { opacity: 0.4; cursor: default; }
</style>
</head>
<body>
<h1>Kernel MCP Apps QA harness \u2014 embedded live view</h1>
<p>Simulates an MCP Apps host: creates a real Kernel browser, calls <code>show_browser_live_view</code>, renders the <code>ui://kernel/live-view-v2.html</code> resource below, delivers the tool result over postMessage, and proxies the app's <code>capture_live_view_frame</code> snapshot polling.</p>
<button id="start">1. Create browser &amp; render app</button>
<button id="navigate" disabled>2. Navigate to example.com (watch it happen)</button>
<button id="cleanup" disabled>3. Delete browser</button>
<div id="log"></div>
<iframe id="view" title="MCP app under test"></iframe>
<script>
  let rpcId = 0, sessionId = null, toolResult = null;
  const logEl = document.getElementById("log");
  const frame = document.getElementById("view");
  const log = (m) => { logEl.textContent += m + "\\n"; };

  async function rpc(method, params) {
    const res = await fetch("/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "ngrok-skip-browser-warning": "1",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    });
    const text = await res.text();
    let payload;
    try { payload = JSON.parse(text); } catch {
      const lines = text.split("\\n").filter((l) => l.startsWith("data:"));
      payload = JSON.parse(lines[lines.length - 1].slice(5));
    }
    if (payload.error) throw new Error(payload.error.message || JSON.stringify(payload.error));
    return payload.result;
  }
  async function notify(method, params) {
    await fetch("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", method, params }),
    });
  }
  const callTool = (name, args) => rpc("tools/call", { name, arguments: args });

  // Host side of the MCP Apps postMessage protocol
  window.addEventListener("message", (ev) => {
    if (ev.source !== frame.contentWindow) return;
    const msg = ev.data;
    if (!msg || msg.jsonrpc !== "2.0") return;
    const reply = (body) => frame.contentWindow.postMessage(Object.assign({ jsonrpc: "2.0" }, body), "*");
    if (msg.method === "ui/initialize") {
      log("[host] view sent ui/initialize");
      reply({ id: msg.id, result: {
        protocolVersion: "2026-01-26",
        hostInfo: { name: "qa-harness", version: "0.0.1" },
        hostCapabilities: { openLinks: {}, serverTools: {} },
        hostContext: { theme: "dark", displayMode: "inline", containerDimensions: { maxHeight: 800 } },
      }});
    } else if (msg.method === "ui/notifications/initialized") {
      log("[host] view initialized; sending tool-input + tool-result");
      reply({ method: "ui/notifications/tool-input", params: { arguments: { session_id: sessionId } } });
      reply({ method: "ui/notifications/tool-result", params: toolResult });
    } else if (msg.method === "tools/call") {
      log("[host] proxying tools/call " + msg.params.name);
      rpc("tools/call", msg.params).then(
        (result) => reply({ id: msg.id, result }),
        (err) => reply({ id: msg.id, error: { code: -32000, message: err.message } }),
      );
    } else if (msg.method === "ui/open-link") {
      log("[host] ui/open-link -> " + msg.params.url);
      window.open(msg.params.url, "_blank");
      reply({ id: msg.id, result: {} });
    } else if (msg.method === "ui/notifications/size-changed") {
      if (msg.params && msg.params.height) frame.style.height = Math.min(msg.params.height, 800) + "px";
    } else if (msg.id !== undefined && msg.method) {
      reply({ id: msg.id, result: {} });
    }
  });

  document.getElementById("start").onclick = async () => {
    try {
      document.getElementById("start").disabled = true;
      log("initialize...");
      await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } }, clientInfo: { name: "qa-harness", version: "0.0.1" } });
      await notify("notifications/initialized", {});
      log("creating browser (timeout 600s)...");
      const created = await callTool("manage_browsers", { action: "create", timeout_seconds: 600 });
      sessionId = JSON.parse(created.content[0].text).browser.session_id;
      log("session: " + sessionId);
      log("calling show_browser_live_view...");
      toolResult = await callTool("show_browser_live_view", { session_id: sessionId });
      log("reading ui://kernel/live-view-v2.html...");
      const resource = await rpc("resources/read", { uri: "ui://kernel/live-view-v2.html" });
      frame.srcdoc = resource.contents[0].text;
      document.getElementById("cleanup").disabled = false;
      document.getElementById("navigate").disabled = false;
      log("view rendered. You should see the read-only live view stream below.");
    } catch (err) {
      log("ERROR: " + err.message);
    }
  };

  document.getElementById("navigate").onclick = async () => {
    try {
      log("navigating via execute_playwright_code...");
      await callTool("execute_playwright_code", {
        session_id: sessionId,
        code: "const page = (context.pages())[0] ?? await context.newPage(); await page.goto('https://example.com'); return await page.title();",
      });
      log("navigated \u2014 the embedded view should have updated in real time.");
    } catch (err) { log("ERROR: " + err.message); }
  };

  document.getElementById("cleanup").onclick = async () => {
    try {
      await callTool("manage_browsers", { action: "delete", session_id: sessionId });
      log("browser deleted.");
      document.getElementById("cleanup").disabled = true;
      document.getElementById("navigate").disabled = true;
    } catch (err) { log("ERROR: " + err.message); }
  };
</script>
</body>
</html>
`;

const AUTH_QA_HARNESS_HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Kernel Managed Auth MCP App QA</title>
<style>
  body { font-family: ui-sans-serif, system-ui, sans-serif; max-width: 720px; margin: 24px auto; padding: 0 16px; background: #111; color: #eee; }
  label { display: block; margin: 8px 0; } input { margin-left: 8px; padding: 5px; }
  button { padding: 7px 14px; margin: 8px 6px 8px 0; }
  #log { white-space: pre-wrap; font: 12px ui-monospace, monospace; background: #000; padding: 12px; }
  #view { width: 100%; min-height: 560px; border: 1px dashed #555; }
</style>
</head>
<body>
<h1>Managed Auth MCP App QA</h1>
<p>The flow is not created until Continue is clicked inside the embedded App.</p>
<label>Domain <input id="domain" value="example.com" /></label>
<label>Profile <input id="profile" value="mcp-auth-qa" /></label>
<button id="start">1. Render secure App</button>
<button id="cleanup" disabled>2. Delete test connection</button>
<div id="log"></div>
<iframe id="view" title="Managed Auth MCP App"></iframe>
<script>
  let rpcId = 0, input = null, launcher = null, connectionId = null;
  const frame = document.getElementById("view");
  const logEl = document.getElementById("log");
  const log = (text) => { logEl.textContent += text + "\\n"; };
  async function rpc(method, params) {
    const response = await fetch("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    });
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); } catch {
      const lines = text.split("\\n").filter((line) => line.startsWith("data:"));
      payload = JSON.parse(lines[lines.length - 1].slice(5));
    }
    if (payload.error) throw new Error(payload.error.message);
    return payload.result;
  }
  async function notify(method, params) {
    await fetch("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", method, params }),
    });
  }
  const callTool = (name, args) => rpc("tools/call", { name, arguments: args });
  window.addEventListener("message", (event) => {
    if (event.source !== frame.contentWindow) return;
    const message = event.data;
    if (!message || message.jsonrpc !== "2.0") return;
    const reply = (body) => frame.contentWindow.postMessage({ jsonrpc: "2.0", ...body }, "*");
    if (message.method === "ui/initialize") {
      reply({ id: message.id, result: {
        protocolVersion: "2026-01-26",
        hostInfo: { name: "qa-harness", version: "0.0.1" },
        hostCapabilities: { openLinks: {}, serverTools: {}, updateModelContext: {}, message: {} },
        hostContext: { theme: "dark", displayMode: "inline" },
      }});
    } else if (message.method === "ui/notifications/initialized") {
      reply({ method: "ui/notifications/tool-input", params: { arguments: input } });
      reply({ method: "ui/notifications/tool-result", params: launcher });
      log("App initialized. No auth flow exists until Continue is clicked.");
    } else if (message.method === "tools/call") {
      log("App called " + message.params.name + " (private result not logged)");
      rpc("tools/call", message.params).then(
        (result) => {
          connectionId = result.structuredContent?.connection?.id || connectionId;
          document.getElementById("cleanup").disabled = !connectionId;
          if (connectionId) log("Managed-auth connection ready.");
          reply({ id: message.id, result });
        },
        (error) => {
          log("ERROR: App tool call failed");
          reply({ id: message.id, error: { code: -32000, message: error.message } });
        },
      );
    } else if (message.method === "ui/open-link") {
      log("App requested a user-approved hosted fallback link (URL not logged).");
      window.open(message.params.url, "_blank", "noopener,noreferrer");
      reply({ id: message.id, result: {} });
    } else if (message.method === "ui/update-model-context") {
      log("App sent sanitized terminal model context.");
      reply({ id: message.id, result: {} });
    } else if (message.method === "ui/message") {
      log("User activated Continue agent.");
      reply({ id: message.id, result: {} });
    } else if (message.method === "ui/notifications/size-changed") {
      if (message.params?.height) frame.style.height = Math.min(message.params.height, 800) + "px";
    } else if (message.id !== undefined && message.method) {
      reply({ id: message.id, result: {} });
    }
  });
  document.getElementById("start").onclick = async () => {
    try {
      await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } }, clientInfo: { name: "auth-qa", version: "0.0.1" } });
      await notify("notifications/initialized", {});
      input = {
        mode: "new_login",
        domain: document.getElementById("domain").value,
        profile_name: document.getElementById("profile").value,
        text_only: false,
      };
      launcher = await callTool("open_auth_login", input);
      const resource = await rpc("resources/read", { uri: "ui://kernel/managed-auth-login-v5.html" });
      frame.srcdoc = resource.contents[0].text;
      log("Secure App resource rendered.");
    } catch (error) { log("ERROR: " + error.message); }
  };
  document.getElementById("cleanup").onclick = async () => {
    try {
      await callTool("delete_auth_login_connection", {
        connection_id: connectionId,
        app_capability: launcher._meta.auth_login_launcher.app_capability,
      });
      log("Test connection deleted.");
      connectionId = null;
      document.getElementById("cleanup").disabled = true;
    } catch (error) { log("ERROR: cleanup failed"); }
  };
</script>
</body>
</html>`;

Bun.serve({
  port: PORT,
  idleTimeout: 240,
  async fetch(req: Request) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/qa") {
      return new Response(QA_HARNESS_HTML, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (req.method === "GET" && url.pathname === "/qa/auth") {
      return new Response(AUTH_QA_HARNESS_HTML, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    // Hide the server's OAuth surface. This proxy injects an API key on every
    // request, so from the outside this must look like a no-auth MCP server.
    // If OAuth discovery leaks through, clients like Claude attempt dynamic
    // client registration against the (dummy-configured) Clerk instance and
    // the connector fails to connect.
    if (
      url.pathname.startsWith("/.well-known/") ||
      url.pathname === "/register" ||
      url.pathname === "/authorize" ||
      url.pathname === "/token"
    ) {
      console.log(
        `[proxy] ${req.method} ${url.pathname} -> 404 (oauth surface hidden)`,
      );
      return new Response("Not found", { status: 404 });
    }

    // Assign onto a fixed parsed origin. Constructing from a string beginning
    // with `//` would reinterpret an attacker-controlled path as a new host and
    // exfiltrate the API key attached below.
    const target = new URL(UPSTREAM_URL);
    target.pathname = url.pathname;
    target.search = url.search;

    const headers = filterHeaders(req.headers);
    // Only the MCP endpoint needs the development API-key injection. Managed
    // Auth relay requests carry their own short-lived, session-scoped JWT;
    // overwriting it would break retrieve/submit after handoff exchange.
    if (url.pathname === "/mcp") {
      headers.set("authorization", `Bearer ${API_KEY}`);
    }

    // Decode JSON-RPC traffic for debugging (bodies are small JSON payloads).
    let body: BodyInit | null = req.body;
    if (req.method === "POST" && url.pathname === "/mcp") {
      const bodyText = await req.text();
      body = bodyText;
      try {
        const parsed = JSON.parse(bodyText);
        const messages = Array.isArray(parsed) ? parsed : [parsed];
        for (const m of messages) {
          if (!m || typeof m.method !== "string") continue;
          let detail = m.method;
          if (m.method === "tools/call") detail += ` name=${m.params?.name}`;
          if (m.method === "resources/read") detail += ` uri=${m.params?.uri}`;
          if (m.method === "initialize") {
            const client = m.params?.clientInfo;
            detail += ` client=${client?.name}@${client?.version} extensions=${JSON.stringify(
              m.params?.capabilities?.extensions ?? null,
            )}`;
          }
          console.log(`[proxy] rpc ${detail}`);
        }
      } catch {
        /* non-JSON body; forward as-is */
      }
    }

    let upstream: Response;
    try {
      upstream = await fetch(target, {
        method: req.method,
        headers,
        body,
        redirect: "manual",
        // @ts-expect-error half-duplex streaming request bodies
        duplex: "half",
      });
    } catch (error) {
      console.error(
        `[proxy] ${req.method} ${url.pathname} -> upstream error`,
        error,
      );
      return new Response("Upstream unavailable", { status: 502 });
    }

    console.log(`[proxy] ${req.method} ${url.pathname} -> ${upstream.status}`);
    return new Response(upstream.body, {
      status: upstream.status,
      headers: filterHeaders(upstream.headers),
    });
  },
});

console.log(
  `mcp-apps auth proxy listening on http://localhost:${PORT} -> ${UPSTREAM} (injecting Kernel API key)`,
);
