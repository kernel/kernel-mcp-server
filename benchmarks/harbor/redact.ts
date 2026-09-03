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
  "set-cookie",
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
    /(?:^|_)(?:api_key|access_token|auth_token|refresh_token|session_token|password|private_key|credential|session_id|replay_id|cdp_url|viewer_url)$/.test(
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

const TYPED_CALL = /\.(?:fill|type)\(([^)]*)\)/g;
const STRING_LITERAL = /(["'`])((?:\\.|(?!\1).)*)\1/g;

function typedCallValues(value: string): string[] {
  const values: string[] = [];
  for (const call of value.matchAll(TYPED_CALL)) {
    const literals = [...call[1].matchAll(STRING_LITERAL)];
    const typedValue = literals.at(-1)?.[2];
    if (typedValue !== undefined) values.push(typedValue);
  }
  return values;
}

function redactTypedLiterals(value: string): string {
  return value.replace(TYPED_CALL, (call, argumentsText: string) => {
    const literals = [...argumentsText.matchAll(STRING_LITERAL)];
    const typedValue = literals.at(-1);
    if (!typedValue || typedValue.index === undefined) return call;
    const start = typedValue.index;
    const end = start + typedValue[0].length;
    const quote = typedValue[1];
    const redactedArguments = `${argumentsText.slice(0, start)}${quote}${REDACTED}${quote}${argumentsText.slice(end)}`;
    return call.replace(argumentsText, redactedArguments);
  });
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
      /(["']?(?:api[_-]?key|access[_-]?token|auth[_-]?token|credential|jwt|password|private[_-]?key|refresh[_-]?token|replay[_-]?id|secret|session[_-]?id|session[_-]?token|token)["']?\s*[:=]\s*["']?)[^"'\s,}&]+/gi,
      `$1${REDACTED}`,
    )
    .replace(
      /([?&](?:api[_-]?key|access[_-]?token|auth|code|credential|jwt|password|secret|session[_-]?id|session[_-]?token|token)=)[^&#\s]+/gi,
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

function assertSafeString(value: string): void {
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(value)) {
    throw new Error("Braintrust payload still contains an email address");
  }
  for (const typedValue of typedCallValues(value)) {
    if (typedValue !== REDACTED) {
      throw new Error("Braintrust payload still contains a typed form value");
    }
  }
  for (const match of value.matchAll(
    /["']?(?:api[_-]?key|access[_-]?token|auth[_-]?token|credential|jwt|password|private[_-]?key|refresh[_-]?token|replay[_-]?id|secret|session[_-]?id|session[_-]?token)["']?\s*[:=]\s*["']?([^"'\s,}&]+)/gi,
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
