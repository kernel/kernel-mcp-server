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

export function buildBrowserStartUrl(startUrl: string | undefined) {
  if (startUrl === undefined) return undefined;

  try {
    new URL(startUrl);
  } catch {
    throw new Error("start_url must be a valid URL.");
  }

  return startUrl;
}

export function buildBrowserProfile(params: BrowserProfileParams) {
  if (params.profile_name && params.profile_id) {
    throw new Error("Cannot specify both profile_name and profile_id.");
  }
  if (
    params.save_profile_changes !== undefined &&
    !params.profile_name &&
    !params.profile_id
  ) {
    throw new Error(
      "profile_name or profile_id is required when save_profile_changes is set.",
    );
  }
  if (!params.profile_name && !params.profile_id) return undefined;
  return {
    ...(params.profile_name && { name: params.profile_name }),
    ...(params.profile_id && { id: params.profile_id }),
    ...(params.save_profile_changes !== undefined && {
      save_changes: params.save_profile_changes,
    }),
  };
}

export function buildBrowserExtensions(params: BrowserExtensionParams) {
  if (params.extension_id && params.extension_name) {
    throw new Error("Cannot specify both extension_id and extension_name.");
  }
  if (!params.extension_id && !params.extension_name) return undefined;
  return [
    {
      ...(params.extension_id && { id: params.extension_id }),
      ...(params.extension_name && { name: params.extension_name }),
    },
  ];
}

export function buildBrowserViewport(params: BrowserViewportParams) {
  const width = params.viewport_width;
  const height = params.viewport_height;
  const hasViewportOptions =
    width !== undefined ||
    height !== undefined ||
    params.viewport_refresh_rate !== undefined;

  if (!hasViewportOptions) return undefined;
  if (width === undefined || height === undefined) {
    throw new Error(
      "viewport_width and viewport_height must be provided together.",
    );
  }

  return {
    width,
    height,
    ...(params.viewport_refresh_rate !== undefined && {
      refresh_rate: params.viewport_refresh_rate,
    }),
  };
}

export function buildBrowserViewportUpdate(
  params: BrowserViewportUpdateParams,
) {
  const viewport = buildBrowserViewport(params);

  if (!viewport) {
    if (params.viewport_force !== undefined) {
      throw new Error(
        "viewport_width and viewport_height must be provided when viewport_force is set.",
      );
    }
    return undefined;
  }

  return {
    ...viewport,
    ...(params.viewport_force !== undefined && {
      force: params.viewport_force,
    }),
  };
}
