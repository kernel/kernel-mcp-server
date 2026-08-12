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
      : "opening consent...";
  }

  if (stage === "organization") {
    return organizationName
      ? `choose access for ${organizationName}`
      : "choose access";
  }

  if (scope === "organization") return "review organization-wide access";
  if (scope === "project") return "review project access";
  return "select access to continue";
}
