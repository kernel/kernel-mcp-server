const SECRET_NAME = /(API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY|CREDENTIAL)/i;
const REDACTED = "[REDACTED]";
const REDACTED_PRIVATE_INFO = "[REDACTED_PRIVATE_INFO]";

const SENSITIVE_FIELDS = new Set([
  "api_key",
  "access_token",
  "auth_token",
  "refresh_token",
  "session_token",
  "token",
  "jwt",
  "secret",
  "password",
  "private_key",
  "credential",
  "credentials",
  "cookie",
  "set_cookie",
  "session_id",
  "replay_id",
  "cdp_url",
  "cdp_ws_url",
  "viewer_url",
  "browser_live_view_url",
  "email",
  "phone",
  "address",
]);

function normalizedField(key: string): string {
  return key.trim().toLowerCase().replace(/-/g, "_");
}

function sensitiveField(key: string): boolean {
  const normalized = normalizedField(key);
  return (
    SENSITIVE_FIELDS.has(normalized) ||
    /(?:^|_)(?:api_key|access_token|auth_token|refresh_token|session_token|password|private_key|credential|secret(?:_key)?|session_id|replay_id|cdp_url|viewer_url)$/.test(
      normalized,
    )
  );
}

function secretValues(): string[] {
  return Object.entries(process.env)
    .filter(
      ([name, value]) => SECRET_NAME.test(name) && value && value.length >= 6,
    )
    .map(([, value]) => value as string)
    .sort((left, right) => right.length - left.length);
}

const TYPING_METHODS = new Set([
  "fill",
  "type",
  "pressSequentially",
  "insertText",
]);

interface TypedLiteral {
  start: number;
  end: number;
}

