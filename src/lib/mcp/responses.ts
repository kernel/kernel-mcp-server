type PaginatedPage<T> = {
  getPaginatedItems(): T[];
  has_more?: boolean | null;
  next_offset?: number | null;
};

export function textResponse(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

export function jsonResponse(value: unknown) {
  return textResponse(JSON.stringify(value, null, 2) ?? String(value));
}

export function paginatedJsonResponse<T>(page: PaginatedPage<T>) {
  return jsonResponse({
    items: page.getPaginatedItems(),
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
