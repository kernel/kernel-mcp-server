import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  defaultMcpDependencies,
  type McpDependencies,
} from "@/lib/mcp/dependencies";
import { longOperationOptions } from "@/lib/mcp/request-options";
import { throwToolError } from "@/lib/mcp/responses";
import {
  projectForOperation,
  projectSelectionInputSchema,
} from "@/lib/mcp/project-selection";

const DEFAULT_TIMEOUT_SEC = 60;
// Longest command we can wait out and still return its result in one request: this deadline
// plus the transport headroom has to finish inside a single serverless invocation, and 150s
// leaves margin under that limit. Raising it past what one invocation outlasts reintroduces
// the timeout the bound exists to prevent.
const MAX_TIMEOUT_SEC = 150;

export function registerShellTool(
  server: McpServer,
  options: McpDependencies = {
    ...defaultMcpDependencies,
  },
) {
  // exec_command -- Execute shell commands inside a browser VM
  server.registerTool(
    "exec_command",
    {
      description:
        'execute a command synchronously inside a browser vm. returns stdout, stderr, and exit code. the command field is the executable; use args for its arguments. common uses: read files (command: "cat", args: ["/var/log/supervisord.log"]), list dirs (command: "ls", args: ["/var/log"]), check dns (command: "cat", args: ["/etc/resolv.conf"]), test connectivity (command: "curl", args: ["-I", "https://example.com"]).',
      inputSchema: z.object({
        ...projectSelectionInputSchema(),
        session_id: z.string().describe("browser session id or name."),
        command: z
          .string()
          .describe("executable to run (e.g., 'cat', 'ls', 'curl')."),
        args: z
          .array(z.string())
          .describe("arguments to pass to the command.")
          .optional(),
        cwd: z
          .string()
          .describe("working directory (absolute path).")
          .optional(),
        timeout_sec: z
          .number()
          .int()
          .min(1)
          .max(MAX_TIMEOUT_SEC)
          .describe(
            `max execution time in seconds (1-${MAX_TIMEOUT_SEC}). the command is killed at the deadline. defaults to ${DEFAULT_TIMEOUT_SEC}.`,
          )
          .default(DEFAULT_TIMEOUT_SEC),
        as_root: z.boolean().describe("run with root privileges.").optional(),
      }),
      annotations: {
        title: "run shell command in browser vm",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (
      {
        session_id,
        command,
        args,
        cwd,
        timeout_sec,
        as_root,
        project,
        project_id,
      },
      ctx,
    ) => {
      if (!ctx.http?.authInfo) throw new Error("authentication required");
      const client = options.createKernelClient(
        ctx.http.authInfo.token,
        projectForOperation(ctx.http.authInfo, { project, project_id }),
      );

      try {
        const result = await client.browsers.process.exec(
          session_id,
          {
            command,
            ...(args && { args }),
            ...(cwd && { cwd }),
            timeout_sec,
            ...(as_root !== undefined && { as_root }),
          },
          longOperationOptions(timeout_sec),
        );

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
        throwToolError("exec_command", "exec", error);
      }
    },
  );
}
