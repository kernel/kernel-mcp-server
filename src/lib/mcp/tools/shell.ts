import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createKernelClient } from "@/lib/mcp/kernel-client";

export function registerShellTool(server: McpServer) {
  // exec_command -- Execute shell commands inside a browser VM
  server.tool(
    "exec_command",
    'Execute a command synchronously inside a browser VM. Returns stdout, stderr, and exit code. The command field is the executable; use args for its arguments. Common uses: read files (command: "cat", args: ["/var/log/supervisord.log"]), list dirs (command: "ls", args: ["/var/log"]), check DNS (command: "cat", args: ["/etc/resolv.conf"]), test connectivity (command: "curl", args: ["-I", "https://example.com"]).',
    {
      session_id: z.string().describe("Browser session ID."),
      command: z
        .string()
        .describe("Executable to run (e.g., 'cat', 'ls', 'curl')."),
      args: z
        .array(z.string())
        .describe("Arguments to pass to the command.")
        .optional(),
      cwd: z.string().describe("Working directory (absolute path).").optional(),
      timeout_sec: z
        .number()
        .describe("Max execution time in seconds.")
        .optional(),
      as_root: z.boolean().describe("Run with root privileges.").optional(),
    },
    {
      title: "Run shell command in browser VM",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    async ({ session_id, command, args, cwd, timeout_sec, as_root }, extra) => {
      if (!extra.authInfo) throw new Error("Authentication required");
      const client = createKernelClient(extra.authInfo.token);

      try {
        const result = await client.browsers.process.exec(session_id, {
          command,
          ...(args && { args }),
          ...(cwd && { cwd }),
          ...(timeout_sec !== undefined && { timeout_sec }),
          ...(as_root !== undefined && { as_root }),
        });

        const stdout = result.stdout_b64
          ? Buffer.from(result.stdout_b64, "base64").toString("utf-8")
          : "";
        const stderr = result.stderr_b64
          ? Buffer.from(result.stderr_b64, "base64").toString("utf-8")
          : "";

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  exit_code: result.exit_code,
                  duration_ms: result.duration_ms,
                  stdout,
                  stderr,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            { type: "text", text: `Error executing command: ${error}` },
          ],
        };
      }
    },
  );
}
