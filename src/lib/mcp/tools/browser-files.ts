import type { McpServer } from "@modelcontextprotocol/server";
import { toFile } from "@onkernel/sdk";
import { z } from "zod";
import {
  defaultMcpDependencies,
  type McpDependencies,
} from "@/lib/mcp/dependencies";
import type { KernelClient } from "@/lib/mcp/kernel-client";
import {
  projectForOperation,
  projectSelectionInputSchema,
} from "@/lib/mcp/project-selection";
import {
  errorResponse,
  itemsJsonResponse,
  jsonResponse,
  textResponse,
  throwToolError,
} from "@/lib/mcp/responses";

// Responses are base64-encoded into a single JSON-RPC message, so reads are
// capped well below what an MCP client will accept in one result.
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const MAX_MAX_BYTES = 25 * 1024 * 1024;

const absolutePathSchema = z
  .string()
  .regex(/^\//, "must be an absolute path starting with /");

const fileContentSchema = z.object({
  dest_path: absolutePathSchema.describe(
    "absolute destination path in the browser vm.",
  ),
  content: z.string().describe("file contents, encoded according to encoding."),
  encoding: z
    .enum(["utf8", "base64"])
    .describe("encoding of content. defaults to utf8.")
    .optional(),
});

const browserFileParamsSchema = z.object({
  ...projectSelectionInputSchema(),
  action: z
    .enum([
      "list",
      "get_info",
      "read",
      "download",
      "write",
      "upload",
      "upload_zip",
      "download_dir_zip",
      "create_directory",
      "move",
      "delete_file",
      "delete_directory",
      "set_permissions",
    ])
    .describe("filesystem operation to perform."),
  session_id: z.string().min(1).describe("browser session id or name."),
  path: absolutePathSchema
    .describe(
      "(list, get_info, read, download, write, download_dir_zip, create_directory, delete_file, delete_directory, set_permissions) absolute file or directory path in the browser vm.",
    )
    .optional(),
  src_path: absolutePathSchema
    .describe("(move) absolute source path.")
    .optional(),
  dest_path: absolutePathSchema
    .describe("(move, upload_zip) absolute destination path.")
    .optional(),
  content: z
    .string()
    .describe("(write, upload_zip) contents encoded according to encoding.")
    .optional(),
  encoding: z
    .enum(["utf8", "base64"])
    .describe("(write, upload_zip) encoding of content. defaults to utf8.")
    .optional(),
  files: z
    .array(fileContentSchema)
    .min(1)
    .describe("(upload) files to upload in one request.")
    .optional(),
  mime_type: z
    .string()
    .describe(
      "(download) mime type for the returned embedded resource. the browser vm always serves files as application/octet-stream, so this is the only way to set a real type. defaults to application/octet-stream.",
    )
    .optional(),
  max_bytes: z
    .number()
    .int()
    .min(1)
    .max(MAX_MAX_BYTES)
    .describe(
      `(read, download, download_dir_zip) maximum bytes to return. defaults to ${DEFAULT_MAX_BYTES} (10 mib), up to ${MAX_MAX_BYTES} (25 mib). larger files and archives are refused, not truncated.`,
    )
    .optional(),
  mode: z
    .string()
    .regex(/^[0-7]{3,4}$/)
    .describe(
      "(write, create_directory, set_permissions) octal permission mode, such as 644 or 0755.",
    )
    .optional(),
  owner: z
    .string()
    .describe("(set_permissions) new owner username or uid.")
    .optional(),
  group: z
    .string()
    .describe("(set_permissions) new group name or gid.")
    .optional(),
});

type BrowserFileParams = z.infer<typeof browserFileParamsSchema>;
type BrowserFsClient = KernelClient["browsers"]["fs"];
type MutationOptions = { maxRetries: 0; signal: AbortSignal };

function required(value: string | undefined, name: string, action: string) {
  if (value !== undefined) return value;
  return errorResponse(`error: ${name} is required for ${action}.`);
}

function decodeContent(content: string, encoding: "utf8" | "base64" = "utf8") {
  if (encoding === "utf8") return Buffer.from(content, "utf8");

  const normalized = content.replace(/\s/g, "");
  if (
    normalized.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      normalized,
    )
  ) {
    return undefined;
  }
  return Buffer.from(normalized, "base64");
}

