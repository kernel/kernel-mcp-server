import { z } from "zod";

function telemetryCategorySchema() {
  return z.object({
    enabled: z.boolean().optional(),
  });
}

const telemetryCategoriesSchema = z.object({
  captcha: telemetryCategorySchema().optional(),
  connection: telemetryCategorySchema().optional(),
  console: telemetryCategorySchema().optional(),
  control: telemetryCategorySchema().optional(),
  interaction: telemetryCategorySchema().optional(),
  network: telemetryCategorySchema().optional(),
  page: telemetryCategorySchema().optional(),
  screenshot: telemetryCategorySchema().optional(),
  system: telemetryCategorySchema().optional(),
});

export const managedAuthBrowserTelemetrySchema = z
  .object({
    enabled: z.boolean().optional(),
    browser: telemetryCategoriesSchema.optional(),
  })
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
