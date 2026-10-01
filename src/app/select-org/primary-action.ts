export type SelectionStage = "organization" | "scope";
export type SelectionScope = "organization" | "project" | "none";

export function primaryActionLabel({
  stage,
  isPending,
  scope,
}: {
  stage: SelectionStage;
  isPending: boolean;
  scope: SelectionScope;
}): string {
  if (isPending) {
    return stage === "organization"
      ? "selecting organization..."
      : "selecting scope...";
  }

  if (stage === "organization") return "select organization";
  if (scope === "organization") return "select organization scope";
  if (scope === "project") return "select project scope";
  return "select scope";
}
