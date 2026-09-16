import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { VaultItem } from "@onkernel/sdk/resources/vaults/items";
import type { McpDependencies } from "@/lib/mcp/dependencies";
import { projectForOperation } from "@/lib/mcp/project-selection";
import { errorResponse } from "@/lib/mcp/responses";
import {
  throwVaultError,
  vaultItemResponse,
  isPublicCredentialField,
} from "@/lib/mcp/vault-responses";
import {
  vaultItemSchema,
  vaultKeySchema,
  vaultToolInput,
} from "@/lib/mcp/vault-schemas";

const text = () =>
  z.string().refine((value) => Buffer.byteLength(value, "utf8") <= 16384);
const fieldName = () => z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/);
const definition = z
  .object({
    type: z.enum(["text", "email", "password", "totp"]),
    required: z.boolean().optional(),
    sensitive: z
      .boolean()
      .optional()
      .describe(
        "Explicitly false for ordinary usernames/emails. Passwords/TOTP must be true; omission defaults to true.",
      ),
    value: text()
      .optional()
      .describe(
        "Optional initial value. Omit secrets for private human collection; TOTP uses a seed, not a current code.",
      ),
  })
  .strict()
  .refine(
    (field) =>
      !(["password", "totp"].includes(field.type) && field.sensitive === false),
  );
const createSpec = z
  .object({
    description: text()
      .optional()
      .describe(
        "Recognizable site or service name only; display text, not destination policy.",
      ),
    fields: z
      .record(fieldName(), definition)
      .refine(
        (fields) =>
          Object.keys(fields).length >= 1 && Object.keys(fields).length <= 32,
      ),
  })
  .strict();
const updateSpec = z
  .object({
    description: text()
      .optional()
      .describe(
        "Replacement site/service display name. Empty string clears it.",
      ),
    fields: z
      .record(fieldName(), z.object({ value: text().nullable() }).strict())
      .refine(
        (fields) =>
          Object.keys(fields).length >= 1 && Object.keys(fields).length <= 32,
      )
      .optional(),
  })
  .strict()
  .refine(
    (spec) => spec.description !== undefined || spec.fields !== undefined,
  );

export function registerVaultCredentialTools(
  server: McpServer,
  dependencies: McpDependencies,
) {
  server.tool(
    "manage_vault_credentials",
    'Create or update credential items in a per-end-user vault. Use only the recognizable site name as description; explicitly set sensitive:false for ordinary usernames/emails. Passwords and TOTP seeds must be sensitive. Never store payment-card data here. For human collection, omit values and present the returned bearer collection URL privately to the intended user, outside the agent-controlled browser. Never ask for passwords or TOTP seeds in chat. TOTP seeds require trusted provisioning and have no hosted input. Create definitions with fields keyed by name; update accepts only description and fields containing value. Updates require the latest version and optionally expected_item_id from an earlier read; definitions are immutable. Omitted values are preserved; null or empty strings clear supported values. Clearing required TOTP is unsupported. Hosted forms require populated required inputs. To reopen collection, use manage_vault_items with action: "invoke" and operation: "collect". Use manage_vault_items get with wait for readiness, then invoke fill with fill parameters. For edits to already-ready items compare versions without wait. Explicitly non-sensitive text/email values are returned; sensitive values and TOTP seeds are omitted. Writes are never automatically retried; reconcile conflicts or uncertain outcomes before any further write.',
    vaultToolInput({
      ...vaultItemSchema,
      key: vaultKeySchema(),
      action: z.enum(["create", "update"]),
      spec: z
        .union([createSpec, updateSpec])
        .refine(
          (spec) =>
            Buffer.byteLength(JSON.stringify(spec), "utf8") <= 128 * 1024,
        ),
      version: z
        .number()
        .int()
        .safe()
        .positive()
        .describe("Required for update; current item version.")
        .optional(),
      expected_item_id: z
        .string()
        .min(1)
        .describe(
          "Update-only immutable identity precondition from an earlier read.",
        )
        .optional(),
    }),
    {
      title: "Configure Kernel vault credentials",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    async (params, extra) => {
      if (!extra.authInfo) throw new Error("Authentication required");
      const project = projectForOperation(extra.authInfo, params);
      const client = dependencies.createKernelClient(
        extra.authInfo.token,
        project,
      );
      const options = { maxRetries: 0, signal: extra.signal };
      try {
        if (
          params.action === "create" &&
          (params.version !== undefined ||
            params.expected_item_id !== undefined)
        )
          return errorResponse("version and expected_item_id are update-only.");
        let item: VaultItem;
        if (params.action === "create") {
          item = await client.vaults.items.upsert(
            params.key,
            {
              id_or_name: params.vault,
              type: "credential",
              spec: createSpec.parse(params.spec),
            },
            options,
          );
        } else {
          if (params.version === undefined)
            return errorResponse("version is required for update.");
          item = await client.vaults.items.update(
            params.key,
            {
              id_or_name: params.vault,
              type: "credential",
              version: params.version,
              ...(params.expected_item_id !== undefined && {
                expected_item_id: params.expected_item_id,
              }),
              spec: updateSpec.parse(params.spec),
            },
            options,
          );
        }
        return vaultItemResponse(
          item,
          { project, vault: params.vault, key: params.key },
          Object.entries(params.spec.fields ?? {})
            .filter(
              ([name]) =>
                item.type !== "credential" ||
                !isPublicCredentialField(item.spec.fields[name]),
            )
            .map(([, field]) => field.value ?? undefined),
        );
      } catch (error) {
        throwVaultError("manage_vault_credentials", params.action, error);
      }
    },
  );
}