function encodedPath(path: string) {
  return path
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function zipResourcePath(path: string) {
  const directoryPath = path.replace(/\/+$/, "");
  return `${directoryPath || "/browser-files"}.zip`;
}

function embeddedFileResponse(
  sessionId: string,
  path: string,
  buffer: Buffer,
  mimeType: string,
) {
  return {
    content: [
      {
        type: "resource" as const,
        resource: {
          uri: `kernel-browser-file://${encodeURIComponent(sessionId)}${encodedPath(path)}`,
          blob: buffer.toString("base64"),
          mimeType,
        },
      },
    ],
  };
}

// Returns undefined once the body exceeds maxBytes, without buffering the rest.
async function boundedBuffer(response: Response, maxBytes: number) {
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel();
    return undefined;
  }
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function fileTooLarge(path: string, maxBytes: number, sizeBytes?: number) {
  const size = sizeBytes === undefined ? "" : ` (${sizeBytes} bytes)`;
  return errorResponse(
    `error: ${path}${size} exceeds max_bytes (${maxBytes}). use "list" or "get_info" to find a smaller file, or exec_command to split, compress, or filter it first.`,
  );
}

async function readCapped(
  fs: BrowserFsClient,
  sessionId: string,
  path: string,
  maxBytes: number,
) {
  const info = await fs.fileInfo(sessionId, { path });
  if (info.size_bytes > maxBytes) {
    return fileTooLarge(path, maxBytes, info.size_bytes);
  }
  // The file can grow between the size check and the read.
  const buffer = await boundedBuffer(
    await fs.readFile(sessionId, { path }),
    maxBytes,
  );
  return buffer ?? fileTooLarge(path, maxBytes);
}

async function runBrowserFileAction(
  fs: BrowserFsClient,
  params: BrowserFileParams,
  mutation: MutationOptions,
) {
  const maxBytes = params.max_bytes ?? DEFAULT_MAX_BYTES;

  switch (params.action) {
    case "list": {
      const path = required(params.path, "path", params.action);
      if (typeof path !== "string") return path;
      const files = await fs.listFiles(params.session_id, { path });
      return itemsJsonResponse(files, {
        emptyText: `no files found in ${path}`,
      });
    }
    case "get_info": {
      const path = required(params.path, "path", params.action);
      if (typeof path !== "string") return path;
      return jsonResponse(await fs.fileInfo(params.session_id, { path }));
    }
    case "read": {
      const path = required(params.path, "path", params.action);
      if (typeof path !== "string") return path;
      const buffer = await readCapped(fs, params.session_id, path, maxBytes);
      if (!Buffer.isBuffer(buffer)) return buffer;
      const text = buffer.toString("utf8");
      return textResponse(
        text.includes("\uFFFD")
          ? `${text}\n\n(note: this file appears binary; use "download" to get its bytes.)`
          : text,
      );
    }
    case "download": {
      const path = required(params.path, "path", params.action);
      if (typeof path !== "string") return path;
      const buffer = await readCapped(fs, params.session_id, path, maxBytes);
      if (!Buffer.isBuffer(buffer)) return buffer;
      return embeddedFileResponse(
        params.session_id,
        path,
        buffer,
        params.mime_type || "application/octet-stream",
      );
    }
    case "write": {
      const path = required(params.path, "path", params.action);
      if (typeof path !== "string") return path;
      const content = required(params.content, "content", params.action);
      if (typeof content !== "string") return content;
      const decoded = decodeContent(content, params.encoding);
      if (!decoded) return errorResponse("error: content is not valid base64.");
      await fs.writeFile(
        params.session_id,
        decoded,
        { path, ...(params.mode && { mode: params.mode }) },
        mutation,
      );
      return textResponse(`wrote file ${path}`);
    }
    case "upload": {
      if (!params.files)
        return errorResponse("error: files is required for upload.");
      const files = [];
      for (const file of params.files) {
        const decoded = decodeContent(file.content, file.encoding);
        if (!decoded) {
          return errorResponse(
            `error: content for ${file.dest_path} is not valid base64.`,
          );
        }
        files.push({
          dest_path: file.dest_path,
          file: await toFile(decoded, file.dest_path.split("/").pop()),
        });
      }
      await fs.upload(params.session_id, { files }, mutation);
      return textResponse(`uploaded ${files.length} file(s)`);
    }
    case "upload_zip": {
      const destPath = required(params.dest_path, "dest_path", params.action);
      if (typeof destPath !== "string") return destPath;
      const content = required(params.content, "content", params.action);
      if (typeof content !== "string") return content;
      const decoded = decodeContent(content, params.encoding);
      if (!decoded) return errorResponse("error: content is not valid base64.");
      await fs.uploadZip(
        params.session_id,
        { dest_path: destPath, zip_file: await toFile(decoded, "upload.zip") },
        mutation,
      );
      return textResponse(`uploaded and extracted archive to ${destPath}`);
    }
    case "download_dir_zip": {
      const path = required(params.path, "path", params.action);
      if (typeof path !== "string") return path;
      const buffer = await boundedBuffer(
        await fs.downloadDirZip(params.session_id, { path }),
        maxBytes,
      );
      if (!buffer) {
        return errorResponse(
          `error: the archive of ${path} exceeds max_bytes (${maxBytes}). use "list" to pick a smaller subdirectory, or exec_command to build a smaller archive.`,
        );
      }
      return embeddedFileResponse(
        params.session_id,
        zipResourcePath(path),
        buffer,
        "application/zip",
      );
    }
    case "create_directory": {
      const path = required(params.path, "path", params.action);
      if (typeof path !== "string") return path;
      await fs.createDirectory(
        params.session_id,
        { path, ...(params.mode && { mode: params.mode }) },
        mutation,
      );
      return textResponse(`created directory ${path}`);
    }
    case "move": {
      const srcPath = required(params.src_path, "src_path", params.action);
      if (typeof srcPath !== "string") return srcPath;
      const destPath = required(params.dest_path, "dest_path", params.action);
      if (typeof destPath !== "string") return destPath;
      await fs.move(
        params.session_id,
        { src_path: srcPath, dest_path: destPath },
        mutation,
      );
      return textResponse(`moved ${srcPath} to ${destPath}`);
    }
    case "delete_file": {
      const path = required(params.path, "path", params.action);
      if (typeof path !== "string") return path;
      await fs.deleteFile(params.session_id, { path }, mutation);
      return textResponse(`deleted file ${path}`);
    }
    case "delete_directory": {
      const path = required(params.path, "path", params.action);
      if (typeof path !== "string") return path;
      await fs.deleteDirectory(params.session_id, { path }, mutation);
      return textResponse(`deleted directory ${path}`);
    }
    case "set_permissions": {
      const path = required(params.path, "path", params.action);
      if (typeof path !== "string") return path;
      const mode = required(params.mode, "mode", params.action);
      if (typeof mode !== "string") return mode;
      await fs.setFilePermissions(
        params.session_id,
        {
          path,
          mode,
          ...(params.owner && { owner: params.owner }),
          ...(params.group && { group: params.group }),
        },
        mutation,
      );
      return textResponse(`updated permissions for ${path}`);
    }
  }
}

export function registerBrowserFileTools(
  server: McpServer,
  options: McpDependencies = {
    ...defaultMcpDependencies,
  },
) {
  server.registerTool(
    "manage_browser_files",
    {
      description:
        'read, write, upload, download, and manage files in a running browser vm. use "read" for text content and "download" for binary files returned as an embedded mcp resource. reads and downloads are capped by max_bytes (10 mib by default). local files must be supplied as utf8 or base64 content because the remote mcp server cannot access paths on the caller\'s machine.',
      inputSchema: browserFileParamsSchema,
      annotations: {
        title: "manage browser vm files",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params, ctx) => {
      if (!ctx.http?.authInfo) throw new Error("Authentication required");
      const client = options.createKernelClient(
        ctx.http.authInfo.token,
        projectForOperation(ctx.http.authInfo, params),
      );

      try {
        return await runBrowserFileAction(client.browsers.fs, params, {
          maxRetries: 0,
          signal: ctx.mcpReq.signal,
        });
      } catch (error) {
        throwToolError("manage_browser_files", params.action, error);
      }
    },
  );
}
