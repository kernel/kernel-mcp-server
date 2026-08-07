import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toFile } from "@onkernel/sdk";
import { z } from "zod";
import { createKernelClient, type KernelClient } from "@/lib/mcp/kernel-client";
import {
  errorResponse,
  itemsJsonResponse,
  jsonResponse,
  textResponse,
  throwToolError,
} from "@/lib/mcp/responses";

const fileContentSchema = z.object({
  dest_path: z
    .string()
    .describe("Absolute destination path in the browser VM."),
  content: z.string().describe("File contents, encoded according to encoding."),
  encoding: z
    .enum(["utf8", "base64"])
    .describe("Encoding of content. Defaults to utf8.")
    .optional(),
});

const browserFileParamsSchema = z.object({
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
    .describe("Filesystem operation to perform."),
  session_id: z.string().describe("Browser session ID."),
  path: z
    .string()
    .describe("Absolute file or directory path in the browser VM.")
    .optional(),
  src_path: z.string().describe("(move) Absolute source path.").optional(),
  dest_path: z
    .string()
    .describe("(move, upload_zip) Absolute destination path.")
    .optional(),
  content: z
    .string()
    .describe("(write, upload_zip) Contents encoded according to encoding.")
    .optional(),
  encoding: z
    .enum(["utf8", "base64"])
    .describe("(write, upload_zip) Encoding of content. Defaults to utf8.")
    .optional(),
  files: z
    .array(fileContentSchema)
    .min(1)
    .describe("(upload) Files to upload in one request.")
    .optional(),
  mime_type: z
    .string()
    .describe(
      "(download) MIME type for the returned embedded resource. Defaults to the API response type or application/octet-stream.",
    )
    .optional(),
  mode: z
    .string()
    .regex(/^[0-7]{3,4}$/)
    .describe(
      "(write, create_directory, set_permissions) Octal permission mode, such as 644 or 0755.",
    )
    .optional(),
  owner: z
    .string()
    .describe("(set_permissions) New owner username or UID.")
    .optional(),
  group: z
    .string()
    .describe("(set_permissions) New group name or GID.")
    .optional(),
});

type BrowserFileParams = z.infer<typeof browserFileParamsSchema>;
type BrowserFsClient = KernelClient["browsers"]["fs"];

