import { z } from "zod";

export const paginationParams = {
  limit: z
    .number()
    .describe(
      "(list) Max results per page. Defaults to 20; API clamps to 1-100.",
    )
    .optional(),
  offset: z
    .number()
    .describe(
      "(list) Pagination offset. Defaults to 0; API clamps negatives to 0.",
    )
    .optional(),
};
