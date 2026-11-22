import { z } from "zod";

export const apiKeyPolicySchema = z
  .object({
    statements: z
      .array(
        z
          .object({
            action: z.string().min(1),
            resource: z.string().min(1),
            condition: z
              .object({
                key: z.literal("source_ip"),
                operator: z.literal("in"),
                values: z.array(z.string().min(1)).min(1).max(16),
              })
              .strict()
              .describe(
                "source_ip/in accepts 1-16 canonical cidr networks; bare addresses, host bits, and ipv4-in-ipv6 are rejected.",
              )
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(256),
  })
  .strict();

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
