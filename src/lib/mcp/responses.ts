type PaginatedPage<T> = {
  getPaginatedItems(): T[];
  has_more?: boolean | null;
  next_offset?: number | null;
};

type PaginatedJsonResponseOptions<T, U = T> = {
  mapItem?: (item: T) => U;
  note?: string;
  emptyText?: string;
};

type ItemsJsonResponseOptions<T, U = T> = PaginatedJsonResponseOptions<T, U> & {
  has_more?: boolean | null;
  next_offset?: number | null;
};

export function textResponse(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

export function jsonResponse(value: unknown) {
  return textResponse(JSON.stringify(value, null, 2) ?? String(value));
}

export function itemsJsonResponse<T, U = T>(
  items: T[],
  options: ItemsJsonResponseOptions<T, U> = {},
) {
  if (items.length === 0 && options.emptyText) {
    return textResponse(options.emptyText);
  }

  return jsonResponse({
    items: options.mapItem ? items.map(options.mapItem) : items,
    has_more: options.has_more,
    next_offset: options.next_offset,
    ...(options.note && { note: options.note }),
  });
}

export function paginatedJsonResponse<T, U = T>(
  page: PaginatedPage<T>,
  options: PaginatedJsonResponseOptions<T, U> = {},
) {
  return itemsJsonResponse(page.getPaginatedItems(), {
    ...options,
    has_more: page.has_more,
    next_offset: page.next_offset,
  });
}

export function errorResponse(text: string) {
  return { ...textResponse(text), isError: true as const };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function toolErrorResponse(
  toolName: string,
  action: string,
  error: unknown,
) {
  return errorResponse(
    `Error in ${toolName} (${action}): ${errorMessage(error)}`,
  );
}
