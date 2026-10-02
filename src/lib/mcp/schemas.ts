import { z } from "zod";

export const paginationParams = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .describe(
      "(list) max results per page. must be 1-100; api default varies by endpoint.",
    )
    .optional(),
  offset: z
    .number()
    .int()
    .min(0)
    .describe("(list) pagination offset. must be 0 or greater.")
    .optional(),
};
