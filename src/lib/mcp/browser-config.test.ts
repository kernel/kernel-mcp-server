/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import {
  buildBrowserCreateConfig,
  buildBrowserUpdateConfig,
} from "@/lib/mcp/browser-config";

test("browser create config rejects an empty start URL", () => {
  expect(buildBrowserCreateConfig({ start_url: "" })).toEqual({
    ok: false,
    error: "error: start_url must be a valid url.",
  });
});

test("browser update config forwards a start URL", () => {
  expect(
    buildBrowserUpdateConfig({ start_url: "https://example.com/checkout" }),
  ).toEqual({
    ok: true,
    value: { start_url: "https://example.com/checkout" },
  });
});

test("browser create config forwards multiple extensions and rejects aliases", () => {
  const extensions = [{ id: "ext_1" }, { name: "second-extension" }];
  expect(buildBrowserCreateConfig({ extensions })).toEqual({
    ok: true,
    value: { extensions },
  });
  expect(
    buildBrowserCreateConfig({
      extensions,
      extension_name: "legacy-extension",
    }),
  ).toEqual({
    ok: false,
    error:
      "error: extensions cannot be combined with extension_id or extension_name.",
  });
});