function typedLiterals(value: string): TypedLiteral[] {
  const callStart = /^\.([A-Za-z]+)\s*\(/;
  const literals: TypedLiteral[] = [];
  let cursor = 0;

  while (cursor < value.length) {
    const quote = value[cursor];
    if (quote === '"' || quote === "'" || quote === "`") {
      cursor += 1;
      while (cursor < value.length) {
        if (value[cursor] === "\\") {
          cursor += 2;
        } else if (value[cursor] === quote) {
          cursor += 1;
          break;
        } else {
          cursor += 1;
        }
      }
      continue;
    }

    const match = value.slice(cursor).match(callStart);
    if (!match || !TYPING_METHODS.has(match[1])) {
      cursor += 1;
      continue;
    }

    let callCursor = cursor + match[0].length;
    let depth = 1;
    let lastLiteral: TypedLiteral | undefined;
    while (callCursor < value.length && depth > 0) {
      const callQuote = value[callCursor];
      if (callQuote === '"' || callQuote === "'" || callQuote === "`") {
        const start = callCursor;
        callCursor += 1;
        while (callCursor < value.length) {
          if (value[callCursor] === "\\") {
            callCursor += 2;
          } else if (value[callCursor] === callQuote) {
            callCursor += 1;
            break;
          } else {
            callCursor += 1;
          }
        }
        lastLiteral = { start, end: callCursor };
        continue;
      }
      if (value.startsWith("//", callCursor)) {
        const newline = value.indexOf("\n", callCursor + 2);
        callCursor = newline === -1 ? value.length : newline + 1;
        continue;
      }
      if (value.startsWith("/*", callCursor)) {
        const commentEnd = value.indexOf("*/", callCursor + 2);
        callCursor = commentEnd === -1 ? value.length : commentEnd + 2;
        continue;
      }
      if (value[callCursor] === "(") depth += 1;
      if (value[callCursor] === ")") depth -= 1;
      callCursor += 1;
    }

    if (lastLiteral) literals.push(lastLiteral);
    cursor = callCursor;
  }
  return literals;
}

function typedCallValues(value: string): string[] {
  return typedLiterals(value).map((literal) =>
    value.slice(literal.start + 1, literal.end - 1),
  );
}

function redactTypedLiterals(value: string): string {
  let redacted = value;
  for (const literal of typedLiterals(value).sort(
    (left, right) => right.start - left.start,
  )) {
    const quote = value[literal.start];
    redacted = `${redacted.slice(0, literal.start)}${quote}${REDACTED}${quote}${redacted.slice(literal.end)}`;
  }
  return redacted;
}

export function redactStringWithSecrets(
  value: string,
  additionalSecrets: string[],
  maxLength = 20_000,
): string {
  let redacted = value;
  for (const secret of [...secretValues(), ...additionalSecrets]) {
    if (secret.length >= 4) redacted = redacted.split(secret).join(REDACTED);
  }

  redacted = redactTypedLiterals(redacted)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED)
    .replace(/\b(?:sk|pk|bt|kapi|whsec)[-_][A-Za-z0-9_-]{12,}\b/gi, REDACTED)
    .replace(
      /(["']?(?:api[_-]?key|access[_-]?token|auth[_-]?token|credential|jwt|password|private[_-]?key|refresh[_-]?token|replay[_-]?id|[a-z0-9_-]*secret(?:[_-]?key)?|session[_-]?id|session[_-]?token|token)["']?\s*[:=]\s*["']?)[^"'\s,}&]+/gi,
      `$1${REDACTED}`,
    )
    .replace(
      /([?&](?:api[_-]?key|access[_-]?token|auth|code|credential|jwt|password|[a-z0-9_-]*secret(?:[_-]?key)?|session[_-]?id|session[_-]?token|token)=)[^&#\s]+/gi,
      `$1${REDACTED}`,
    )
    .replace(/(\b(?:cookie|set-cookie)\s*:\s*)[^\r\n]+/gi, `$1${REDACTED}`)
    .replace(/(\/browser\/live\/)[^/?#\s]+/gi, `$1${REDACTED}`)
    .replace(/(wss?:\/\/)[^/@\s]+@/gi, `$1${REDACTED}@`)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]");

  return redacted.length > maxLength
    ? `${redacted.slice(0, maxLength)}…`
    : redacted;
}

export function redactString(value: string, maxLength = 20_000): string {
  return redactStringWithSecrets(value, [], maxLength);
}

export function redactValueWithSecrets(
  value: unknown,
  additionalSecrets: string[],
  maxStringLength = 20_000,
): unknown {
  if (typeof value === "string") {
    return redactStringWithSecrets(value, additionalSecrets, maxStringLength);
  }
  if (Array.isArray(value)) {
    return value.map((entry) =>
      redactValueWithSecrets(entry, additionalSecrets, maxStringLength),
    );
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        sensitiveField(key)
          ? REDACTED
          : redactValueWithSecrets(entry, additionalSecrets, maxStringLength),
      ]),
    );
  }
  return value;
}

export function redactValue(value: unknown, maxStringLength = 20_000): unknown {
  return redactValueWithSecrets(value, [], maxStringLength);
}

