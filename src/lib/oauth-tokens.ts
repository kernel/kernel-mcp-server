import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "crypto";

export const KERNEL_OAUTH_ACCESS_TOKEN_PREFIX = "kmcp_at_";
export const KERNEL_OAUTH_REFRESH_TOKEN_PREFIX = "kmcp_rt_";

function randomToken(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

export function issueKernelOAuthTokens(): {
  accessToken: string;
  refreshToken: string;
} {
  return {
    accessToken: randomToken(KERNEL_OAUTH_ACCESS_TOKEN_PREFIX),
    refreshToken: randomToken(KERNEL_OAUTH_REFRESH_TOKEN_PREFIX),
  };
}

export function isKernelOAuthAccessToken(token: string): boolean {
  return token.startsWith(KERNEL_OAUTH_ACCESS_TOKEN_PREFIX);
}

export function isKernelOAuthRefreshToken(token: string): boolean {
  return token.startsWith(KERNEL_OAUTH_REFRESH_TOKEN_PREFIX);
}

function encryptionKey(): Buffer {
  const secret = process.env.CLERK_SECRET_KEY;
  if (!secret) {
    throw new Error("CLERK_SECRET_KEY environment variable must be set");
  }
  return createHash("sha256")
    .update("kernel-mcp-oauth-credential\0")
    .update(secret)
    .digest();
}

export function sealOAuthProviderToken(token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(token, "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    iv.toString("base64url"),
    ciphertext.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
  ].join(".");
}

export function openOAuthProviderToken(sealed: string): string {
  const [version, encodedIv, encodedCiphertext, encodedTag, ...rest] =
    sealed.split(".");
  if (
    version !== "v1" ||
    !encodedIv ||
    !encodedCiphertext ||
    !encodedTag ||
    rest.length > 0
  ) {
    throw new Error("Invalid encrypted OAuth provider token");
  }

  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      encryptionKey(),
      Buffer.from(encodedIv, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(encodedCiphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("Invalid encrypted OAuth provider token");
  }
}
