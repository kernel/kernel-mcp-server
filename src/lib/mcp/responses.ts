export function textResponse(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

export function jsonResponse(value: unknown) {
  return textResponse(JSON.stringify(value, null, 2));
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