export function collectSensitiveValues(value: unknown): string[] {
  const values = new Set<string>();
  const collectString = (text: string) => {
    for (const match of text.matchAll(
      /["']?(?:password|private[_-]?key|secret|session[_-]?id|replay[_-]?id)["']?\s*[:=]\s*["']([^"'\s,}&]{4,})/gi,
    )) {
      values.add(match[1]);
    }
    for (const typedValue of typedCallValues(text)) {
      if (typedValue.length >= 4) values.add(typedValue);
    }
    for (const match of text.matchAll(
      /["'](?:id|name|type)["']\s*:\s*["'][^"']*password[^"']*["'][\s\S]{0,300}?["']value["']\s*:\s*["']([^"']{4,})["']/gi,
    )) {
      values.add(match[1]);
    }
  };
  const visit = (entry: unknown, key?: string) => {
    if (typeof entry === "string") {
      if (key && sensitiveField(key) && entry.length >= 4) values.add(entry);
      collectString(entry);
      return;
    }
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item);
      return;
    }
    if (entry !== null && typeof entry === "object") {
      for (const [childKey, child] of Object.entries(
        entry as Record<string, unknown>,
      )) {
        visit(child, childKey);
      }
    }
  };
  visit(value);
  return [...values].sort((left, right) => right.length - left.length);
}

export function privateInfoRead(toolName: string, input: unknown): boolean {
  if (!/(?:^|__)(?:exec_command|bash|read)$/i.test(toolName)) return false;
  const fields =
    input !== null && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
  const text = [
    fields.cmd,
    fields.command,
    fields.file_path,
    fields.path,
    typeof input === "string" ? input : undefined,
  ]
    .filter((entry) => entry !== undefined)
    .map(String)
    .join("\n");
  const paths = [
    ...text.matchAll(
      /(?:^|[\s"'`=])(?:\.\/|\/(?:workspace\/)?|workspace\/)?my-info\/([^\s"'`;)]*)/g,
    ),
  ].map((match) => match[1]);
  return paths.some(
    (path) =>
      path.length === 0 || !/^kernel_browser\.json(?:$|[?#])/.test(path),
  );
}

function assertTypedCallsRedacted(value: string): void {
  const callStart = /^\.(?:fill|type|pressSequentially|insertText)\s*\(/;
  let cursor = 0;

  while (cursor < value.length) {
    const quote = value[cursor];
    if (quote === '"' || quote === "'" || quote === "`") {
      cursor += 1;
      while (cursor < value.length) {
        if (value[cursor] === "\\") {
          cursor += 2;
        } else if (value[cursor] === quote) {
          cursor += 1;
          break;
        } else {
          cursor += 1;
        }
      }
      continue;
    }

    const match = value.slice(cursor).match(callStart);
    if (!match) {
      cursor += 1;
      continue;
    }

    let callCursor = cursor + match[0].length;
    let depth = 1;
    let lastLiteral: string | undefined;
    while (callCursor < value.length && depth > 0) {
      const callQuote = value[callCursor];
      if (callQuote === '"' || callQuote === "'" || callQuote === "`") {
        const literalStart = callCursor + 1;
        callCursor += 1;
        while (callCursor < value.length) {
          if (value[callCursor] === "\\") {
            callCursor += 2;
          } else if (value[callCursor] === callQuote) {
            break;
          } else {
            callCursor += 1;
          }
        }
        lastLiteral = value.slice(literalStart, callCursor);
        if (callCursor < value.length) callCursor += 1;
        continue;
      }
      if (value.startsWith("//", callCursor)) {
        const newline = value.indexOf("\n", callCursor + 2);
        callCursor = newline === -1 ? value.length : newline + 1;
        continue;
      }
      if (value.startsWith("/*", callCursor)) {
        const commentEnd = value.indexOf("*/", callCursor + 2);
        callCursor = commentEnd === -1 ? value.length : commentEnd + 2;
        continue;
      }
      if (value[callCursor] === "(") depth += 1;
      if (value[callCursor] === ")") depth -= 1;
      callCursor += 1;
    }

    if (lastLiteral !== undefined && lastLiteral !== REDACTED) {
      throw new Error("Braintrust payload still contains a typed form value");
    }
    cursor = callCursor;
  }
}

function assertSafeString(value: string): void {
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(value)) {
    throw new Error("Braintrust payload still contains an email address");
  }
  assertTypedCallsRedacted(value);
  for (const match of value.matchAll(
    /["']?(?:api[_-]?key|access[_-]?token|auth[_-]?token|credential|jwt|password|private[_-]?key|refresh[_-]?token|replay[_-]?id|[a-z0-9_-]*secret(?:[_-]?key)?|session[_-]?id|session[_-]?token)["']?\s*[:=]\s*["']?([^"'\s,}&]+)/gi,
  )) {
    if (match[1] !== REDACTED) {
      throw new Error(
        "Braintrust payload still contains a sensitive field value",
      );
    }
  }
  for (const secret of secretValues()) {
    if (value.includes(secret)) {
      throw new Error("Braintrust payload still contains a configured secret");
    }
  }
}

export function assertSafeToPublish(value: unknown): void {
  if (typeof value === "string") {
    assertSafeString(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) assertSafeToPublish(entry);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (sensitiveField(key) && entry !== REDACTED) {
        throw new Error(`Braintrust payload did not redact ${key}`);
      }
      assertSafeToPublish(entry);
    }
  }
}

export { REDACTED, REDACTED_PRIVATE_INFO };
