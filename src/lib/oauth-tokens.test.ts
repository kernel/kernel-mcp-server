import { describe, expect, test } from "bun:test";
import {
  isKernelOAuthAccessToken,
  isKernelOAuthRefreshToken,
  issueKernelOAuthTokens,
  openOAuthProviderToken,
  sealOAuthProviderToken,
} from "./oauth-tokens";

process.env.CLERK_SECRET_KEY ??= "test-clerk-secret";

describe("Kernel OAuth tokens", () => {
  test("issues distinct opaque access and refresh credentials", () => {
    const first = issueKernelOAuthTokens();
    const second = issueKernelOAuthTokens();

    expect(isKernelOAuthAccessToken(first.accessToken)).toBe(true);
    expect(isKernelOAuthRefreshToken(first.refreshToken)).toBe(true);
    expect(first.accessToken).not.toBe(second.accessToken);
    expect(first.refreshToken).not.toBe(second.refreshToken);
    expect(first.accessToken.split(".")).toHaveLength(1);
  });

  test("encrypts provider credentials and rejects tampering", () => {
    const sealed = sealOAuthProviderToken("provider-secret");
    expect(sealed).not.toContain("provider-secret");
    expect(openOAuthProviderToken(sealed)).toBe("provider-secret");

    const parts = sealed.split(".");
    parts[3] = `${parts[3]?.startsWith("A") ? "B" : "A"}${parts[3]?.slice(1)}`;
    expect(() => openOAuthProviderToken(parts.join("."))).toThrow(
      "Invalid encrypted OAuth provider token",
    );
  });
});
