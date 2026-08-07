import { describe, expect, test } from "bun:test";
import { runBrowserFileAction } from "@/lib/mcp/tools/browser-files";

function text(result: Awaited<ReturnType<typeof runBrowserFileAction>>) {
  return result.content[0].type === "text" ? result.content[0].text : undefined;
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

    const result = await runBrowserFileAction(fs, {
      action: "list",
      session_id: "session-1",
      path: "/tmp",
    });

    expect(JSON.parse(text(result)!)).toEqual({ items: entries });
  });

  test("reads text without wrapping the contents", async () => {
    const fs = {
      readFile: async () => new Response("hello\nworld\n"),
    } as any;

    const result = await runBrowserFileAction(fs, {
      action: "read",
      session_id: "session-1",
      path: "/tmp/hello.txt",
    });

    expect(text(result)).toBe("hello\nworld\n");
  });

  test("returns binary downloads as embedded resources", async () => {
    const fs = {
      readFile: async () =>
        new Response(new Uint8Array([0, 1, 2]), {
          headers: { "content-type": "image/png" },
        }),
    } as any;

    const result = await runBrowserFileAction(fs, {
      action: "download",
      session_id: "session-1",
      path: "/tmp/a file.png",
    });

    expect(result).toEqual({
      content: [
        {
          type: "resource",
          resource: {
            uri: "kernel-browser-file://session-1/tmp/a%20file.png",
            blob: "AAEC",
            mimeType: "image/png",
          },
        },
      ],
    });
  });

  test("decodes base64 writes", async () => {
    let written: Uint8Array | undefined;
    const fs = {
      writeFile: async (
        sessionId: string,
        contents: Uint8Array,
        params: { path: string; mode?: string },
      ) => {
        expect(sessionId).toBe("session-1");
        expect(params).toEqual({ path: "/tmp/file.bin", mode: "0600" });
        written = contents;
      },
    } as any;

    const result = await runBrowserFileAction(fs, {
      action: "write",
      session_id: "session-1",
      path: "/tmp/file.bin",
      content: "AAEC",
      encoding: "base64",
      mode: "0600",
    });

    expect([...written!]).toEqual([0, 1, 2]);
    expect(text(result)).toBe("Wrote file /tmp/file.bin");
  });

  test("rejects malformed base64 before writing", async () => {
    let called = false;
    const fs = {
      writeFile: async () => {
        called = true;
      },
    } as any;

    const result = await runBrowserFileAction(fs, {
      action: "write",
      session_id: "session-1",
      path: "/tmp/file.bin",
      content: "not base64!",
      encoding: "base64",
    });

    expect(called).toBe(false);
    expect("isError" in result && result.isError).toBe(true);
    expect(text(result)).toBe("Error: content is not valid base64.");
  });

  test("uploads multiple files", async () => {
    let uploaded: any;
    const fs = {
      upload: async (sessionId: string, params: any) => {
        expect(sessionId).toBe("session-1");
        uploaded = params;
      },
    } as any;

    const result = await runBrowserFileAction(fs, {
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
    expect(text(result)).toBe("Uploaded 2 file(s)");
  });

  test("downloads directories as embedded zip resources", async () => {
    const fs = {
      downloadDirZip: async () => new Response(new Uint8Array([80, 75])),
    } as any;

    const result = await runBrowserFileAction(fs, {
      action: "download_dir_zip",
      session_id: "session-1",
      path: "/tmp/reports/",
    });

    expect(result.content[0]).toEqual({
      type: "resource",
      resource: {
        uri: "kernel-browser-file://session-1/tmp/reports.zip",
        blob: "UEs=",
        mimeType: "application/zip",
      },
    });
  });

  test("routes filesystem mutations to the SDK", async () => {
    const calls: Array<[string, unknown]> = [];
    const fs = {
      createDirectory: async (_id: string, params: unknown) =>
        calls.push(["createDirectory", params]),
      move: async (_id: string, params: unknown) =>
        calls.push(["move", params]),
      deleteFile: async (_id: string, params: unknown) =>
        calls.push(["deleteFile", params]),
      deleteDirectory: async (_id: string, params: unknown) =>
        calls.push(["deleteDirectory", params]),
      setFilePermissions: async (_id: string, params: unknown) =>
        calls.push(["setFilePermissions", params]),
    } as any;

    await runBrowserFileAction(fs, {
      action: "create_directory",
      session_id: "session-1",
      path: "/tmp/new",
      mode: "0755",
    });
    await runBrowserFileAction(fs, {
      action: "move",
      session_id: "session-1",
      src_path: "/tmp/old",
      dest_path: "/tmp/new",
    });
    await runBrowserFileAction(fs, {
      action: "delete_file",
      session_id: "session-1",
      path: "/tmp/file",
    });
    await runBrowserFileAction(fs, {
      action: "delete_directory",
      session_id: "session-1",
      path: "/tmp/dir",
    });
    await runBrowserFileAction(fs, {
      action: "set_permissions",
      session_id: "session-1",
      path: "/tmp/file",
      mode: "0640",
      owner: "1000",
      group: "1000",
    });

    expect(calls).toEqual([
      ["createDirectory", { path: "/tmp/new", mode: "0755" }],
      ["move", { src_path: "/tmp/old", dest_path: "/tmp/new" }],
      ["deleteFile", { path: "/tmp/file" }],
      ["deleteDirectory", { path: "/tmp/dir" }],
      [
        "setFilePermissions",
        { path: "/tmp/file", mode: "0640", owner: "1000", group: "1000" },
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

    const result = await runBrowserFileAction(fs, {
      action: "move",
      session_id: "session-1",
      src_path: "/tmp/source",
    });

    expect("isError" in result && result.isError).toBe(true);
    expect(text(result)).toBe("Error: dest_path is required for move.");
  });
});
