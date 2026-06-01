export function textResponse(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

export function jsonResponse(value: unknown) {
  return textResponse(JSON.stringify(value, null, 2));
}

export function jsonListResponse<T>(
  items: readonly T[] | null | undefined,
  emptyText: string,
) {
  return items && items.length > 0
    ? jsonResponse(items)
    : textResponse(emptyText);
}

export function paginatedJsonResponse<T>(
  page: {
    getPaginatedItems(): T[];
    has_more?: boolean | null;
    next_offset?: number | null;
  },
  emptyText?: string,
) {
  const items = page.getPaginatedItems();
  if (items.length === 0 && emptyText) return textResponse(emptyText);
  return jsonResponse({
    items,
    has_more: page.has_more,
    next_offset: page.next_offset,
  });
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
