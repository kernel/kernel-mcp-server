const SECRET_NAME = /(API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY|CREDENTIAL)/i;
const REDACTED = "[REDACTED]";

function secretValues(): string[] {
  return Object.entries(process.env)
    .filter(
      ([name, value]) => SECRET_NAME.test(name) && value && value.length >= 6,
    )
    .map(([, value]) => value as string)
    .sort((left, right) => right.length - left.length);
}

export function redactString(value: string, maxLength = 20_000): string {
  let redacted = value;
  for (const secret of secretValues()) {
    redacted = redacted.split(secret).join(REDACTED);
  }

  redacted = redacted
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED)
    .replace(/\b(?:sk|pk|bt|kapi|whsec)[-_][A-Za-z0-9_-]{12,}\b/gi, REDACTED)
    .replace(
      /(["']?(?:api[_-]?key|access[_-]?token|credential|password|secret)["']?\s*[:=]\s*["']?)[^"'\s,}&]+/gi,
      `$1${REDACTED}`,
    )
    .replace(
      /([?&](?:api[_-]?key|access[_-]?token|auth|code|credential|password|secret|session[_-]?token)=)[^&#\s]+/gi,
      `$1${REDACTED}`,
    )
    .replace(/(wss?:\/\/)[^/@\s]+@/gi, `$1${REDACTED}@`)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]");

  return redacted.length > maxLength
    ? `${redacted.slice(0, maxLength)}…`
    : redacted;
}

export function redactValue(value: unknown, maxStringLength = 20_000): unknown {
  if (typeof value === "string") return redactString(value, maxStringLength);
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, maxStringLength));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        SECRET_NAME.test(key) ? REDACTED : redactValue(entry, maxStringLength),
      ]),
    );
  }
  return value;
}
