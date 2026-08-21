import fs from "node:fs";
import http from "node:http";

const listenPort = Number(process.env.KERNEL_MCP_PROXY_PORT || 3002);
const upstreamPort = Number(process.env.KERNEL_MCP_SERVER_PORT || 3003);
const logPath =
  process.env.KERNEL_MCP_REQUEST_LOG || "/logs/kernel-mcp/requests.jsonl";

function requestMetadata(body) {
  try {
    const payload = JSON.parse(body);
    return {
      jsonrpc_method: payload.method ?? null,
      tool_name:
        payload.method === "tools/call" ? (payload.params?.name ?? null) : null,
      request_id: payload.id ?? null,
    };
  } catch {
    return { jsonrpc_method: null, tool_name: null, request_id: null };
  }
}

function responseSucceeded(statusCode, body) {
  if (statusCode < 200 || statusCode >= 300) return false;
  const candidates = body
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());
  if (candidates.length === 0) candidates.push(body.trim());

  for (const candidate of candidates) {
    if (!candidate || candidate === "[DONE]") continue;
    try {
      const payload = JSON.parse(candidate);
      if (payload.error || payload.result?.isError === true) return false;
    } catch {
      // Non-JSON response bodies are successful when the HTTP status succeeded.
    }
  }
  return true;
}

function appendLog(entry) {
  fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

const server = http.createServer((clientRequest, clientResponse) => {
  const startedAt = new Date();
  const requestChunks = [];

  clientRequest.on("data", (chunk) => requestChunks.push(chunk));
  clientRequest.on("end", () => {
    const requestBody = Buffer.concat(requestChunks);
    const metadata = requestMetadata(requestBody.toString("utf8"));
    const headers = { ...clientRequest.headers };
    headers.host = `127.0.0.1:${upstreamPort}`;
    headers["content-length"] = String(requestBody.length);

    const upstreamRequest = http.request(
      {
        host: "127.0.0.1",
        port: upstreamPort,
        method: clientRequest.method,
        path: clientRequest.url,
        headers,
      },
      (upstreamResponse) => {
        const responseChunks = [];
        upstreamResponse.on("data", (chunk) => responseChunks.push(chunk));
        upstreamResponse.on("end", () => {
          const responseBody = Buffer.concat(responseChunks);
          const statusCode = upstreamResponse.statusCode ?? 502;
          clientResponse.writeHead(statusCode, upstreamResponse.headers);
          clientResponse.end(responseBody);

          appendLog({
            started_at: startedAt.toISOString(),
            duration_ms: Date.now() - startedAt.getTime(),
            http_method: clientRequest.method,
            path: clientRequest.url,
            http_status: statusCode,
            success: responseSucceeded(
              statusCode,
              responseBody.toString("utf8"),
            ),
            ...metadata,
          });
        });
      },
    );

    upstreamRequest.on("error", (error) => {
      if (!clientResponse.headersSent) clientResponse.writeHead(502);
      clientResponse.end("Bad Gateway");
      appendLog({
        started_at: startedAt.toISOString(),
        duration_ms: Date.now() - startedAt.getTime(),
        http_method: clientRequest.method,
        path: clientRequest.url,
        http_status: 502,
        success: false,
        error: error.message,
        ...metadata,
      });
    });
    upstreamRequest.end(requestBody);
  });
});

server.listen(listenPort, "127.0.0.1", () => {
  console.log(`MCP telemetry proxy listening on 127.0.0.1:${listenPort}`);
});
