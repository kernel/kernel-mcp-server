/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import { buildBrowserCreateConfig } from "@/lib/mcp/browser-config";

test("browser create config rejects an empty start URL", () => {
  expect(buildBrowserCreateConfig({ start_url: "" })).toEqual({
    ok: false,
    error: "Error: start_url must be a valid URL.",
  });
});
