import { z } from "zod";

export const paginationParams = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .describe(
      "(list) Max results per page. Must be 1-100; API default varies by endpoint.",
    )
    .optional(),
  offset: z
    .number()
    .int()
    .min(0)
    .describe("(list) Pagination offset. Must be 0 or greater.")
    .optional(),
};
