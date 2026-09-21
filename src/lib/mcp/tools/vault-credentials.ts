import type { McpServer } from "@modelcontextprotocol/server";
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
const fieldLabel = () =>
  z
    .string()
    .min(1)
    .refine((label) => label === label.trim())
    .refine((label) => Buffer.byteLength(label, "utf8") <= 128)
    .refine((label) => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(label));
const definition = z
  .object({
    name: fieldName().describe(
      "Stable field name used for updates and browser fills.",
    ),
    label: fieldLabel()
      .optional()
      .describe(
        "Optional non-secret display text for users. Must be nonempty, have no leading or trailing whitespace, be at most 128 UTF-8 bytes, and contain no control, formatting, or line-separator characters. The form falls back to name. Labels never affect updates or browser fills.",
      ),
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
      .array(definition)
      .min(1)
      .max(32)
      .describe(
        "Ordered field definitions. List them in the website's top-to-bottom order; the user-facing collection form renders this order unchanged.",
      )
      .refine(
        (fields) =>
          new Set(fields.map((field) => field.name)).size === fields.length,
        "Field names must be unique.",
      ),
  })
  .strict();
function publicCredentialFieldNames(item: VaultItem): Set<string> {
  if (item.type !== "credential") return new Set();
  const names = new Set<string>();
  const publicNames = new Set<string>();
  for (const field of item.spec.fields) {
    if (names.has(field.name)) return new Set();
    names.add(field.name);
    if (isPublicCredentialField(field)) publicNames.add(field.name);
  }
  return publicNames;
}

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
  server.registerTool(
    "manage_vault_credentials",
    {
      description:
        'Create or update credential items in a per-end-user vault. Use only the recognizable site name as description; explicitly set sensitive:false for ordinary usernames/emails. Each field may include an optional non-secret human-readable label; name remains the stable key for updates and browser fills. Passwords and TOTP seeds must be sensitive. Never store payment-card data here. For human collection, omit values and present the returned bearer collection URL privately to the intended user, outside the agent-controlled browser. Never ask for passwords or TOTP seeds in chat. TOTP seeds require trusted provisioning and have no hosted input. On create, fields is an ordered array of named definitions: inspect the website and list fields in its natural top-to-bottom order because this directly controls the user-facing collection form. Update fields remain keyed by name and contain only value. Updates require the latest version and optionally expected_item_id from an earlier read; definitions are immutable. Omitted values are preserved; null or empty strings clear supported values. Clearing required TOTP is unsupported. Hosted forms require populated required inputs. To reopen collection, use manage_vault_items with action: "invoke" and operation: "collect". Use manage_vault_items get with wait for readiness, then invoke fill with fill parameters. For edits to already-ready items compare versions without wait. Explicitly non-sensitive text/email values are returned; sensitive values and TOTP seeds are omitted. Writes are never automatically retried; reconcile conflicts or uncertain outcomes before any further write.',
      inputSchema: vaultToolInput({
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
      annotations: {
        title: "Configure Kernel vault credentials",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params, ctx) => {
      if (!ctx.http?.authInfo) throw new Error("Authentication required");
      const project = projectForOperation(ctx.http.authInfo, params);
      const client = dependencies.createKernelClient(
        ctx.http.authInfo.token,
        project,
      );
      const options = { maxRetries: 0, signal: ctx.mcpReq.signal };
      try {
        if (
          params.action === "create" &&
          (params.version !== undefined ||
            params.expected_item_id !== undefined)
        )
          return errorResponse("version and expected_item_id are update-only.");
        let item: VaultItem;
        let writtenValues: (string | undefined)[];
        if (params.action === "create") {
          const spec = createSpec.parse(params.spec);
          item = await client.vaults.items.upsert(
            params.key,
            {
              id_or_name: params.vault,
              type: "credential",
              spec,
            },
            options,
          );
          const publicNames = publicCredentialFieldNames(item);
          writtenValues = spec.fields
            .filter((field) => !publicNames.has(field.name))
            .map((field) => field.value);
        } else {
          if (params.version === undefined)
            return errorResponse("version is required for update.");
          const spec = updateSpec.parse(params.spec);
          item = await client.vaults.items.update(
            params.key,
            {
              id_or_name: params.vault,
              type: "credential",
              version: params.version,
              ...(params.expected_item_id !== undefined && {
                expected_item_id: params.expected_item_id,
              }),
              spec,
            },
            options,
          );
          const publicNames = publicCredentialFieldNames(item);
          writtenValues = Object.entries(spec.fields ?? {})
            .filter(([name]) => !publicNames.has(name))
            .map(([, field]) => field.value ?? undefined);
        }
        return vaultItemResponse(
          item,
          { project, vault: params.vault, key: params.key },
          writtenValues,
        );
      } catch (error) {
        throwVaultError("manage_vault_credentials", params.action, error);
      }
    },
  );
}
