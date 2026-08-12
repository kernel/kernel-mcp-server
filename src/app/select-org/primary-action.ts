export type SelectionStage = "organization" | "scope";
export type SelectionScope = "organization" | "project" | "none";

export function primaryActionLabel({
  stage,
  isPending,
  organizationName,
  scope,
}: {
  stage: SelectionStage;
  isPending: boolean;
  organizationName?: string;
  scope: SelectionScope;
}): string {
  if (isPending) {
    return stage === "organization"
      ? "loading access options..."
      : "authorizing...";
  }

  if (stage === "organization") {
    return organizationName ? `continue with ${organizationName}` : "continue";
  }

  if (scope === "organization") return "authorize organization-wide";
  if (scope === "project") return "authorize selected project";
  return "select access to continue";
}
