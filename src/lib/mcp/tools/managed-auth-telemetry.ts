import { z } from "zod";

function telemetryCategorySchema() {
  return z.object({
    enabled: z.boolean().optional(),
  });
}

const cdpCommandMethodSchema = z.enum([
  "Input.dispatchMouseEvent",
  "Input.dispatchKeyEvent",
  "Input.insertText",
  "Input.imeSetComposition",
  "Input.dispatchTouchEvent",
  "Input.dispatchDragEvent",
  "Input.cancelDragging",
  "Input.emulateTouchFromMouseEvent",
  "Input.synthesizePinchGesture",
  "Input.synthesizeScrollGesture",
  "Input.synthesizeTapGesture",
  "DOM.setFileInputFiles",
  "DOM.focus",
  "DOM.scrollIntoViewIfNeeded",
  "Page.bringToFront",
  "Page.captureScreenshot",
  "Page.captureSnapshot",
  "Page.handleJavaScriptDialog",
  "Page.navigate",
  "Page.navigateToHistoryEntry",
  "Page.reload",
  "Page.printToPDF",
  "Page.startScreencast",
  "Page.stopScreencast",
  "Page.stopLoading",
  "Page.close",
  "Page.setWebLifecycleState",
  "Target.activateTarget",
  "Target.closeTarget",
  "Target.createTarget",
  "Target.createBrowserContext",
  "Target.disposeBrowserContext",
  "Target.openDevTools",
  "Browser.cancelDownload",
  "Browser.close",
  "Browser.setWindowBounds",
  "Browser.setContentsSize",
  "Autofill.trigger",
]);

const telemetryControlSchema = z.object({
  enabled: z.boolean().optional(),
  cdp: z
    .object({
      excluded_methods: z.array(cdpCommandMethodSchema).optional(),
    })
    .optional(),
});

const telemetryCategoriesSchema = z.object({
  captcha: telemetryCategorySchema().optional(),
  connection: telemetryCategorySchema().optional(),
  console: telemetryCategorySchema().optional(),
  control: telemetryControlSchema.optional(),
  interaction: telemetryCategorySchema().optional(),
  network: telemetryCategorySchema().optional(),
  page: telemetryCategorySchema().optional(),
  platform: telemetryCategorySchema().optional(),
  screenshot: telemetryCategorySchema().optional(),
  system: telemetryCategorySchema().optional(),
});

const telemetryDestinationSchema = z
  .object({
    id: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
  })
  .superRefine((destination, context) => {
    if (!!destination.id === !!destination.name) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "telemetry destination requires exactly one of id or name.",
      });
    }
  });

export const managedAuthBrowserTelemetrySchema = z
  .object({
    enabled: z.boolean().optional(),
    browser: telemetryCategoriesSchema.optional(),
    export: z
      .object({
        otlp: z
          .object({
            enabled: z.boolean().optional(),
            destination: telemetryDestinationSchema.optional(),
          })
          .optional(),
      })
      .optional(),
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
