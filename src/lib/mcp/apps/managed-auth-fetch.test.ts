import { describe, expect, test } from "bun:test";
import {
  createManagedAuthFetch,
  type ManagedAuthFetch,
} from "./managed-auth-fetch";

const baseUrl = () => "https://mcp.example/app";

describe("managed-auth fetch adapter", () => {
  test("caches the scoped exchange JWT and disables hosted fallback", async () => {
    let calls = 0;
    const fetchImpl: ManagedAuthFetch = async () => {
      calls += 1;
      return Response.json({ jwt: "scoped-jwt" });
    };
    const adapter = createManagedAuthFetch(fetchImpl, async () => {}, baseUrl);
    const url = "https://mcp.example/auth/connections/conn_1/exchange";
    await adapter.fetch(url, { method: "POST" });
    const cached = await adapter.fetch(url, { method: "POST" });
    expect(await cached.json()).toEqual({ jwt: "scoped-jwt" });
    expect(calls).toBe(1);
    expect(adapter.state.exchangedJwt).toBe("scoped-jwt");
    expect(adapter.state.hostedFallbackAvailable).toBe(false);
  });

  test("retries transient initial retrieval failures", async () => {
    let calls = 0;
    const delays: number[] = [];
    const fetchImpl: ManagedAuthFetch = async () => {
      calls += 1;
      return new Response(null, { status: calls < 3 ? 503 : 200 });
    };
    const adapter = createManagedAuthFetch(
      fetchImpl,
      async (milliseconds) => {
        delays.push(milliseconds);
      },
      baseUrl,
    );
    const response = await adapter.fetch(
      "https://mcp.example/auth/connections/conn_1",
    );
    expect(response.status).toBe(200);
    expect(calls).toBe(3);
    expect(delays).toEqual([250, 500]);
    expect(adapter.state.retrieveInitializationFailed).toBe(false);
  });
});
