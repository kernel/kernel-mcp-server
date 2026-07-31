import { describe, expect, test } from "bun:test";
import { browserForMCP } from "./browsers";

describe("browserForMCP", () => {
  test("omits the CDP capability URL while preserving browser controls", () => {
    expect(
      browserForMCP({
        session_id: "browser_123",
        browser_live_view_url: "https://app.onkernel.com/browsers/browser_123",
        cdp_ws_url: "wss://api.onkernel.com/browser?token=do-not-expose",
        timeout_seconds: 60,
      }),
    ).toEqual({
      session_id: "browser_123",
      browser_live_view_url: "https://app.onkernel.com/browsers/browser_123",
      timeout_seconds: 60,
    });
  });
});
