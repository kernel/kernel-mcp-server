import { APIError } from "@onkernel/sdk";

type PaginatedPage<T> = {
  getPaginatedItems(): T[];
  has_more?: boolean | null;
  next_offset?: number | null;
};

type JsonItemsResponseOptions<T, U = T> = {
  mapItem?: (item: T) => U;
  note?: string;
};

type PaginatedJsonResponseOptions<T, U = T> = JsonItemsResponseOptions<T, U> & {
  emptyText?: string;
};

type ItemsJsonResponseOptions<T, U = T> = JsonItemsResponseOptions<T, U> & {
  emptyText?: string;
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
  // Keep the response shape uniform JSON for every list outcome. When empty,
  // surface emptyText as a `note` (e.g. setup guidance) rather than swapping to
  // a plain-text body, so agents always get { items, has_more, next_offset }.
  const note =
    items.length === 0 ? (options.emptyText ?? options.note) : options.note;

  return jsonResponse({
    items: options.mapItem ? items.map(options.mapItem) : items,
    has_more: options.has_more,
    next_offset: options.next_offset,
    ...(note && { note }),
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

// Named after what the API said, so a stale session id (404) is distinguishable from an
// org hitting its limits (429) or a fault on our side (5xx). Status codes only; the
// message stays out.
class ToolCallError extends Error {
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

function errorName(error: unknown) {
  if (error instanceof APIError && typeof error.status === "number") {
    return `KernelApiError${error.status}`;
  }
  return error instanceof Error ? error.constructor.name : "Error";
}

/**
 * Fails a tool call that a Kernel API request rejected.
 *
 * Throws rather than returning an isError result: analytics reads the error category
 * from a thrown error's name, while a returned result only ever coerces to a generic
 * "Error". The MCP SDK turns the throw back into the same isError text result the client
 * saw before, so agents see no difference.
 */
export function throwToolError(
  toolName: string,
  action: string,
  error: unknown,
): never {
  throw new ToolCallError(
    errorName(error),
    `Error in ${toolName} (${action}): ${errorMessage(error)}`,
  );
}
