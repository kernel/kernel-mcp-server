import { describe, expect, test } from "bun:test";
import {
  createMcpTransportSession,
  verifyMcpTransportSession,
} from "@/lib/mcp-transport-session";

process.env.CLERK_SECRET_KEY ??= "test-clerk-secret";

describe("signed MCP transport sessions", () => {
  test("round-trips the server-issued session identity", () => {
    const created = createMcpTransportSession({
      clientName: "apps-client",
      clientVersion: "1.0.0",
      protocolVersion: "2025-11-25",
    });
    const verified = verifyMcpTransportSession(created.token);
    expect(verified?.id).toBe(created.id);
    expect(verified?.analyticsToken).toBe(created.analyticsToken);
  });

  test("rejects a client-tampered transport session", () => {
    const created = createMcpTransportSession();
    const [version, payload, signature] = created.token.split(".");
    const replacement = payload.endsWith("A")
      ? `${payload.slice(0, -1)}B`
      : `${payload.slice(0, -1)}A`;
    expect(
      verifyMcpTransportSession(`${version}.${replacement}.${signature}`),
    ).toBeNull();
  });

  test("mints distinct identities for clients sharing credentials", () => {
    const apps = createMcpTransportSession({ clientName: "apps" });
    const plain = createMcpTransportSession({ clientName: "plain" });
    expect(apps.id).not.toBe(plain.id);
    expect(apps.token).not.toBe(plain.token);
  });
});
