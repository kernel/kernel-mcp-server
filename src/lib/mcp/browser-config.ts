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

type BrowserProfileConfig =
  | {
      id?: string;
      name?: string;
      save_changes?: boolean;
    }
  | undefined;

type BrowserExtensionConfig =
  | Array<{
      id?: string;
      name?: string;
    }>
  | undefined;

type BrowserViewportConfig =
  | {
      width: number;
      height: number;
      refresh_rate?: number;
    }
  | undefined;

type BrowserViewportUpdateConfig =
  | (NonNullable<BrowserViewportConfig> & { force?: boolean })
  | undefined;

export type BrowserConfigResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

function configValue<T>(value: T): BrowserConfigResult<T> {
  return { ok: true, value };
}

function configError<T>(message: string): BrowserConfigResult<T> {
  return { ok: false, error: `Error: ${message}` };
}

export function buildBrowserStartUrl(
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

export function buildBrowserProfile(
  params: BrowserProfileParams,
): BrowserConfigResult<BrowserProfileConfig> {
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

export function buildBrowserExtensions(
  params: BrowserExtensionParams,
): BrowserConfigResult<BrowserExtensionConfig> {
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

export function buildBrowserViewport(
  params: BrowserViewportParams,
): BrowserConfigResult<BrowserViewportConfig> {
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

export function buildBrowserViewportUpdate(
  params: BrowserViewportUpdateParams,
): BrowserConfigResult<BrowserViewportUpdateConfig> {
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
