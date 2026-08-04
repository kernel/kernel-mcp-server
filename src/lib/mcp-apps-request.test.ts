import { describe, expect, test } from "bun:test";
import {
  requestUsesMcpApps,
  type McpAppsMarkerStore,
} from "@/lib/mcp-apps-request";

function request(method: string, params: Record<string, unknown> = {}) {
  return new Request("https://mcp.example/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

function memoryStore() {
  const markers = new Set<string>();
  const key = (value: { authSubject: string; transportSessionId: string }) =>
    `${value.authSubject}:${value.transportSessionId}`;
  const store: McpAppsMarkerStore = {
    mark: async (value) => {
      markers.add(key(value));
    },
    clear: async (value) => {
      markers.delete(key(value));
    },
    has: async (value) => markers.has(key(value)),
  };
  return { store, markers };
}

const appsInitialize = () =>
  request("initialize", {
    capabilities: {
      extensions: { "io.modelcontextprotocol/ui": { mimeTypes: [] } },
    },
  });
const plainInitialize = () => request("initialize", { capabilities: {} });
const toolsList = () => request("tools/list");

async function assertOppositeCapabilitiesStayIsolated(authSubject: string) {
  const { store, markers } = memoryStore();
  const apps = {
    authSubject,
    transportSessionId: "session_apps",
    ttlSeconds: 300,
  };
  const plain = {
    authSubject,
    transportSessionId: "session_plain",
    ttlSeconds: 300,
  };

  await requestUsesMcpApps(appsInitialize(), apps, store);
  await requestUsesMcpApps(plainInitialize(), plain, store);
  expect(await requestUsesMcpApps(toolsList(), apps, store)).toBe(true);
  expect(await requestUsesMcpApps(toolsList(), plain, store)).toBe(false);
  expect(markers.size).toBe(1);

  // Re-initializing the plain client cannot clear the Apps client's marker.
  await requestUsesMcpApps(plainInitialize(), plain, store);
  expect(await requestUsesMcpApps(toolsList(), apps, store)).toBe(true);
}

describe("streamable-HTTP MCP Apps capability lifecycle", () => {
  test("isolates opposite-capability clients sharing one Clerk subject", async () => {
    await assertOppositeCapabilitiesStayIsolated("user:shared");
  });

  test("isolates opposite-capability clients sharing one API key subject", async () => {
    await assertOppositeCapabilitiesStayIsolated("apikey:shared");
  });

  test("fails closed without a signed transport-session identity", async () => {
    const { store, markers } = memoryStore();
    const identity = {
      authSubject: "user:shared",
      transportSessionId: null,
      ttlSeconds: 300,
    };
    await requestUsesMcpApps(appsInitialize(), identity, store);
    expect(await requestUsesMcpApps(toolsList(), identity, store)).toBe(false);
    expect(markers.size).toBe(0);
  });

  test("does not accept a mixed initialize batch", async () => {
    const { store, markers } = memoryStore();
    const batch = new Request("https://mcp.example/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            capabilities: {
              extensions: { "io.modelcontextprotocol/ui": {} },
            },
          },
        },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
      ]),
    });
    const identity = {
      authSubject: "user:shared",
      transportSessionId: "session_batch",
      ttlSeconds: 300,
    };
    expect(await requestUsesMcpApps(batch, identity, store)).toBe(false);
    expect(markers.size).toBe(0);
  });
});
