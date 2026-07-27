import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createKernelClient } from "@/lib/mcp/kernel-client";
import { errorResponse, toolErrorResponse } from "@/lib/mcp/responses";

/**
 * MCP Apps (SEP-1865) prototype: an embedded view of a Kernel browser
 * session, rendered inline in MCP Apps-capable hosts (Claude Desktop, etc).
 *
 * The `show_browser_live_view` tool is linked (via `_meta.ui.resourceUri`) to
 * a `ui://` HTML resource. Hosts that support the `io.modelcontextprotocol/ui`
 * extension fetch that resource, render it in a sandboxed iframe, and deliver
 * the tool result to it over postMessage JSON-RPC.
 *
 * The view renders read-only snapshots of the browser: it polls the app-only
 * `capture_live_view_frame` tool through the host and swaps PNG frames into an
 * <img>. We deliberately do NOT iframe the real live view — hosts like Claude
 * block nested third-party iframes (frameDomains is restricted pending
 * security review), and snapshots work everywhere with no external origins.
 * The full interactive live view is still one click away via ui/open-link.
 *
 * Hosts without MCP Apps support just see a normal tool that returns the live
 * view URLs as text.
 */

// Bumping the version in the URI busts host-side resource caches (hosts MAY
// prefetch and cache UI resources); the unversioned legacy URI stays
// registered below for hosts still holding cached tool metadata.
export const LIVE_VIEW_RESOURCE_URI = "ui://kernel/live-view-v2.html";

const LIVE_VIEW_LEGACY_RESOURCE_URI = "ui://kernel/live-view.html";

export const LIVE_VIEW_MIME_TYPE = "text/html;profile=mcp-app";

// No external origins needed: snapshots arrive as data: URIs via host-proxied
// tool calls, which the spec's restrictive default CSP already permits.
const LIVE_VIEW_UI_META = {
  prefersBorder: true,
};

const SNAPSHOT_INTERVAL_MS = 2500;
const SNAPSHOT_RETRY_MS = 4000;
const SNAPSHOT_MAX_FAILURES = 5;

