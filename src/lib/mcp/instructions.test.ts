import { describe, expect, test } from "bun:test";
import { description } from "../../../server.json";
import { MCP_SERVER_INSTRUCTIONS } from "./instructions";

describe("MCP server metadata", () => {
  // Exceeding the schema's 100-character cap fails registry publication, not CI.
  test("registry description fits the schema limit", () => {
    expect(description.length).toBeLessThanOrEqual(100);
  });

  test("instructions list the execution layers in escalation order", () => {
    const webmcp = MCP_SERVER_INSTRUCTIONS.indexOf("webmcp");
    const repl = MCP_SERVER_INSTRUCTIONS.indexOf("browser_repl");
    const playwright = MCP_SERVER_INSTRUCTIONS.indexOf(
      "execute_playwright_code",
    );
    const computerUse = MCP_SERVER_INSTRUCTIONS.indexOf("computer_action");

    expect(webmcp).toBeGreaterThanOrEqual(0);
    expect(repl).toBeGreaterThan(webmcp);
    expect(playwright).toBeGreaterThan(repl);
    expect(computerUse).toBeGreaterThan(playwright);
  });
});
