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
      "stable field name used for updates and browser fills.",
    ),
    label: fieldLabel()
      .optional()
      .describe(
        "optional non-secret display text for users. must be nonempty, have no leading or trailing whitespace, be at most 128 utf-8 bytes, and contain no control, formatting, or line-separator characters. the form falls back to name. labels never affect updates or browser fills.",
      ),
    type: z.enum(["text", "email", "password", "totp"]),
    required: z.boolean().optional(),
    sensitive: z
      .boolean()
      .optional()
      .describe(
        "explicitly false for ordinary usernames/emails. passwords/totp must be true; omission defaults to true.",
      ),
    value: text()
      .optional()
      .describe(
        "optional initial value. omit secrets for private human collection; totp uses a seed, not a current code.",
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
        "recognizable site or service name only; display text, not destination policy.",
      ),
    fields: z
      .array(definition)
      .min(1)
      .max(32)
      .describe(
        "ordered field definitions. list them in the website's top-to-bottom order; the user-facing collection form renders this order unchanged.",
      )
      .refine(
        (fields) =>
          new Set(fields.map((field) => field.name)).size === fields.length,
        "field names must be unique.",
      ),
  })
  .strict();
const onePasswordLogin = z
  .object({
    website: z
      .string()
      .url()
      .max(2083)
      .regex(/^https:\/\//)
      .describe("https login page for this login."),
    reason: z.string().max(100).optional(),
    keywords: z.array(z.string().min(1).max(50)).min(1).max(5).optional(),
  })
  .strict();
const onePasswordCreateSpec = z
  .object({
    account: z
      .string()
      .min(1)
      .describe(
        "key (not id) of a connected 1password credential_account item in the same vault. accounts are not shared across vaults; each end user's vault connects its own.",
      ),
    logins: z
      .array(onePasswordLogin)
      .min(1)
      .max(5)
      .describe(
        "1-5 logins the account owner approves together in one request, each with the site it signs in to.",
      ),
    goal: z
      .string()
      .max(140)
      .optional()
      .describe("short request goal shown to the account owner."),
  })
  .strict();

function onePasswordCredentialSpec(
  spec: z.infer<typeof onePasswordCreateSpec>,
) {
  return {
    provider: "1password" as const,
    account: spec.account,
    requests: {
      version: 2,
      ...(spec.goal !== undefined && { goal: spec.goal }),
      entries: spec.logins.map((login) => ({
        type: "login",
        parameters: { website: login.website },
        ...(login.reason !== undefined && { reason: login.reason }),
        ...(login.keywords !== undefined && { keywords: login.keywords }),
      })),
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
        "replacement site/service display name. empty string clears it.",
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
        'create or update credential items in a per-end-user vault. first list the vault with manage_vault_items and reuse an existing credential for the site: use a ready KERNEL credential with fill or an advertised webmcp_invoke, 1pw_fill a ready 1password credential, and reuse a connected 1password credential_account for new 1password credentials. never claim access the vault does not hold. there are two credential paths. before creating any credential, ask the user which they prefer by asking where their login for the site lives, for example: "is your example.com login saved in your own 1password, or would you rather enter it in a secure KERNEL form?" set provider to match; never choose for them. provider:"kernel" is KERNEL-hosted collection: the user enters values in a KERNEL-hosted form and the agent uses them through value-free bindings. provider:"1password" is 1password brokered approval: the user connects their 1password account once, approves each login request in the 1password app, and the 1password extension, loaded into the browser on demand, fills and submits; KERNEL stores no values. 1password supports only logins in the owner\'s own non-shared vault, not shared-vault items or passkeys; use KERNEL-hosted collection for those, or if the user declines 1password or that path fails. ' +
        'KERNEL path: use only the recognizable site name as description; explicitly set sensitive:false for ordinary usernames/emails. each field may include an optional non-secret human-readable label; name remains the stable key for updates and browser fills. passwords and totp seeds must be sensitive. never store payment-card data here. for human collection, omit values and present the returned bearer collection url privately to the intended user, outside the agent-controlled browser. never ask for passwords or totp seeds in chat. totp seeds require trusted provisioning and have no hosted input. on create, fields is an ordered array of named definitions: inspect the website and list fields in its natural top-to-bottom order because this directly controls the user-facing collection form. update fields remain keyed by name and contain only value. updates require the latest version and optionally expected_item_id from an earlier read; definitions are immutable. omitted values are preserved; null or empty strings clear supported values. clearing required totp is unsupported. hosted forms require populated required inputs. to reopen collection, use manage_vault_items with action: "invoke" and operation: "collect". use manage_vault_items get with wait for readiness. once ready, choosing an operation is separate from the provider choice above: invoke fill to write fields into an ordinary web form without submitting it; invoke webmcp_invoke, only when listed in available_operations, to bind credential fields to null input slots of a live webmcp tool, which may submit the form or have other side effects. obtain explicit user approval before either, and never automatically retry an uncertain fill or an unknown webmcp_invoke outcome. for edits to already-ready items compare versions without wait. explicitly non-sensitive text/email values are returned; sensitive values and totp seeds are omitted. ' +
        '1password path: reuse a connected credential_account in the vault; otherwise use action "connect_account" with provider:"1password" and a new key, and present the returned 1password authorization url only to the account owner, outside the agent-controlled browser, once manage_vault_items get reports the account connected, confirm with the owner which site logins to request (1-5, approved together), then create the credential with provider:"1password" and spec {account: the account item key, logins: [{website, optional reason/keywords}], optional goal}. 1password credentials cannot be updated. then invoke 1pw_create_access_request; it needs no browser, and no approval link exists before that request. create a browser with this vault attached only when the login is ready to fill. approval is a human action in the 1password app: give the returned native onepassword:// approval link unmodified only to the account owner, outside the agent-controlled browser, and never open, decode, or approve it yourself. credentials backed by a customer-supplied 1password access token and integration key are created and rotated by the integrating developer through the KERNEL api, not through mcp; never ask for or accept those secrets in chat. this is unrelated to manage_credential_providers. ' +
        "writes are never automatically retried; reconcile conflicts or uncertain outcomes before any further write.",
      inputSchema: vaultToolInput({
        ...vaultItemSchema,
        key: vaultKeySchema(),
        action: z.enum(["create", "update", "connect_account"]),
        provider: z
          .enum(["kernel", "1password"])
          .describe(
            '(create, connect_account) the path the user chose. ask the user before creating. connect_account supports only "1password". update accepts only KERNEL credentials.',
          )
          .optional(),
        spec: z
          .union([createSpec, onePasswordCreateSpec, updateSpec])
          .describe(
            "(create, update) KERNEL create: description and ordered fields. 1password create: account key, 1-5 logins, and optional goal. update (KERNEL only): description and/or fields keyed by name.",
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
          .describe("required for update; current item version.")
          .optional(),
        expected_item_id: z
          .string()
          .min(1)
          .describe(
            "update-only immutable identity precondition from an earlier read.",
          )
          .optional(),
      }),
      annotations: {
        title: "configure KERNEL vault credentials",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params, ctx) => {
      if (!ctx.http?.authInfo) throw new Error("authentication required");
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
          return errorResponse("1password credentials cannot be updated.");
        if (params.action !== "update" && params.provider === undefined)
          return errorResponse(
            'provider is required. ask the user whether they prefer KERNEL-hosted collection (provider: "kernel") or 1password brokered approval (provider: "1password") before creating credentials.',
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
          const spec = onePasswordCreateSpec.safeParse(params.spec);
          if (!spec.success)
            return errorResponse(
              'provider: "1password" create requires spec {account, logins, goal?}. no request was sent.',
            );
          const credential = await client.vaults.items.upsert(
            params.key,
            {
              id_or_name: params.vault,
              type: "credential",
              spec: onePasswordCredentialSpec(spec.data),
            },
            options,
          );
          return vaultItemResponse(credential, target);
        }
        let item: VaultItem;
        let writtenValues: (string | undefined)[];
        if (params.action === "create") {
          const parsed = createSpec.safeParse(params.spec);
          if (!parsed.success)
            return errorResponse(
              'provider: "kernel" create requires spec {description?, fields}. no request was sent.',
            );
          const spec = parsed.data;
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
          const parsed = updateSpec.safeParse(params.spec);
          if (!parsed.success)
            return errorResponse(
              "update requires spec {description?, fields?} keyed by field name. no request was sent.",
            );
          const spec = parsed.data;
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