// The view is a single self-contained HTML document speaking raw postMessage
// JSON-RPC per the MCP Apps spec (no bundler / SDK build step needed).
const LIVE_VIEW_HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Kernel Browser Live View</title>
    <style>
      :root {
        color-scheme: light dark;
        --bg: var(--color-background-primary, light-dark(#ffffff, #171717));
        --fg: var(--color-text-primary, light-dark(#171717, #fafafa));
        --muted: var(--color-text-secondary, light-dark(#6b6b6b, #a3a3a3));
        --border: var(--color-border-primary, light-dark(#e5e5e5, #333333));
        --radius: var(--border-radius-md, 10px);
        --font: var(--font-sans, ui-sans-serif, system-ui, -apple-system, sans-serif);
      }
      html, body {
        margin: 0;
        padding: 0;
        background: var(--bg);
        color: var(--fg);
        font-family: var(--font);
      }
      .wrap { display: flex; flex-direction: column; gap: 8px; padding: 10px; box-sizing: border-box; }
      header { display: flex; align-items: center; gap: 8px; min-height: 28px; }
      .title { font-weight: 600; font-size: 13px; }
      .badge {
        font-size: 11px; padding: 2px 8px; border-radius: 999px;
        border: 1px solid var(--border); color: var(--muted);
        text-transform: uppercase; letter-spacing: 0.04em;
      }
      .badge.live { color: #16a34a; border-color: #16a34a; }
      .status { font-size: 12px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .spacer { flex: 1; }
      button {
        font: inherit; font-size: 12px; cursor: pointer;
        background: transparent; color: var(--fg);
        border: 1px solid var(--border); border-radius: 999px; padding: 4px 12px;
      }
      button:hover { border-color: var(--fg); }
      .frame-box {
        position: relative; overflow: hidden; background: #101010;
        border: 1px solid var(--border); border-radius: var(--radius);
        aspect-ratio: 16 / 10; width: 100%;
      }
      #snap { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
      #placeholder {
        position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
        color: #a3a3a3; font-size: 13px; gap: 10px; text-align: center; padding: 0 16px;
      }
      .dot {
        width: 8px; height: 8px; border-radius: 999px; background: #a3a3a3;
        animation: pulse 1.2s ease-in-out infinite;
      }
      @keyframes pulse { 0%, 100% { opacity: 0.25; } 50% { opacity: 1; } }
      footer { font-size: 11px; color: var(--muted); }
      code { font-family: var(--font-mono, ui-monospace, monospace); font-size: 11px; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <header>
        <span class="title">Kernel browser</span>
        <span class="badge" id="mode-badge">connecting</span>
        <span class="status" id="status"></span>
        <span class="spacer"></span>
        <button id="open-btn" hidden>Open interactive view &#8599;</button>
      </header>
      <div class="frame-box">
        <div id="placeholder"><span class="dot"></span> Waiting for browser&hellip;</div>
        <img id="snap" alt="Browser snapshot" hidden />
      </div>
      <footer id="session-line" hidden>session <code id="session-id"></code></footer>
      <footer id="debug-line"></footer>
    </div>
    <script>
      (function () {
        "use strict";
        var nextId = 1;
        var pending = new Map();
        var interactiveUrl = null;
        var sessionId = null;
        var polling = false;
        var snapshotTimer = null;
        var snapshotFailures = 0;

        function debug(text) {
          document.getElementById("debug-line").textContent = text;
          try {
            window.parent.postMessage(
              {
                jsonrpc: "2.0",
                method: "notifications/message",
                params: { level: "debug", data: "kernel-live-view: " + text },
              },
              "*",
            );
          } catch (e) {}
        }

        function sendRequest(method, params) {
          var id = nextId++;
          return new Promise(function (resolve, reject) {
            pending.set(id, { resolve: resolve, reject: reject });
            window.parent.postMessage({ jsonrpc: "2.0", id: id, method: method, params: params }, "*");
          });
        }
        function sendNotification(method, params) {
          window.parent.postMessage({ jsonrpc: "2.0", method: method, params: params }, "*");
        }

        var notificationHandlers = {
          "ui/notifications/tool-input": function (params) {
            var args = (params && params.arguments) || {};
            if (args.session_id) {
              sessionId = args.session_id;
              setSessionId(args.session_id);
            }
          },
          "ui/notifications/tool-input-partial": function () {},
          "ui/notifications/tool-result": function (params) {
            debug("received tool-result");
            handleToolResult(params || {});
          },
          "ui/notifications/tool-cancelled": function (params) {
            setStatus("Cancelled" + (params && params.reason ? ": " + params.reason : ""));
          },
          "ui/notifications/host-context-changed": function (params) {
            applyHostContext(params || {});
          },
        };

        window.addEventListener("message", function (event) {
          var msg = event.data;
          if (!msg || msg.jsonrpc !== "2.0") return;
          // Response to one of our requests
          if (msg.id !== undefined && msg.method === undefined) {
            var p = pending.get(msg.id);
            if (!p) return;
            pending.delete(msg.id);
            if (msg.error) p.reject(new Error(msg.error.message || "host error"));
            else p.resolve(msg.result);
            return;
          }
          if (msg.method) {
            // Host request (e.g. ui/resource-teardown): acknowledge politely.
            if (msg.id !== undefined) {
              if (msg.method === "ui/resource-teardown") {
                clearTimeout(snapshotTimer);
                polling = false;
              }
              window.parent.postMessage({ jsonrpc: "2.0", id: msg.id, result: {} }, "*");
              return;
            }
            var handler = notificationHandlers[msg.method];
            if (handler) handler(msg.params);
          }
        });

        function setStatus(text) {
          document.getElementById("status").textContent = text || "";
        }
        function setBadge(text, live) {
          var badge = document.getElementById("mode-badge");
          badge.textContent = text;
          badge.className = live ? "badge live" : "badge";
        }
        function setSessionId(id) {
          document.getElementById("session-id").textContent = id;
          document.getElementById("session-line").hidden = false;
        }
        function setPlaceholder(text) {
          var ph = document.getElementById("placeholder");
          ph.style.display = "flex";
          ph.textContent = text;
        }
        function reportSize() {
          sendNotification("ui/notifications/size-changed", {
            height: Math.max(document.documentElement.scrollHeight, 360),
          });
        }

        function applyHostContext(ctx) {
          if (!ctx) return;
          if (ctx.theme) {
            document.documentElement.style.colorScheme = ctx.theme;
          }
          if (ctx.styles && ctx.styles.variables) {
            var vars = ctx.styles.variables;
            for (var key in vars) {
              if (vars[key] !== undefined) {
                document.documentElement.style.setProperty(key, vars[key]);
              }
            }
          }
        }

        // Accepts either show_browser_live_view structuredContent, or any tool
        // result whose JSON text contains a browser object (e.g. manage_browsers).
        function extractLiveViewInfo(result) {
          var sc = result.structuredContent;
          if (sc && (sc.session_id || sc.live_view_url)) return sc;
          var content = result.content || [];
          for (var i = 0; i < content.length; i++) {
            if (content[i].type !== "text") continue;
            try {
              var parsed = JSON.parse(content[i].text);
              if (parsed.session_id || parsed.live_view_url) return parsed;
              var browser = parsed.browser || parsed;
              if (browser && browser.session_id) {
                return {
                  session_id: browser.session_id,
                  interactive_live_view_url: browser.browser_live_view_url,
                };
              }
            } catch (e) {
              /* not JSON; keep scanning */
            }
          }
          return null;
        }

        function handleToolResult(result) {
          if (result.isError) {
            setBadge("error", false);
            var errText = (result.content && result.content[0] && result.content[0].text) || "Tool failed";
            setStatus(errText);
            setPlaceholder(errText);
            reportSize();
            return;
          }
          var info = extractLiveViewInfo(result);
          if (!info) {
            setStatus("No session in tool result");
            return;
          }
          interactiveUrl = info.interactive_live_view_url || null;
          if (info.session_id) {
            sessionId = info.session_id;
            setSessionId(info.session_id);
          }
          setBadge("read-only", true);
          setStatus("");
          configureOpenButton();
          startPolling();
          reportSize();
        }

        function configureOpenButton() {
          var openBtn = document.getElementById("open-btn");
          if (interactiveUrl) {
            openBtn.hidden = false;
            openBtn.onclick = function () {
              sendRequest("ui/open-link", { url: interactiveUrl }).catch(function (err) {
                setStatus("Could not open link: " + err.message);
              });
            };
          }
        }

        // Render loop: poll the app-only capture_live_view_frame tool through
        // the host and swap PNG frames into the <img>.
        function startPolling() {
          if (polling) return;
          polling = true;
          debug("starting snapshot polling");
          setPlaceholder("Loading first frame\\u2026");
          pollSnapshot();
        }

        function pollSnapshot() {
          if (!polling) return;
          if (!sessionId) {
            debug("no session id available");
            return;
          }
          if (document.hidden) {
            snapshotTimer = setTimeout(pollSnapshot, ${SNAPSHOT_INTERVAL_MS});
            return;
          }
          sendRequest("tools/call", {
            name: "capture_live_view_frame",
            arguments: { session_id: sessionId },
          })
            .then(function (result) {
              var content = (result && result.content) || [];
              var image = null;
              for (var i = 0; i < content.length; i++) {
                if (content[i].type === "image" && content[i].data) {
                  image = content[i];
                  break;
                }
              }
              if (!image) {
                var text = (content[0] && content[0].text) || "no image in result";
                throw new Error(text);
              }
              snapshotFailures = 0;
              var el = document.getElementById("snap");
              el.src = "data:" + (image.mimeType || "image/png") + ";base64," + image.data;
              el.hidden = false;
              document.getElementById("placeholder").style.display = "none";
              snapshotTimer = setTimeout(pollSnapshot, ${SNAPSHOT_INTERVAL_MS});
            })
            .catch(function (err) {
              snapshotFailures++;
              debug("snapshot failed (" + snapshotFailures + "): " + err.message);
              if (snapshotFailures < ${SNAPSHOT_MAX_FAILURES}) {
                snapshotTimer = setTimeout(pollSnapshot, ${SNAPSHOT_RETRY_MS});
              } else {
                polling = false;
                setBadge("stopped", false);
                setPlaceholder(
                  "Could not capture the browser (" +
                    err.message +
                    "). The session may have ended.",
                );
                reportSize();
              }
            });
        }

        // Report a usable size immediately so hosts with flexible containers
        // never collapse the frame to zero height before init completes.
        reportSize();
        debug("loaded; sending ui/initialize");

        // MCP Apps handshake: ui/initialize -> ui/notifications/initialized.
        var initDone = false;
        function onInitialized(initResult) {
          if (initDone) return;
          initDone = true;
          applyHostContext(initResult && initResult.hostContext);
          sendNotification("ui/notifications/initialized", {});
          setBadge("waiting", false);
          debug("initialized; waiting for tool result");
          reportSize();
        }

        sendRequest("ui/initialize", {
          protocolVersion: "2026-01-26",
          capabilities: {},
          appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
          clientInfo: { name: "kernel-live-view", version: "0.1.0" },
        })
          .then(onInitialized)
          .catch(function (err) {
            setStatus("Host init failed: " + err.message);
            debug("ui/initialize rejected: " + err.message);
          });

        // Some hosts never answer ui/initialize but still deliver tool
        // notifications. Proceed after a grace period so the view is not
        // stuck on "connecting" forever.
        setTimeout(function () {
          if (!initDone) {
            debug("no ui/initialize response after 4s; proceeding anyway");
            onInitialized(null);
          }
        }, 4000);

        if (typeof ResizeObserver !== "undefined") {
          var debounce = null;
          new ResizeObserver(function () {
            clearTimeout(debounce);
            debounce = setTimeout(reportSize, 100);
          }).observe(document.body);
        }
      })();
    </script>
  </body>
</html>
`;

export function registerLiveViewApp(server: McpServer) {
  const readLiveViewResource = async (uri: URL) => ({
    contents: [
      {
        uri: uri.toString(),
        mimeType: LIVE_VIEW_MIME_TYPE,
        text: LIVE_VIEW_HTML,
        _meta: { ui: LIVE_VIEW_UI_META },
      },
    ],
  });

  for (const [name, uri] of [
    ["kernel-live-view", LIVE_VIEW_RESOURCE_URI],
    ["kernel-live-view-legacy", LIVE_VIEW_LEGACY_RESOURCE_URI],
  ] as const) {
    server.registerResource(
      name,
      uri,
      {
        title: "Kernel Browser Live View",
        description:
          "Interactive view that shows read-only snapshots of a Kernel browser session inline in the conversation.",
        mimeType: LIVE_VIEW_MIME_TYPE,
        _meta: { ui: LIVE_VIEW_UI_META },
      },
      readLiveViewResource,
    );
  }

  server.registerTool(
    "show_browser_live_view",
    {
      title: "Show browser live view",
      description:
        "Render an embedded, read-only view of a Kernel browser session directly in the chat so the user can watch automation happen in real time (refreshing snapshots). Call this once right after creating a (non-headless) browser session, before starting to control it; the view keeps refreshing while you work. On hosts without MCP Apps support this returns the live view URLs as text instead.",
      inputSchema: {
        session_id: z
          .string()
          .describe("Browser session ID to display (from manage_browsers)."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: {
        ui: {
          resourceUri: LIVE_VIEW_RESOURCE_URI,
          visibility: ["model", "app"],
        },
        // Deprecated flat form kept for hosts on the pre-GA metadata shape.
        "ui/resourceUri": LIVE_VIEW_RESOURCE_URI,
      },
    },
    async (params, extra) => {
      if (!extra.authInfo) throw new Error("Authentication required");
      const client = createKernelClient(extra.authInfo.token);

      try {
        const browser = await client.browsers.retrieve(params.session_id);
        if (!browser) {
          return errorResponse(
            `Browser session "${params.session_id}" not found`,
          );
        }
        const interactiveUrl = browser.browser_live_view_url;
        if (!interactiveUrl) {
          return errorResponse(
            `Browser session "${params.session_id}" has no live view URL (headless sessions have no live view).`,
          );
        }
        const readOnlyUrl = new URL(interactiveUrl);
        readOnlyUrl.searchParams.set("readOnly", "true");

        return {
          content: [
            {
              type: "text" as const,
              text:
                `Live view for browser session ${params.session_id} is now displayed to the user (read-only snapshots).` +
                ` Read-only URL: ${readOnlyUrl.toString()}` +
                ` | Interactive URL: ${interactiveUrl}`,
            },
          ],
          structuredContent: {
            session_id: params.session_id,
            live_view_url: readOnlyUrl.toString(),
            interactive_live_view_url: interactiveUrl,
            read_only: true,
          },
        };
      } catch (error) {
        return toolErrorResponse("show_browser_live_view", "show", error);
      }
    },
  );

  // App-only snapshot tool: the render loop of the live view app. Hidden from
  // the model on compliant hosts via visibility: ["app"].
  server.registerTool(
    "capture_live_view_frame",
    {
      title: "Capture live view frame (app-only)",
      description:
        "Capture a PNG snapshot of a browser session for the embedded live view app. Intended for app-initiated calls; agents should use computer_action with a screenshot action instead.",
      inputSchema: {
        session_id: z
          .string()
          .describe("Browser session ID to capture a frame from."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: {
        ui: {
          visibility: ["app"],
        },
      },
    },
    async (params, extra) => {
      if (!extra.authInfo) throw new Error("Authentication required");
      const client = createKernelClient(extra.authInfo.token);
      try {
        const screenshotResponse =
          await client.browsers.computer.captureScreenshot(params.session_id);
        const blob = await screenshotResponse.blob();
        const buffer = Buffer.from(await blob.arrayBuffer());
        return {
          content: [
            {
              type: "image" as const,
              data: buffer.toString("base64"),
              mimeType: "image/png",
            },
          ],
        };
      } catch (error) {
        return toolErrorResponse("capture_live_view_frame", "capture", error);
      }
    },
  );
}
