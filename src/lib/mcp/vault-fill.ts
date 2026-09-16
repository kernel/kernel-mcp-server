import { z } from "zod";
import { jsonResponse, errorResponse } from "@/lib/mcp/responses";

export const vaultFillSchema = z
  .object({
    browser_id: z
      .string()
      .min(1)
      .describe(
        "Browser session ID, not a reusable name. The vault must already be attached.",
      ),
    page_url: z
      .string()
      .url()
      .regex(/^\S+$/)
      .optional()
      .describe(
        "Exact existing top-level page URL; never navigates. Optional only for credentials with exactly one open page.",
      ),
    fields: z
      .array(
        z
          .object({
            field: z
              .string()
              .min(1)
              .describe(
                "Declared credential field name or supported card field, not a value.",
              ),
            selector: z.string().min(1),
            format: z
              .enum(["MM/YY", "MM/YYYY"])
              .optional()
              .describe(
                "Only for a card's combined expiration field. Forbidden for credential fields.",
              ),
          })
          .strict(),
      )
      .min(1)
      .max(32),
    timeout_ms: z.number().int().min(1).max(30000).optional(),
  })
  .strict()
  .refine(
    (fill) => Buffer.byteLength(JSON.stringify(fill), "utf8") <= 128 * 1024,
  );

const resultSchema = z.object({
  type: z.literal("fill"),
  status: z.enum(["completed", "failed", "unknown"]),
  fields: z.array(
    z.object({
      index: z.number().int().min(0),
      status: z.enum(["filled", "failed", "unknown", "not_attempted"]),
      error_code: z
        .enum([
          "target_changed",
          "element_not_found",
          "ambiguous_selector",
          "element_not_editable",
          "option_not_found",
          "timeout",
          "execution_failed",
        ])
        .optional(),
    }),
  ),
});

export function unconfirmedVaultFillResponse() {
  return errorResponse(
    "Fill did not return a confirmed result; browser fields may have been written. Inspect the browser. Never automatically retry or fall back to aliases.",
  );
}

export function vaultFillResponse(value: unknown, count: number) {
  const parsed = resultSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.fields.length !== count ||
    parsed.data.fields.some((field, index) => field.index !== index) ||
    (parsed.data.status === "completed" &&
      parsed.data.fields.some((field) => field.status !== "filled"))
  )
    return unconfirmedVaultFillResponse();
  return {
    ...jsonResponse({
      result: parsed.data,
      guidance:
        "Fill never submits or navigates. Completed means fields were filled, not website acceptance. Real values enter the browser and can be observed by an agent with browser access. Failed or unknown may leave partial writes; inspect the browser and never automatically retry or fall back to aliases.",
    }),
    isError: parsed.data.status !== "completed",
  };
}
