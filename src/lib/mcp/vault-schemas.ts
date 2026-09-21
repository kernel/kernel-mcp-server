import { z } from "zod";
import { projectSelectionInputSchema } from "@/lib/mcp/project-selection";

// Fresh schemas per property keep tools/list contracts inline instead of emitting $refs.
export function vaultSelectorSchema() {
  return z
    .string()
    .regex(/^[a-zA-Z0-9._-]{1,255}$/)
    .refine(
      (value) => value !== "." && value !== "..",
      "Invalid vault selector.",
    );
}

export const vaultProjectSchema = projectSelectionInputSchema({
  project:
    "Optional project name or ID. Vaults are project-owned: omit to use the API's effective default project, not all projects. A project-scoped connection cannot select a different project.",
});

export const vaultItemSchema = {
  ...vaultProjectSchema,
  vault: vaultSelectorSchema().describe("Vault ID or immutable name."),
};

export function vaultOperationRequiresInputs(
  operation: string,
): operation is "fill" | "prepare_checkout" {
  return operation === "fill" || operation === "prepare_checkout";
}

export function vaultKeySchema() {
  return vaultSelectorSchema().describe(
    "Immutable item key within the vault, not the item ID.",
  );
}
export const vaultProviderSchema = z.enum(["link", "agentcard"]);
export const vaultWaitSchema = z
  .number()
  .int()
  .min(0)
  .max(60)
  .describe(
    "(get, events) One bounded server-side observation, in seconds (0-60). Not supported for invoke, list, or delete. Pending state is returned as-is; this never retries an operation or guarantees readiness. For credentials, wait observes required-value readiness, not edits to an already-ready item; compare version using get without wait.",
  )
  .optional();

const integer = () => z.number().int().safe();
const currency = () => z.string().regex(/^[A-Za-z]{3}$/);

export function providerConfigReferenceSchema() {
  return z
    .object({
      id: vaultSelectorSchema().optional(),
      name: vaultSelectorSchema().optional(),
    })
    .strict()
    .refine(
      (value) => (value.id !== undefined) !== (value.name !== undefined),
      "Provide exactly one provider config id or name.",
    );
}

// Preserve the advertised schema and parsed values, but never serialize rejected
// vault values or nested keys into MCP validation errors.
export function vaultToolInput<Shape extends z.ZodRawShape>(shape: Shape) {
  const schema = z.object(shape);
  return {
    "~standard": {
      ...schema["~standard"],
      validate(value: unknown) {
        const result = schema.safeParse(value);
        if (result.success) return { value: result.data };
        return {
          issues: result.error.issues.map((issue) => ({
            message: "Invalid vault tool input. Check the documented schema.",
            path: issue.path.slice(0, 1),
          })),
        };
      },
    },
  };
}

export const providerCredentialsSchema = z
  .object({
    client_id: z.string().min(1).optional(),
    client_secret: z
      .string()
      .min(1)
      .describe(
        "Write-only secret; supply through a trusted client, never chat.",
      ),
  })
  .strict();

// Keep provider specifications in sync with https://api.onkernel.com/spec.yaml.
export const linkWalletSpecSchema = z
  .object({
    provider: z.literal("link").optional(),
    authorization: z.union([
      z
        .object({
          method: z.literal("oauth"),
          client: z.object({ type: z.literal("kernel_managed") }).strict(),
        })
        .strict(),
      z
        .object({
          method: z.literal("oauth"),
          client: z
            .object({
              type: z.literal("customer_managed"),
              provider_config: providerConfigReferenceSchema(),
            })
            .strict(),
          tokens: z
            .object({
              access_token: z.string().min(1),
              refresh_token: z.string().min(1),
            })
            .strict()
            .describe(
              "Write-only token pair from the same grant. Supply through a trusted backend, never chat. Kernel owns subsequent refresh rotation.",
            ),
        })
        .strict(),
    ]),
  })
  .strict();

export const agentcardWalletSpecSchema = z
  .object({
    provider: z.literal("agentcard").optional(),
    provider_config: providerConfigReferenceSchema().optional(),
    user_id: z
      .string()
      .regex(/^usr_[A-Za-z0-9_]+$/)
      .describe(
        "An AgentCard user already enrolled in this organization under the same provider configuration.",
      )
      .optional(),
  })
  .strict();

function linkTotalSchema() {
  return z
    .object({
      type: z.string(),
      display_text: z.string(),
      amount: integer().describe("Integer minor currency units."),
    })
    .strict();
}

const linkLineItemSchema = z
  .object({
    name: z.string(),
    quantity: integer().min(1).optional(),
    unit_amount: integer().optional(),
    description: z.string().optional(),
    sku: z.string().optional(),
    url: z.string().optional(),
    image_url: z.string().optional(),
    product_url: z.string().optional(),
    totals: z.array(linkTotalSchema()).optional(),
  })
  .strict();

export const linkCardSpecSchema = z
  .object({
    provider: z.literal("link").optional(),
    wallet: vaultKeySchema(),
    payment_method_id: z
      .string()
      .min(1)
      .describe(
        "Explicitly selected ID from the wallet's payment_methods expansion.",
      ),
    amount: integer()
      .min(1)
      .max(500000)
      .describe("Integer minor currency units."),
    currency: currency(),
    merchant_name: z.string().min(1).max(255),
    merchant_url: z.string().url(),
    context: z.string().min(100),
    line_items: z.array(linkLineItemSchema).optional(),
    totals: z.array(linkTotalSchema()).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    expires_at: integer().optional(),
  })
  .strict();

export const agentcardCardSpecSchema = z
  .object({
    provider: z.literal("agentcard").optional(),
    wallet: vaultKeySchema(),
    merchant: z.string().min(1).max(120),
    amount: integer().min(1).describe("Integer minor currency units."),
    currency: currency(),
    card_id: z
      .string()
      .regex(/^vc_[A-Za-z0-9_]+$/)
      .describe(
        "Optional funding card. Omit for cardholder selection at approval.",
      )
      .optional(),
  })
  .strict();

export const browserVaultsSchema = z
  .array(
    z
      .object({
        id: vaultSelectorSchema().optional(),
        name: vaultSelectorSchema().optional(),
      })
      .strict()
      .refine(
        (value) => (value.id !== undefined) !== (value.name !== undefined),
        "Provide exactly one of id or name for each vault.",
      ),
  )
  .max(20)
  .refine(
    (values) =>
      new Set(values.map((value) => value.id ?? value.name)).size ===
      values.length,
    "Duplicate vault references are not allowed.",
  )
  .describe(
    "(create only) Project-owned vaults to attach, each with exactly one id or name; max 20. Bindings are immutable and unavailable for pooled browsers. Use a separate vault per end user. Attaching grants access to all items, including items added later. Credential fill writes real values into the page; it does not isolate them from an agent with browser access. Link cards use fill, not aliases or egress substitution. AgentCard aliases remain a separate, explicitly chosen egress path; never fall back to aliases after an uncertain fill.",
  )
  .optional();
