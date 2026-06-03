import type { KernelClient } from "@/lib/mcp/kernel-client";

type BrowserCreateParams = NonNullable<
  Parameters<KernelClient["browsers"]["create"]>[0]
>;
type BrowserUpdateParams = Parameters<KernelClient["browsers"]["update"]>[1];
type BrowserPoolCreateParams = Parameters<
  KernelClient["browserPools"]["create"]
>[0];
type BrowserPoolUpdateParams = Parameters<
  KernelClient["browserPools"]["update"]
>[1];

export type BrowserProfileParams = {
  profile_name?: string;
  profile_id?: string;
  save_profile_changes?: boolean;
};

export type BrowserExtensionParams = {
  extension_id?: string;
  extension_name?: string;
};

export type BrowserViewportParams = {
  viewport_width?: number;
  viewport_height?: number;
  viewport_refresh_rate?: number;
};

export type BrowserViewportUpdateParams = BrowserViewportParams & {
  viewport_force?: boolean;
};

export type BrowserCreateConfigParams = BrowserProfileParams &
  BrowserExtensionParams &
  BrowserViewportParams & {
    start_url?: string;
  };

export type BrowserUpdateConfigParams = BrowserProfileParams &
  BrowserViewportUpdateParams;

type BrowserProfileConfig = NonNullable<
  | BrowserCreateParams["profile"]
  | BrowserUpdateParams["profile"]
  | BrowserPoolCreateParams["profile"]
  | BrowserPoolUpdateParams["profile"]
>;

type BrowserExtensionConfig = NonNullable<
  | BrowserCreateParams["extensions"]
  | BrowserPoolCreateParams["extensions"]
  | BrowserPoolUpdateParams["extensions"]
>;

type BrowserViewportConfig = NonNullable<
  | BrowserCreateParams["viewport"]
  | BrowserPoolCreateParams["viewport"]
  | BrowserPoolUpdateParams["viewport"]
>;

type BrowserViewportUpdateConfig = NonNullable<BrowserUpdateParams["viewport"]>;

export type BrowserCreateConfig = Pick<
  BrowserCreateParams,
  "profile" | "extensions" | "viewport" | "start_url"
>;

export type BrowserUpdateConfig = Pick<
  BrowserUpdateParams,
  "profile" | "viewport"
>;

export type BrowserConfigResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

function configValue<T>(value: T): BrowserConfigResult<T> {
  return { ok: true, value };
}

function configError<T>(message: string): BrowserConfigResult<T> {
  return { ok: false, error: `Error: ${message}` };
}

function buildBrowserStartUrl(
  startUrl: string | undefined,
): BrowserConfigResult<string | undefined> {
  if (startUrl === undefined) return configValue(undefined);

  try {
    new URL(startUrl);
  } catch {
    return configError("start_url must be a valid URL.");
  }

  return configValue(startUrl);
}

function buildBrowserProfile(
  params: BrowserProfileParams,
): BrowserConfigResult<BrowserProfileConfig | undefined> {
  if (params.profile_name && params.profile_id) {
    return configError("Cannot specify both profile_name and profile_id.");
  }
  if (
    params.save_profile_changes !== undefined &&
    !params.profile_name &&
    !params.profile_id
  ) {
    return configError(
      "profile_name or profile_id is required when save_profile_changes is set.",
    );
  }
  if (!params.profile_name && !params.profile_id) return configValue(undefined);
  return configValue({
    ...(params.profile_name && { name: params.profile_name }),
    ...(params.profile_id && { id: params.profile_id }),
    ...(params.save_profile_changes !== undefined && {
      save_changes: params.save_profile_changes,
    }),
  });
}

function buildBrowserExtensions(
  params: BrowserExtensionParams,
): BrowserConfigResult<BrowserExtensionConfig | undefined> {
  if (params.extension_id && params.extension_name) {
    return configError("Cannot specify both extension_id and extension_name.");
  }
  if (!params.extension_id && !params.extension_name)
    return configValue(undefined);
  return configValue([
    {
      ...(params.extension_id && { id: params.extension_id }),
      ...(params.extension_name && { name: params.extension_name }),
    },
  ]);
}

function buildBrowserViewport(
  params: BrowserViewportParams,
): BrowserConfigResult<BrowserViewportConfig | undefined> {
  const width = params.viewport_width;
  const height = params.viewport_height;
  const hasViewportOptions =
    width !== undefined ||
    height !== undefined ||
    params.viewport_refresh_rate !== undefined;

  if (!hasViewportOptions) return configValue(undefined);
  if (width === undefined || height === undefined) {
    return configError(
      "viewport_width and viewport_height must be provided together.",
    );
  }

  return configValue({
    width,
    height,
    ...(params.viewport_refresh_rate !== undefined && {
      refresh_rate: params.viewport_refresh_rate,
    }),
  });
}

function buildBrowserViewportUpdate(
  params: BrowserViewportUpdateParams,
): BrowserConfigResult<BrowserViewportUpdateConfig | undefined> {
  const viewport = buildBrowserViewport(params);
  if (!viewport.ok) return viewport;

  if (!viewport.value) {
    if (params.viewport_force !== undefined) {
      return configError(
        "viewport_width and viewport_height must be provided when viewport_force is set.",
      );
    }
    return configValue(undefined);
  }

  return configValue({
    ...viewport.value,
    ...(params.viewport_force !== undefined && {
      force: params.viewport_force,
    }),
  });
}

export function buildBrowserCreateConfig(
  params: BrowserCreateConfigParams,
): BrowserConfigResult<BrowserCreateConfig> {
  const profile = buildBrowserProfile(params);
  if (!profile.ok) return profile;

  const extensions = buildBrowserExtensions(params);
  if (!extensions.ok) return extensions;

  const viewport = buildBrowserViewport(params);
  if (!viewport.ok) return viewport;

  const startUrl = buildBrowserStartUrl(params.start_url);
  if (!startUrl.ok) return startUrl;

  return configValue({
    ...(profile.value && { profile: profile.value }),
    ...(extensions.value && { extensions: extensions.value }),
    ...(viewport.value && { viewport: viewport.value }),
    ...(startUrl.value !== undefined && { start_url: startUrl.value }),
  });
}

export function buildBrowserUpdateConfig(
  params: BrowserUpdateConfigParams,
): BrowserConfigResult<BrowserUpdateConfig> {
  const profile = buildBrowserProfile(params);
  if (!profile.ok) return profile;

  const viewport = buildBrowserViewportUpdate(params);
  if (!viewport.ok) return viewport;

  return configValue({
    ...(profile.value && { profile: profile.value }),
    ...(viewport.value && { viewport: viewport.value }),
  });
}
