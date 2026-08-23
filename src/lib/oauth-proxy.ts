import { createHmac, timingSafeEqual } from "crypto";

const STATE_VERSION = 1;
const STATE_TTL_MS = 60 * 60 * 1000;

interface OAuthProxyState {
  version: number;
  redirectUri: string;
  clientState?: string;
  expiresAt: number;
}

function signingKey(): string {
  const key = process.env.CLERK_SECRET_KEY;
  if (!key) {
    throw new Error("CLERK_SECRET_KEY environment variable must be set");
  }
  return key;
}

function signature(payload: string): Buffer {
  return createHmac("sha256", signingKey()).update(payload).digest();
}

export function oauthProxyCallbackUrl(origin: string): string {
  return new URL("/oauth/callback", origin).toString();
}

export function encodeOAuthProxyState({
  redirectUri,
  clientState,
  now = Date.now(),
}: {
  redirectUri: string;
  clientState: string | null;
  now?: number;
}): string {
  const payload = Buffer.from(
    JSON.stringify({
      version: STATE_VERSION,
      redirectUri,
      ...(clientState === null ? {} : { clientState }),
      expiresAt: now + STATE_TTL_MS,
    } satisfies OAuthProxyState),
  ).toString("base64url");
  return `${payload}.${signature(payload).toString("base64url")}`;
}

export function decodeOAuthProxyState(
  value: string,
  now = Date.now(),
): { redirectUri: string; clientState: string | null } | null {
  const [payload, encodedSignature, extra] = value.split(".");
  if (!payload || !encodedSignature || extra) return null;

  let providedSignature: Buffer;
  try {
    providedSignature = Buffer.from(encodedSignature, "base64url");
  } catch {
    return null;
  }
  const expectedSignature = signature(payload);
  if (
    providedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(providedSignature, expectedSignature)
  ) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(payload, "base64url").toString(),
    ) as Partial<OAuthProxyState>;
    if (
      parsed.version !== STATE_VERSION ||
      typeof parsed.redirectUri !== "string" ||
      (parsed.clientState !== undefined &&
        typeof parsed.clientState !== "string") ||
      typeof parsed.expiresAt !== "number" ||
      parsed.expiresAt < now
    ) {
      return null;
    }
    new URL(parsed.redirectUri);
    return {
      redirectUri: parsed.redirectUri,
      clientState: parsed.clientState ?? null,
    };
  } catch {
    return null;
  }
}
