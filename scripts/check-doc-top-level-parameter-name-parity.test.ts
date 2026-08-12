import { describe, expect, test } from "bun:test";
import {
  parityError,
  parseParameterNames,
} from "./check-doc-top-level-parameter-name-parity";

describe("parseParameterNames", () => {
  test("reads individual and grouped parameter cells", () => {
    const markdown = `
## Parameters

| Parameter | Description |
| --- | --- |
| \`action\` | Required. |
| \`profile_id\` or \`profile_name\` | Choose one. |

## Examples
`;

    expect([...parseParameterNames(markdown)].sort()).toEqual([
      "action",
      "profile_id",
      "profile_name",
    ]);
  });

  test("rejects a missing parameter table", () => {
    expect(() => parseParameterNames("## Examples\n")).toThrow(
      "missing Parameters section",
    );
  });

  test("reads a parameter table at the end of a document", () => {
    expect([
      ...parseParameterNames(`## Parameters

| Parameter | Description |
| --- | --- |
| \`action\` | Required. |
`),
    ]).toEqual(["action"]);
  });
});

describe("parityError", () => {
  test("accepts equal parameter sets", () => {
    expect(
      parityError("manage_profiles", new Set(["action"]), new Set(["action"])),
    ).toBeUndefined();
  });

  test("reports undocumented and stale parameters", () => {
    expect(
      parityError(
        "manage_profiles",
        new Set(["action", "query"]),
        new Set(["action", "old_query"]),
      ),
    ).toBe(
      "manage_profiles: missing from docs: query; not in schema: old_query",
    );
  });
});
