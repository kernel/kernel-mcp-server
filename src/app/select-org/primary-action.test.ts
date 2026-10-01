import { describe, expect, test } from "bun:test";
import { primaryActionLabel } from "./primary-action";

describe("select organization primary action", () => {
  test("labels organization selection and its pending state", () => {
    expect(
      primaryActionLabel({
        stage: "organization",
        isPending: false,
        scope: "organization",
      }),
    ).toBe("select organization");
    expect(
      primaryActionLabel({
        stage: "organization",
        isPending: true,
        scope: "organization",
      }),
    ).toBe("selecting organization...");
  });

  test("labels organization, project, unselected, and pending scope states", () => {
    expect(
      primaryActionLabel({
        stage: "scope",
        isPending: false,
        scope: "organization",
      }),
    ).toBe("select organization scope");
    expect(
      primaryActionLabel({
        stage: "scope",
        isPending: false,
        scope: "project",
      }),
    ).toBe("select project scope");
    expect(
      primaryActionLabel({
        stage: "scope",
        isPending: false,
        scope: "none",
      }),
    ).toBe("select scope");
    expect(
      primaryActionLabel({
        stage: "scope",
        isPending: true,
        scope: "project",
      }),
    ).toBe("selecting scope...");
  });
});
