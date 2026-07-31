import { z } from "zod";

const telemetryCategorySchema = z
  .object({
    enabled: z.boolean().optional(),
  })
  .strict();

const telemetryCategoriesSchema = z
  .object({
    captcha: telemetryCategorySchema.optional(),
    connection: telemetryCategorySchema.optional(),
    console: telemetryCategorySchema.optional(),
    control: telemetryCategorySchema.optional(),
    interaction: telemetryCategorySchema.optional(),
    network: telemetryCategorySchema.optional(),
    page: telemetryCategorySchema.optional(),
    screenshot: telemetryCategorySchema.optional(),
    system: telemetryCategorySchema.optional(),
  })
  .strict();

export const managedAuthBrowserTelemetrySchema = z
  .object({
    enabled: z.boolean().optional(),
    browser: telemetryCategoriesSchema.optional(),
  })
  .strict()
  .superRefine((telemetry, context) => {
    if (
      telemetry.enabled === false &&
      telemetry.browser &&
      Object.keys(telemetry.browser).length > 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "browser_telemetry.enabled=false cannot be combined with browser category settings.",
      });
    }
  });

export type ManagedAuthBrowserTelemetry = z.infer<
  typeof managedAuthBrowserTelemetrySchema
>;
