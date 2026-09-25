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
const onePasswordCreateSpec = z
  .object({
    account_id: z
      .string()
      .min(1)
      .describe(
        "Immutable id (not key) of a connected 1Password credential_account item in the same vault.",
      ),
    website: z
      .string()
      .url()
      .max(2083)
      .regex(/^https:\/\//)
      .describe("HTTPS login page for the single requested login."),
    goal: z
      .string()
      .max(140)
      .optional()
      .describe("Short request goal shown to the account owner."),
    reason: z.string().max(100).optional(),
    keywords: z.array(z.string().min(1).max(50)).min(1).max(5).optional(),
  })
  .strict();

function onePasswordCredentialSpec(
  spec: z.infer<typeof onePasswordCreateSpec>,
) {
  return {
    provider: "1password" as const,
    account_id: spec.account_id,
    requests: {
      version: 2,
      ...(spec.goal !== undefined && { goal: spec.goal }),
      entries: [
        {
          type: "login",
          parameters: { website: spec.website },
          ...(spec.reason !== undefined && { reason: spec.reason }),
          ...(spec.keywords !== undefined && { keywords: spec.keywords }),
        },
      ],
    },
  };
}

function publicCredentialFieldNames(item: VaultItem): Set<string> {
  if (item.type !== "credential" || !("fields" in item.spec)) return new Set();
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
        'Create or update credential items in a per-end-user vault. There are two credential paths. Before creating any credential, ask the user which they prefer and set provider to match; never choose for them. provider:"kernel" is Kernel-hosted collection: the user enters values in a Kernel-hosted form and the agent fills them with value-free bindings. provider:"1password" is 1Password brokered approval: the user connects their 1Password account once, approves each login request in the 1Password app, and the 1Password extension fills and submits; Kernel stores no values. ' +
        'Kernel path: use only the recognizable site name as description; explicitly set sensitive:false for ordinary usernames/emails. Each field may include an optional non-secret human-readable label; name remains the stable key for updates and browser fills. Passwords and TOTP seeds must be sensitive. Never store payment-card data here. For human collection, omit values and present the returned bearer collection URL privately to the intended user, outside the agent-controlled browser. Never ask for passwords or TOTP seeds in chat. TOTP seeds require trusted provisioning and have no hosted input. On create, fields is an ordered array of named definitions: inspect the website and list fields in its natural top-to-bottom order because this directly controls the user-facing collection form. Update fields remain keyed by name and contain only value. Updates require the latest version and optionally expected_item_id from an earlier read; definitions are immutable. Omitted values are preserved; null or empty strings clear supported values. Clearing required TOTP is unsupported. Hosted forms require populated required inputs. To reopen collection, use manage_vault_items with action: "invoke" and operation: "collect". Use manage_vault_items get with wait for readiness, then invoke fill with fill parameters. For edits to already-ready items compare versions without wait. Explicitly non-sensitive text/email values are returned; sensitive values and TOTP seeds are omitted. ' +
        '1Password path: first use action "connect_account" with provider:"1password" and a new key; present the returned 1Password authorization URL only to the account owner, outside the agent-controlled browser, and let them verify the account on the consent screen. Once manage_vault_items get reports the account connected, create the credential with provider:"1password" and spec {account_id, website, optional goal/reason/keywords}. 1Password credentials cannot be updated. Approval is a human action in the 1Password app: MCP never returns the native approval link, access-request references, tokens, or integration keys, and you must never open, approve, or relay an approval yourself. This is unrelated to manage_credential_providers. ' +
        "Writes are never automatically retried; reconcile conflicts or uncertain outcomes before any further write.",
      inputSchema: vaultToolInput({
        ...vaultItemSchema,
        key: vaultKeySchema(),
        action: z.enum(["create", "update", "connect_account"]),
        provider: z
          .enum(["kernel", "1password"])
          .describe(
            '(create, connect_account) The path the user chose. Ask the user before creating. connect_account supports only "1password". Update accepts only Kernel credentials.',
          )
          .optional(),
        spec: z
          .union([createSpec, onePasswordCreateSpec, updateSpec])
          .describe(
            "(create, update) Kernel create: description and ordered fields. 1Password create: account_id, website, and optional goal/reason/keywords. Update (Kernel only): description and/or fields keyed by name.",
          )
          .refine(
            (spec) =>
              Buffer.byteLength(JSON.stringify(spec), "utf8") <= 128 * 1024,
          )
          .optional(),
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
          params.action !== "update" &&
          (params.version !== undefined ||
            params.expected_item_id !== undefined)
        )
          return errorResponse("version and expected_item_id are update-only.");
        if (params.action === "update" && params.provider === "1password")
          return errorResponse("1Password credentials cannot be updated.");
        if (params.action !== "update" && params.provider === undefined)
          return errorResponse(
            'provider is required. Ask the user whether they prefer Kernel-hosted collection (provider: "kernel") or 1Password brokered approval (provider: "1password") before creating credentials.',
          );
        const target = { project, vault: params.vault, key: params.key };
        if (params.action === "connect_account") {
          if (params.provider !== "1password")
            return errorResponse(
              'connect_account supports only provider: "1password".',
            );
          if (params.spec !== undefined)
            return errorResponse("spec is not accepted for connect_account.");
          const account = await client.vaults.items.upsert(
            params.key,
            {
              id_or_name: params.vault,
              type: "credential_account",
              spec: {
                provider: "1password",
                authorization: {
                  method: "oauth",
                  client: { type: "kernel_managed" },
                },
              },
            },
            options,
          );
          return vaultItemResponse(account, target);
        }
        if (params.spec === undefined)
          return errorResponse("spec is required for create and update.");
        if (params.action === "create" && params.provider === "1password") {
          const spec = onePasswordCreateSpec.parse(params.spec);
          const credential = await client.vaults.items.upsert(
            params.key,
            {
              id_or_name: params.vault,
              type: "credential",
              spec: onePasswordCredentialSpec(spec),
            },
            options,
          );
          return vaultItemResponse(credential, target);
        }
        let item: VaultItem;
        let writtenValues: (string | undefined)[];
        if (params.action === "create") {
          const spec = createSpec.parse(params.spec);
          item = await client.vaults.items.upsert(
            params.key,
            {
              id_or_name: params.vault,
              type: "credential",
              spec: { provider: "kernel", ...spec },
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
        return vaultItemResponse(item, target, writtenValues);
      } catch (error) {
        throwVaultError("manage_vault_credentials", params.action, error);
      }
    },
  );
}