function required(value: string | undefined, name: string, action: string) {
  if (value !== undefined) return value;
  return errorResponse(`Error: ${name} is required for ${action}.`);
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
  const absolutePath = path.startsWith("/") ? path : `/${path}`;
  return absolutePath
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

async function responseBuffer(response: Response) {
  return Buffer.from(await response.arrayBuffer());
}

export async function runBrowserFileAction(
  fs: BrowserFsClient,
  params: BrowserFileParams,
) {
  switch (params.action) {
    case "list": {
      const path = required(params.path, "path", params.action);
      if (typeof path !== "string") return path;
      const files = await fs.listFiles(params.session_id, { path });
      return itemsJsonResponse(files, {
        emptyText: `No files found in ${path}`,
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
      const response = await fs.readFile(params.session_id, { path });
      return textResponse((await responseBuffer(response)).toString("utf8"));
    }
    case "download": {
      const path = required(params.path, "path", params.action);
      if (typeof path !== "string") return path;
      const response = await fs.readFile(params.session_id, { path });
      const buffer = await responseBuffer(response);
      return embeddedFileResponse(
        params.session_id,
        path,
        buffer,
        params.mime_type ||
          response.headers.get("content-type") ||
          "application/octet-stream",
      );
    }
    case "write": {
      const path = required(params.path, "path", params.action);
      if (typeof path !== "string") return path;
      const content = required(params.content, "content", params.action);
      if (typeof content !== "string") return content;
      const decoded = decodeContent(content, params.encoding);
      if (!decoded) return errorResponse("Error: content is not valid base64.");
      await fs.writeFile(params.session_id, decoded, {
        path,
        ...(params.mode && { mode: params.mode }),
      });
      return textResponse(`Wrote file ${path}`);
    }
    case "upload": {
      if (!params.files)
        return errorResponse("Error: files is required for upload.");
      const files = [];
      for (const file of params.files) {
        const decoded = decodeContent(file.content, file.encoding);
        if (!decoded) {
          return errorResponse(
            `Error: content for ${file.dest_path} is not valid base64.`,
          );
        }
        files.push({
          dest_path: file.dest_path,
          file: await toFile(decoded, file.dest_path.split("/").pop()),
        });
      }
      await fs.upload(params.session_id, { files });
      return textResponse(`Uploaded ${files.length} file(s)`);
    }
    case "upload_zip": {
      const destPath = required(params.dest_path, "dest_path", params.action);
      if (typeof destPath !== "string") return destPath;
      const content = required(params.content, "content", params.action);
      if (typeof content !== "string") return content;
      const decoded = decodeContent(content, params.encoding);
      if (!decoded) return errorResponse("Error: content is not valid base64.");
      await fs.uploadZip(params.session_id, {
        dest_path: destPath,
        zip_file: await toFile(decoded, "upload.zip"),
      });
      return textResponse(`Uploaded and extracted archive to ${destPath}`);
    }
    case "download_dir_zip": {
      const path = required(params.path, "path", params.action);
      if (typeof path !== "string") return path;
      const response = await fs.downloadDirZip(params.session_id, { path });
      return embeddedFileResponse(
        params.session_id,
        zipResourcePath(path),
        await responseBuffer(response),
        "application/zip",
      );
    }
    case "create_directory": {
      const path = required(params.path, "path", params.action);
      if (typeof path !== "string") return path;
      await fs.createDirectory(params.session_id, {
        path,
        ...(params.mode && { mode: params.mode }),
      });
      return textResponse(`Created directory ${path}`);
    }
    case "move": {
      const srcPath = required(params.src_path, "src_path", params.action);
      if (typeof srcPath !== "string") return srcPath;
      const destPath = required(params.dest_path, "dest_path", params.action);
      if (typeof destPath !== "string") return destPath;
      await fs.move(params.session_id, {
        src_path: srcPath,
        dest_path: destPath,
      });
      return textResponse(`Moved ${srcPath} to ${destPath}`);
    }
    case "delete_file": {
      const path = required(params.path, "path", params.action);
      if (typeof path !== "string") return path;
      await fs.deleteFile(params.session_id, { path });
      return textResponse(`Deleted file ${path}`);
    }
    case "delete_directory": {
      const path = required(params.path, "path", params.action);
      if (typeof path !== "string") return path;
      await fs.deleteDirectory(params.session_id, { path });
      return textResponse(`Deleted directory ${path}`);
    }
    case "set_permissions": {
      const path = required(params.path, "path", params.action);
      if (typeof path !== "string") return path;
      const mode = required(params.mode, "mode", params.action);
      if (typeof mode !== "string") return mode;
      await fs.setFilePermissions(params.session_id, {
        path,
        mode,
        ...(params.owner && { owner: params.owner }),
        ...(params.group && { group: params.group }),
      });
      return textResponse(`Updated permissions for ${path}`);
    }
  }
}

export function registerBrowserFileTools(server: McpServer) {
  server.tool(
    "manage_browser_files",
    'Read, write, upload, download, and manage files in a running browser VM. Use "read" for text content and "download" for binary files returned as an embedded MCP resource. Local files must be supplied as utf8 or base64 content because the remote MCP server cannot access paths on the caller\'s machine.',
    browserFileParamsSchema.shape,
    {
      title: "Manage browser VM files",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    async (params, extra) => {
      if (!extra.authInfo) throw new Error("Authentication required");
      const client = createKernelClient(extra.authInfo.token);

      try {
        return await runBrowserFileAction(client.browsers.fs, params);
      } catch (error) {
        throwToolError("manage_browser_files", params.action, error);
      }
    },
  );
}
