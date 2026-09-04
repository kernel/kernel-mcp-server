import { z } from "zod";

const itemKey = z.string().regex(/^[a-zA-Z0-9._-]{1,255}$/);
const currency = z.string().regex(/^[A-Za-z]{3}$/);

const linkTotal = z
  .object({
    type: z.string(),
    display_text: z.string(),
    amount: z.number().int().describe("Amount in minor currency units."),
  })
  .strict();

const linkLineItem = z
  .object({
    name: z.string(),
    quantity: z.number().int().min(1).optional(),
    unit_amount: z.number().int().optional(),
    description: z.string().optional(),
    sku: z.string().optional(),
    url: z.string().optional(),
    image_url: z.string().optional(),
    product_url: z.string().optional(),
    totals: z.array(linkTotal).optional(),
  })
  .strict();

export const linkWalletSpecSchema = z
  .object({
    provider: z.literal("link"),
    authorization: z
      .object({
        method: z.literal("oauth"),
        client: z.object({ type: z.literal("kernel_managed") }).strict(),
      })
      .strict()
      .describe(
        "Kernel-managed OAuth only. Follow the returned action URL; never supply OAuth codes, tokens, or client secrets.",
      ),
  })
  .strict();

export const agentCardWalletSpecSchema = z
  .object({
    provider: z.literal("agentcard"),
    user_id: z
      .string()
      .regex(/^usr_[A-Za-z0-9_]+$/)
      .describe(
        "Optional user ID already enrolled by a wallet in this organization. Otherwise follow the returned card_enrollment action. Sandbox/live mode is deployment-configured, not an item option.",
      )
      .optional(),
  })
  .strict();

export const linkCardSpecSchema = z
  .object({
    provider: z.literal("link"),
    wallet: itemKey.describe("Connected Link wallet item key in this vault."),
    payment_method_id: z
      .string()
      .min(1)
      .describe(
        "Select an ID from this wallet's advertised payment_methods expansion. Missing capability data is unknown, not ineligible; the provider decides eligibility.",
      ),
    amount: z
      .number()
      .int()
      .min(1)
      .max(500000)
      .describe(
        "Requested amount in minor currency units, not a decimal price.",
      ),
    currency,
    merchant_name: z.string().min(1).max(255),
    merchant_url: z
      .string()
      .url()
      .describe(
        "Merchant URL for this purchase. Permitted domains are returned in state.domains; there is no writable domains field.",
      ),
    context: z
      .string()
      .min(100)
      .describe(
        "At least 100 characters of non-sensitive purchase context for the approval request.",
      ),
    test: z
      .boolean()
      .describe(
        "Required explicit intent: true requests test credentials; false requests a live credential. Neither submits a merchant payment.",
      ),
    expires_at: z.number().int().optional(),
    line_items: z.array(linkLineItem).optional(),
    totals: z.array(linkTotal).optional(),
    metadata: z
      .record(z.string())
      .describe(
        "Non-sensitive purchase metadata only. Never include card data, tokens, codes, ciphertext, or provider secrets. Omitted from MCP responses.",
      )
      .optional(),
  })
  .strict();

export const agentCardCardSpecSchema = z
  .object({
    provider: z.literal("agentcard"),
    wallet: itemKey.describe(
      "AgentCard wallet item key in this vault. Complete its enrollment before checkout.",
    ),
    merchant: z
      .string()
      .min(1)
      .max(120)
      .describe("Merchant shown on the cardholder's approval screen."),
    amount: z
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .describe("Amount in minor currency units for the checkout approval."),
    currency,
    card_id: z
      .string()
      .regex(/^vc_[A-Za-z0-9_]+$/)
      .describe(
        "Optional vaulted card ID from the wallet's payment_methods expansion; omit to let the cardholder choose on the approval screen. No per-item test flag: confirm deployment sandbox/live mode before checkout.",
      )
      .optional(),
  })
  .strict();

export const cardSpecSchema = z.discriminatedUnion("provider", [
  linkCardSpecSchema,
  agentCardCardSpecSchema,
]);

export const vaultItemInputSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("wallet"),
      spec: z.discriminatedUnion("provider", [
        linkWalletSpecSchema,
        agentCardWalletSpecSchema,
      ]),
    })
    .strict(),
  z.object({ type: z.literal("card"), spec: cardSpecSchema }).strict(),
]);

export const vaultItemKeySchema = itemKey;
