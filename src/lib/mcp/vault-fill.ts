import { z } from "zod";
import { APIError } from "@onkernel/sdk";
import {
  jsonResponse,
  errorResponse,
  throwToolError,
} from "@/lib/mcp/responses";

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
    timeout_ms: z
      .number()
      .int()
      .min(1)
      .max(30000)
      .optional()
      .describe(
        "Total operation deadline in milliseconds, not per field. Default 10000.",
      ),
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

const fillErrorMessages = new Map([
  [
    "invalid_request",
    "Invalid fill request. Check field names, formats, and browser parameters.",
  ],
  [
    "invalid_selector",
    "Invalid selector. Inspect the page and correct the selector.",
  ],
  [
    "duplicate_target",
    "Multiple bindings resolve to the same element. Use distinct targets.",
  ],
  [
    "destination_denied",
    "Destination or browser vault binding is not authorized. Check the bound browser and destination.",
  ],
  [
    "not_found",
    "The requested vault, item, or browser was not found. Check the identifiers and project.",
  ],
  [
    "conflict",
    "The item or browser is not ready for fill. Inspect readiness, binding, and any unresolved prior operation.",
  ],
  [
    "page_not_found",
    "No open page matches page_url. Inspect the browser and use its exact current URL.",
  ],
  [
    "ambiguous_page",
    "More than one page matches. Supply a URL identifying exactly one open page.",
  ],
  [
    "element_not_found",
    "No editable target matches a selector. Inspect the page and correct the binding.",
  ],
  [
    "ambiguous_selector",
    "A selector matches multiple targets across frames. Use a unique selector.",
  ],
  [
    "element_not_editable",
    "A selected element is not editable. Choose an editable input or select.",
  ],
  ["option_not_found", "The select has no matching option value."],
  [
    "field_unavailable",
    "A requested field has no usable stored value. Inspect field definitions and presence; collect missing values.",
  ],
  [
    "target_changed",
    "The page or target changed. Inspect the current page before choosing new bindings.",
  ],
  ["timeout", "The fill deadline elapsed."],
]);

export function throwVaultFillError(error: unknown): never {
  if (error instanceof APIError && typeof error.status === "number") {
    const parsed = z
      .object({ code: z.string().optional() })
      .safeParse(error.error);
    const code = parsed.success ? parsed.data.code : undefined;
    const message = code ? fillErrorMessages.get(code) : undefined;
    const preWrite = [400, 403, 404, 409].includes(error.status);
    const guidance = preWrite
      ? "No fields were written by this request. Inspect and correct the cause before deciding on a new fill; do not automatically retry."
      : "Browser fields may have been written. Inspect the browser. Never automatically retry or fall back to aliases.";
    throwToolError(
      "manage_vault_items",
      "invoke",
      APIError.generate(
        error.status,
        {
          message: `${message ?? "Fill request failed."} ${guidance}`,
          ...(message !== undefined && { code }),
        },
        undefined,
        new Headers(),
      ),
    );
  }
  throwToolError(
    "manage_vault_items",
    "invoke",
    new Error(
      "Fill did not return a confirmed result; browser fields may have been written. Inspect the browser. Never automatically retry or fall back to aliases.",
    ),
  );
}

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
