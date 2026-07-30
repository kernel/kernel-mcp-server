import { describe, expect, test } from "bun:test";
import { proxyManagedAuthRequest } from "./route";

function jwt(claims: Record<string, unknown>) {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value))
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
  return `${encode({ alg: "none" })}.${encode(claims)}.signature`;
}

const scopedToken = jwt({
  iss: "kernel-api",
  managed_auth_session_id: "session_1",
  exp: 4102444800,
});

function request(
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
) {
  return new Request(`http://localhost:3002${path}`, {
    method: options.method ?? "GET",
    headers: options.headers,
    body: options.body,
  });
}

function expectCors(response: Response) {
  expect(response.headers.get("access-control-allow-origin")).toBe("*");
  expect(response.headers.get("access-control-allow-methods")).toBe(
    "GET, POST, OPTIONS",
  );
}

describe("managed-auth relay", () => {
  test("rejects invalid paths, methods, query parameters, and API keys", async () => {
    const invalidPath = await proxyManagedAuthRequest(
      request("/managed-auth-proxy/auth/connections/c_1/arbitrary"),
      ["c_1", "arbitrary"],
    );
    expect(invalidPath.status).toBe(404);
    expectCors(invalidPath);

    const invalidMethod = await proxyManagedAuthRequest(
      request("/managed-auth-proxy/auth/connections/c_1/events", {
        method: "POST",
      }),
      ["c_1", "events"],
    );
    expect(invalidMethod.status).toBe(405);
    expectCors(invalidMethod);

    const query = await proxyManagedAuthRequest(
      request("/managed-auth-proxy/auth/connections/c_1?upstream=evil"),
      ["c_1"],
    );
    expect(query.status).toBe(400);

    const apiKey = await proxyManagedAuthRequest(
      request("/managed-auth-proxy/auth/connections/c_1", {
        headers: { authorization: "Bearer sk_not_a_managed_auth_jwt" },
      }),
      ["c_1"],
    );
    expect(apiKey.status).toBe(401);
    expectCors(apiKey);
  });

  test("rejects expired scoped JWTs at the relay boundary", async () => {
    const expired = jwt({
      iss: "kernel-api",
      managed_auth_session_id: "session_1",
      exp: 1700000000, // 2023-11-14, in the past
    });
    const response = await proxyManagedAuthRequest(
      request("/managed-auth-proxy/auth/connections/c_1", {
        headers: { authorization: `Bearer ${expired}` },
      }),
      ["c_1"],
    );
    expect(response.status).toBe(401);
    expectCors(response);
  });

  test("allows unauthenticated exchange and strips cookies and arbitrary headers", async () => {
    let forwarded: RequestInit | undefined;
    const upstream = async (_url: URL | RequestInfo, init?: RequestInit) => {
      forwarded = init;
      return new Response('{"jwt":"scoped-secret"}', {
        headers: { "content-type": "application/json", "set-cookie": "bad=1" },
      });
    };
    const response = await proxyManagedAuthRequest(
      request("/managed-auth-proxy/auth/connections/c_1/exchange", {
        method: "POST",
        headers: {
          cookie: "mcp=secret",
          "x-forwarded-for": "127.0.0.1",
          "x-arbitrary": "do-not-forward",
          "content-type": "application/json",
          accept: "application/json",
        },
        body: '{"code":"handoff-secret"}',
      }),
      ["c_1", "exchange"],
      upstream as typeof fetch,
    );
    expect(response.status).toBe(200);
    expectCors(response);
    const headers = new Headers(forwarded?.headers);
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("x-forwarded-for")).toBeNull();
    expect(headers.get("x-arbitrary")).toBeNull();
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  test("passes scoped JWT only to fixed authenticated endpoints", async () => {
    let forwardedAuthorization = "";
    const upstream = async (_url: URL | RequestInfo, init?: RequestInit) => {
      forwardedAuthorization =
        new Headers(init?.headers).get("authorization") ?? "";
      return new Response("{}", {
        headers: { "content-type": "application/json" },
      });
    };
    const response = await proxyManagedAuthRequest(
      request("/managed-auth-proxy/auth/connections/c_1/submit", {
        method: "POST",
        headers: {
          authorization: `Bearer ${scopedToken}`,
          "content-type": "application/json",
        },
        body: "{}",
      }),
      ["c_1", "submit"],
      upstream as typeof fetch,
    );
    expect(response.status).toBe(200);
    expect(forwardedAuthorization).toBe(`Bearer ${scopedToken}`);
  });

  test("preserves unbuffered SSE and CORS preflight", async () => {
    const upstream = async () =>
      new Response("event: status\ndata: {}\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    const response = await proxyManagedAuthRequest(
      request("/managed-auth-proxy/auth/connections/c_1/events", {
        headers: { authorization: `Bearer ${scopedToken}` },
      }),
      ["c_1", "events"],
      upstream as unknown as typeof fetch,
    );
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cache-control")).toBe(
      "no-cache, no-transform",
    );
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(response.headers.get("content-encoding")).toBe("identity");
    expectCors(response);

    const preflight = await proxyManagedAuthRequest(
      request("/managed-auth-proxy/auth/connections/c_1/events", {
        method: "OPTIONS",
      }),
      ["c_1", "events"],
    );
    expect(preflight.status).toBe(204);
    expectCors(preflight);
  });

  test("enforces the request body limit and does not log secrets", async () => {
    const tooLarge = await proxyManagedAuthRequest(
      request("/managed-auth-proxy/auth/connections/c_1/exchange", {
        method: "POST",
        headers: { "content-length": String(65 * 1024) },
        body: "x",
      }),
      ["c_1", "exchange"],
    );
    expect(tooLarge.status).toBe(413);
    expectCors(tooLarge);

    let canceled = false;
    const chunkedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(32 * 1024));
        controller.enqueue(new Uint8Array(32 * 1024));
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        canceled = true;
      },
    });
    const chunked = await proxyManagedAuthRequest(
      new Request(
        "http://localhost:3002/managed-auth-proxy/auth/connections/c_1/exchange",
        { method: "POST", body: chunkedBody },
      ),
      ["c_1", "exchange"],
    );
    expect(chunked.status).toBe(413);
    expect(canceled).toBe(true);

    const calls: unknown[][] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...args) => calls.push(args);
    console.error = (...args) => calls.push(args);
    try {
      await proxyManagedAuthRequest(
        request("/managed-auth-proxy/auth/connections/c_1/exchange", {
          method: "POST",
          body: '{"code":"never-log-this"}',
        }),
        ["c_1", "exchange"],
        (async () =>
          new Response(
            '{"jwt":"never-log-this-either"}',
          )) as unknown as typeof fetch,
      );
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
    expect(calls).toHaveLength(0);
  });
});
