import { z } from "zod";

const authContextSchema = z.object({
  authorization: z.object({
    credential_scope: z.object({ project_id: z.string().min(1) }),
    effective_scope: z.object({ project_id: z.string().min(1) }),
  }),
});

export function assertProjectScopedCredential(value: unknown): void {
  const context = authContextSchema.parse(value);
  if (
    context.authorization.effective_scope.project_id !==
    context.authorization.credential_scope.project_id
  ) {
    throw new Error("Credential and effective project scopes differ");
  }
}

if (import.meta.main) {
  try {
    assertProjectScopedCredential(JSON.parse(await Bun.stdin.text()));
  } catch {
    console.error(
      "The benchmark credential must resolve to one matching project scope",
    );
    process.exit(1);
  }
}
