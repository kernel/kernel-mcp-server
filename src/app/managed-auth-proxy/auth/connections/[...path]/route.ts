const MAX_BODY_BYTES = 64 * 1024;
const ALLOWED_REQUEST_HEADERS = ["authorization", "content-type", "accept"];
const ALLOWED_METHODS = "GET, POST, OPTIONS";

type RouteContext = { params: Promise<{ path: string[] }> };
type FetchLike = typeof fetch;

function corsHeaders(cacheControl = "private, no-store") {
  return new Headers({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": ALLOWED_METHODS,
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept",
    "Cache-Control": cacheControl,
  });
}

function responseError(status: number, message: string) {
  return new Response(message, { status, headers: corsHeaders() });
}

function validOperation(path: string[], method: string): boolean {
  if (path.length === 1 && method === "GET") return path[0].length > 0;
  if (path.length !== 2 || !path[0] || !path[1]) return false;
  if (method === "POST") {
    return path[1] === "exchange" || path[1] === "submit";
  }
  return method === "GET" && path[1] === "events";
}

function pathExists(path: string[]): boolean {
  return (
    (path.length === 1 && !!path[0]) ||
    (path.length === 2 &&
      !!path[0] &&
      ["exchange", "submit", "events"].includes(path[1]))
  );
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
    return JSON.parse(atob(normalized + padding)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function managedAuthAuthorization(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer\s+([^\s]+)$/i);
  if (!match) return null;
  const claims = decodeJwtPayload(match[1]);
  if (
    claims?.iss !== "kernel-api" ||
    typeof claims.managed_auth_session_id !== "string" ||
    !claims.managed_auth_session_id ||
    typeof claims.exp !== "number" ||
    // Reject expired session JWTs at the relay boundary instead of
    // forwarding them upstream.
    claims.exp * 1000 <= Date.now()
  ) {
    return null;
  }
  return authorization;
}

async function readSmallBody(request: Request): Promise<ArrayBuffer | null> {
  const length = request.headers.get("content-length");
  if (length) {
    const parsedLength = Number(length);
    if (
      !Number.isSafeInteger(parsedLength) ||
      parsedLength < 0 ||
      parsedLength > MAX_BODY_BYTES
    ) {
      await request.body?.cancel();
      return null;
    }
  }

  if (!request.body) return new ArrayBuffer(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer;
}

export async function proxyManagedAuthRequest(
  request: Request,
  path: string[],
  fetchUpstream: FetchLike = fetch,
): Promise<Response> {
  if (new URL(request.url).search) {
    return responseError(400, "Query parameters are not allowed");
  }

  if (request.method === "OPTIONS") {
    return pathExists(path)
      ? new Response(null, { status: 204, headers: corsHeaders() })
      : responseError(404, "Not found");
  }

  if (!pathExists(path)) return responseError(404, "Not found");
  if (!validOperation(path, request.method)) {
    return responseError(405, "Method not allowed");
  }

  const isExchange = path.length === 2 && path[1] === "exchange";
  const authorization = isExchange ? null : managedAuthAuthorization(request);
  if (!isExchange && !authorization) {
    return responseError(401, "Invalid managed-auth authorization");
  }

  let body: ArrayBuffer | undefined;
  if (request.method === "POST") {
    const requestBody = await readSmallBody(request);
    if (requestBody === null) {
      return responseError(413, "Request body too large");
    }
    body = requestBody;
  }

  const upstreamHeaders = new Headers();
  for (const name of ALLOWED_REQUEST_HEADERS) {
    if (name === "authorization") continue;
    const value = request.headers.get(name);
    if (value) upstreamHeaders.set(name, value);
  }
  if (authorization) upstreamHeaders.set("authorization", authorization);

  const baseUrl = process.env.API_BASE_URL ?? "https://api.onkernel.com";
  const upstreamUrl = new URL(
    `/auth/connections/${path.map(encodeURIComponent).join("/")}`,
    baseUrl,
  );
  const upstream = await fetchUpstream(upstreamUrl, {
    method: request.method,
    headers: upstreamHeaders,
    ...(body && { body }),
    redirect: "manual",
  });

  if (upstream.status >= 300 && upstream.status < 400) {
    return responseError(502, "Upstream redirect rejected");
  }

  const isEvents = path.length === 2 && path[1] === "events";
  const headers = corsHeaders(
    isEvents ? "no-cache, no-transform" : "private, no-store",
  );
  const contentType = upstream.headers.get("content-type");
  if (isEvents) {
    headers.set("Content-Type", "text/event-stream");
    headers.set("X-Accel-Buffering", "no");
    headers.set("Content-Encoding", "identity");
  } else if (contentType) {
    headers.set("Content-Type", contentType);
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

async function handle(request: Request, context: RouteContext) {
  const { path } = await context.params;
  try {
    return await proxyManagedAuthRequest(request, path);
  } catch {
    return responseError(502, "Managed-auth relay unavailable");
  }
}

export const GET = handle;
export const HEAD = handle;
export const POST = handle;
export const OPTIONS = handle;
export const DELETE = handle;
export const PATCH = handle;
export const PUT = handle;
