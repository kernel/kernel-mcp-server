import { describe, expect, test } from "bun:test";
import { connectTestMcp } from "@/lib/mcp/mcp-test-fixtures";
import { registerBrowserFileTools } from "@/lib/mcp/tools/browser-files";

async function callBrowserFiles(fs: unknown, args: Record<string, unknown>) {
  const { client, close } = await connectTestMcp(registerBrowserFileTools, {
    browsers: { fs },
  });
  try {
    return await client.callTool({
      name: "manage_browser_files",
      arguments: args,
    });
  } finally {
    await close();
  }
}

function fileInfo(sizeBytes: number) {
  return async () => ({ size_bytes: sizeBytes });
}

function text(result: Awaited<ReturnType<typeof callBrowserFiles>>) {
  const [content] = result.content as Array<{ type: string; text?: string }>;
  return content.type === "text" ? content.text : undefined;
}

describe("manage_browser_files", () => {
  test("lists files", async () => {
    const entries = [
      {
        is_dir: false,
        mod_time: "2026-01-01T00:00:00Z",
        mode: "-rw-r--r--",
        name: "report.txt",
        path: "/tmp/report.txt",
        size_bytes: 6,
      },
    ];
    const fs = {
      listFiles: async (sessionId: string, params: { path: string }) => {
        expect(sessionId).toBe("session-1");
        expect(params).toEqual({ path: "/tmp" });
        return entries;
      },
    } as any;

    const result = await callBrowserFiles(fs, {
      action: "list",
      session_id: "session-1",
      path: "/tmp",
    });

    expect(JSON.parse(text(result)!)).toEqual({ items: entries });
  });

  test("reads text without wrapping the contents", async () => {
    const fs = {
      fileInfo: fileInfo(12),
      readFile: async () => new Response("hello\nworld\n"),
    } as any;

    const result = await callBrowserFiles(fs, {
      action: "read",
      session_id: "session-1",
      path: "/tmp/hello.txt",
    });

    expect(text(result)).toBe("hello\nworld\n");
  });

  test("returns binary downloads as octet-stream embedded resources", async () => {
    const fs = {
      fileInfo: fileInfo(3),
      readFile: async () =>
        new Response(new Uint8Array([0, 1, 2]), {
          headers: { "content-type": "application/octet-stream" },
        }),
    } as any;

    const result = await callBrowserFiles(fs, {
      action: "download",
      session_id: "session-1",
      path: "/tmp/a file.png",
    });

    expect(result.content).toEqual([
      {
        type: "resource",
        resource: {
          uri: "kernel-browser-file://session-1/tmp/a%20file.png",
          blob: "AAEC",
          mimeType: "application/octet-stream",
        },
      },
    ]);
  });

  test("decodes base64 writes", async () => {
    let written: Uint8Array | undefined;
    const fs = {
      writeFile: async (
        sessionId: string,
        contents: Uint8Array,
        params: { path: string; mode?: string },
        options: { maxRetries?: number },
      ) => {
        expect(sessionId).toBe("session-1");
        expect(params).toEqual({ path: "/tmp/file.bin", mode: "0600" });
        expect(options.maxRetries).toBe(0);
        written = contents;
      },
    } as any;

    const result = await callBrowserFiles(fs, {
      action: "write",
      session_id: "session-1",
      path: "/tmp/file.bin",
      content: "AAEC",
      encoding: "base64",
      mode: "0600",
    });

    expect([...written!]).toEqual([0, 1, 2]);
    expect(text(result)).toBe("wrote file /tmp/file.bin");
  });

  test("rejects malformed base64 before writing", async () => {
    let called = false;
    const fs = {
      writeFile: async () => {
        called = true;
      },
    } as any;

    const result = await callBrowserFiles(fs, {
      action: "write",
      session_id: "session-1",
      path: "/tmp/file.bin",
      content: "not base64!",
      encoding: "base64",
    });

    expect(called).toBe(false);
    expect(result.isError).toBe(true);
    expect(text(result)).toBe("error: content is not valid base64.");
  });

  test("uploads multiple files", async () => {
    let uploaded: any;
    const fs = {
      upload: async (sessionId: string, params: any) => {
        expect(sessionId).toBe("session-1");
        uploaded = params;
      },
    } as any;

    const result = await callBrowserFiles(fs, {
      action: "upload",
      session_id: "session-1",
      files: [
        { dest_path: "/tmp/one.txt", content: "one" },
        {
          dest_path: "/tmp/two.bin",
          content: "dHdv",
          encoding: "base64",
        },
      ],
    });

    expect(uploaded.files.map((file: any) => file.dest_path)).toEqual([
      "/tmp/one.txt",
      "/tmp/two.bin",
    ]);
    expect(await uploaded.files[0].file.text()).toBe("one");
    expect(await uploaded.files[1].file.text()).toBe("two");
    expect(text(result)).toBe("uploaded 2 file(s)");
  });

  test("downloads directories as embedded zip resources", async () => {
    const fs = {
      downloadDirZip: async () => new Response(new Uint8Array([80, 75])),
    } as any;

    const result = await callBrowserFiles(fs, {
      action: "download_dir_zip",
      session_id: "session-1",
      path: "/tmp/reports/",
    });

    expect((result.content as unknown[])[0]).toEqual({
      type: "resource",
      resource: {
        uri: "kernel-browser-file://session-1/tmp/reports.zip",
        blob: "UEs=",
        mimeType: "application/zip",
      },
    });
  });

  test("uses an absolute resource path when downloading the root directory", async () => {
    const fs = {
      downloadDirZip: async () => new Response(new Uint8Array([80, 75])),
    } as any;

    const result = await callBrowserFiles(fs, {
      action: "download_dir_zip",
      session_id: "session-1",
      path: "/",
    });

    expect((result.content as unknown[])[0]).toEqual({
      type: "resource",
      resource: {
        uri: "kernel-browser-file://session-1/browser-files.zip",
        blob: "UEs=",
        mimeType: "application/zip",
      },
    });
  });

  test("routes filesystem mutations to the SDK", async () => {
    const calls: Array<[string, unknown, number | undefined]> = [];
    const fs = {
      createDirectory: async (
        _id: string,
        params: unknown,
        options: { maxRetries?: number },
      ) => calls.push(["createDirectory", params, options.maxRetries]),
      move: async (
        _id: string,
        params: unknown,
        options: { maxRetries?: number },
      ) => calls.push(["move", params, options.maxRetries]),
      deleteFile: async (
        _id: string,
        params: unknown,
        options: { maxRetries?: number },
      ) => calls.push(["deleteFile", params, options.maxRetries]),
      deleteDirectory: async (
        _id: string,
        params: unknown,
        options: { maxRetries?: number },
      ) => calls.push(["deleteDirectory", params, options.maxRetries]),
      setFilePermissions: async (
        _id: string,
        params: unknown,
        options: { maxRetries?: number },
      ) => calls.push(["setFilePermissions", params, options.maxRetries]),
    } as any;

    await callBrowserFiles(fs, {
      action: "create_directory",
      session_id: "session-1",
      path: "/tmp/new",
      mode: "0755",
    });
    await callBrowserFiles(fs, {
      action: "move",
      session_id: "session-1",
      src_path: "/tmp/old",
      dest_path: "/tmp/new",
    });
    await callBrowserFiles(fs, {
      action: "delete_file",
      session_id: "session-1",
      path: "/tmp/file",
    });
    await callBrowserFiles(fs, {
      action: "delete_directory",
      session_id: "session-1",
      path: "/tmp/dir",
    });
    await callBrowserFiles(fs, {
      action: "set_permissions",
      session_id: "session-1",
      path: "/tmp/file",
      mode: "0640",
      owner: "1000",
      group: "1000",
    });

    expect(calls).toEqual([
      ["createDirectory", { path: "/tmp/new", mode: "0755" }, 0],
      ["move", { src_path: "/tmp/old", dest_path: "/tmp/new" }, 0],
      ["deleteFile", { path: "/tmp/file" }, 0],
      ["deleteDirectory", { path: "/tmp/dir" }, 0],
      [
        "setFilePermissions",
        { path: "/tmp/file", mode: "0640", owner: "1000", group: "1000" },
        0,
      ],
    ]);
  });

  test("reports missing action parameters without calling the SDK", async () => {
    const fs = new Proxy(
      {},
      {
        get: () => {
          throw new Error("unexpected SDK call");
        },
      },
    ) as any;

    const result = await callBrowserFiles(fs, {
      action: "move",
      session_id: "session-1",
      src_path: "/tmp/source",
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toBe("error: dest_path is required for move.");
  });

  test("rejects empty session IDs and paths before calling the SDK", async () => {
    const fs = new Proxy(
      {},
      {
        get: () => {
          throw new Error("unexpected SDK call");
        },
      },
    );

    for (const args of [
      { action: "list", session_id: "", path: "/tmp" },
      { action: "list", session_id: "session-1", path: "" },
      {
        action: "move",
        session_id: "session-1",
        src_path: "",
        dest_path: "/b",
      },
    ]) {
      const result = await callBrowserFiles(fs, args);
      expect(result.isError).toBe(true);
      expect(text(result)).not.toContain("unexpected SDK call");
    }
  });

  test("uses mime_type for downloads", async () => {
    const fs = {
      fileInfo: fileInfo(3),
      readFile: async () => new Response(new Uint8Array([0, 1, 2])),
    } as any;

    const result = await callBrowserFiles(fs, {
      action: "download",
      session_id: "session-1",
      path: "/tmp/a.png",
      mime_type: "image/png",
    });

    expect((result.content as unknown[])[0]).toEqual({
      type: "resource",
      resource: {
        uri: "kernel-browser-file://session-1/tmp/a.png",
        blob: "AAEC",
        mimeType: "image/png",
      },
    });
  });

  test("flags binary content returned by read", async () => {
    const fs = {
      fileInfo: fileInfo(3),
      readFile: async () => new Response(new Uint8Array([0xff, 0xfe, 0x00])),
    } as any;

    const result = await callBrowserFiles(fs, {
      action: "read",
      session_id: "session-1",
      path: "/tmp/a.bin",
    });

    expect(text(result)).toEndWith(
      '(note: this file appears binary; use "download" to get its bytes.)',
    );
  });

  test.each(["read", "download"])(
    "refuses to %s files over max_bytes without reading them",
    async (action) => {
      let read = false;
      const fs = {
        fileInfo: fileInfo(11 * 1024 * 1024),
        readFile: async () => {
          read = true;
          return new Response("");
        },
      } as any;

      const result = await callBrowserFiles(fs, {
        action,
        session_id: "session-1",
        path: "/tmp/big.log",
      });

      expect(read).toBe(false);
      expect(result.isError).toBe(true);
      expect(text(result)).toBe(
        'error: /tmp/big.log (11534336 bytes) exceeds max_bytes (10485760). use "list" or "get_info" to find a smaller file, or exec_command to split, compress, or filter it first.',
      );
    },
  );

  test("refuses a file that grows past max_bytes after the size check", async () => {
    const fs = {
      fileInfo: fileInfo(4),
      readFile: async () => new Response("grown"),
    } as any;

    const result = await callBrowserFiles(fs, {
      action: "read",
      session_id: "session-1",
      path: "/tmp/growing.log",
      max_bytes: 4,
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toStartWith(
      "error: /tmp/growing.log exceeds max_bytes (4).",
    );
  });

  test("stops reading directory archives at max_bytes", async () => {
    let cancelled = false;
    let retries: number | undefined;
    const fs = {
      downloadDirZip: async (
        _id: string,
        _params: unknown,
        options: { maxRetries?: number },
      ) => {
        retries = options.maxRetries;
        return new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(new Uint8Array(3));
            },
            cancel() {
              cancelled = true;
            },
          }),
        );
      },
    } as any;

    const result = await callBrowserFiles(fs, {
      action: "download_dir_zip",
      session_id: "session-1",
      path: "/home/kernel",
      max_bytes: 8,
    });

    expect(cancelled).toBe(true);
    expect(retries).toBe(0);
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(
      'error: the archive of /home/kernel exceeds max_bytes (8). use "list" to pick a smaller subdirectory, or exec_command to build a smaller archive.',
    );
  });

  test("uploads and extracts zip archives", async () => {
    let uploaded: any;
    let retries: number | undefined;
    const fs = {
      uploadZip: async (
        sessionId: string,
        params: unknown,
        options: { maxRetries?: number },
      ) => {
        expect(sessionId).toBe("session-1");
        uploaded = params;
        retries = options.maxRetries;
      },
    } as any;

    const result = await callBrowserFiles(fs, {
      action: "upload_zip",
      session_id: "session-1",
      dest_path: "/tmp/extracted",
      content: "UEs=",
      encoding: "base64",
    });

    expect(uploaded.dest_path).toBe("/tmp/extracted");
    expect(uploaded.zip_file.name).toBe("upload.zip");
    expect([...new Uint8Array(await uploaded.zip_file.arrayBuffer())]).toEqual([
      80, 75,
    ]);
    expect(retries).toBe(0);
    expect(text(result)).toBe(
      "uploaded and extracted archive to /tmp/extracted",
    );
  });

  test("rejects relative paths before calling the SDK", async () => {
    const fs = new Proxy(
      {},
      {
        get: () => {
          throw new Error("unexpected SDK call");
        },
      },
    );

    for (const args of [
      { action: "read", session_id: "session-1", path: "tmp/a.txt" },
      {
        action: "move",
        session_id: "session-1",
        src_path: "/a",
        dest_path: "b",
      },
      {
        action: "upload",
        session_id: "session-1",
        files: [{ dest_path: "a.txt", content: "a" }],
      },
    ]) {
      const result = await callBrowserFiles(fs, args);
      expect(result.isError).toBe(true);
      expect(text(result)).toContain(
        "must be an absolute path starting with /",
      );
    }
  });

  test("advertises inline path schemas", async () => {
    const { client, close } = await connectTestMcp(
      registerBrowserFileTools,
      {},
    );
    try {
      const { tools } = await client.listTools();
      expect(JSON.stringify(tools[0].inputSchema)).not.toContain("$ref");
    } finally {
      await close();
    }
  });
});
