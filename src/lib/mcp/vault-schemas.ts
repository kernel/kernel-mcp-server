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
    "(get, events) One bounded server-side observation, in seconds (0-60). Not supported for invoke, list, or delete. Pending state is returned as-is; this never retries a payment or guarantees readiness.",
  )
  .optional();

const integer = () => z.number().int().safe();
const currency = () => z.string().regex(/^[A-Za-z]{3}$/);

// Keep provider specifications in sync with https://api.onkernel.com/spec.yaml.
export const linkWalletSpecSchema = z
  .object({
    provider: z.literal("link").optional(),
    authorization: z
      .object({
        method: z.literal("oauth"),
        client: z.object({ type: z.literal("kernel_managed") }).strict(),
      })
      .strict(),
  })
  .strict();

export const agentcardWalletSpecSchema = z
  .object({
    provider: z.literal("agentcard").optional(),
    user_id: z
      .string()
      .regex(/^usr_[A-Za-z0-9_]+$/)
      .describe("An AgentCard user already enrolled in this organization.")
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
    metadata: z.record(z.string()).optional(),
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
    "(create only) Project-owned vaults to attach, each with exactly one id or name; max 20. Bindings are immutable and unavailable for pooled browsers. Use only returned non-secret payment aliases in this browser.",
  )
  .optional();
