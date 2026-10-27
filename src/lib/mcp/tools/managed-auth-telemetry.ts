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

export const browserTelemetryCategoriesSchema = z.object({
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

const telemetryExportSchema = z
  .object({
    otlp: z
      .object({
        enabled: z.boolean().optional(),
        destination: telemetryDestinationSchema.optional(),
      })
      .superRefine((otlp, context) => {
        if (otlp.enabled === false && otlp.destination) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "telemetry export enabled=false cannot be combined with a destination.",
          });
        }
      })
      .optional(),
  })
  .optional();

function rejectDisabledTelemetryWithCategories(
  telemetry: {
    enabled?: boolean;
    browser?: z.infer<typeof browserTelemetryCategoriesSchema>;
  },
  context: z.RefinementCtx,
) {
  if (
    telemetry.enabled === false &&
    telemetry.browser &&
    Object.keys(telemetry.browser).length > 0
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "browser telemetry enabled=false cannot be combined with browser category settings.",
    });
  }
}

export const browserTelemetrySchema = z
  .object({
    enabled: z.boolean().optional(),
    browser: browserTelemetryCategoriesSchema.optional(),
    export: telemetryExportSchema,
    storage: z
      .object({
        enabled: z.boolean().optional(),
      })
      .optional(),
  })
  .superRefine(rejectDisabledTelemetryWithCategories);

export const managedAuthBrowserTelemetrySchema = browserTelemetrySchema;

export type BrowserTelemetry = z.infer<typeof browserTelemetrySchema>;
export type ManagedAuthBrowserTelemetry = z.infer<
  typeof managedAuthBrowserTelemetrySchema
>;
