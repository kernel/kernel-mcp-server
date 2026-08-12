import { describe, expect, test } from "bun:test";
import { primaryActionLabel } from "./primary-action";

describe("select organization primary action", () => {
  test("describes the selected organization and pending access-options load", () => {
    expect(
      primaryActionLabel({
        stage: "organization",
        isPending: false,
        organizationName: "Kernel",
        scope: "organization",
      }),
    ).toBe("continue with Kernel");
    expect(
      primaryActionLabel({
        stage: "organization",
        isPending: true,
        organizationName: "Kernel",
        scope: "organization",
      }),
    ).toBe("loading access options...");
  });

  test("describes organization, project, unselected, and pending authorization", () => {
    expect(
      primaryActionLabel({
        stage: "scope",
        isPending: false,
        scope: "organization",
      }),
    ).toBe("authorize organization-wide");
    expect(
      primaryActionLabel({
        stage: "scope",
        isPending: false,
        scope: "project",
      }),
    ).toBe("authorize selected project");
    expect(
      primaryActionLabel({
        stage: "scope",
        isPending: false,
        scope: "none",
      }),
    ).toBe("select access to continue");
    expect(
      primaryActionLabel({
        stage: "scope",
        isPending: true,
        scope: "project",
      }),
    ).toBe("authorizing...");
  });
});
