import { describe, expect, test } from "bun:test";
import { verifyPurelyMail } from "./verify-purelymail";

describe("PurelyMail benchmark preflight", () => {
  test("creates and deletes a disposable account", async () => {
    const requests: Array<{ endpoint: string; body: Record<string, unknown> }> =
      [];
    const fetcher = (async (request, init) => {
      requests.push({
        endpoint: new URL(String(request)).pathname.split("/").at(-1) ?? "",
        body: JSON.parse(String(init?.body)),
      });
      return Response.json({ type: "success" });
    }) as typeof fetch;

    await verifyPurelyMail("api-key", "example.test", fetcher);

    expect(requests.map((request) => request.endpoint)).toEqual([
      "createUser",
      "deleteUser",
    ]);
    expect(requests[0].body).toMatchObject({
      domainName: "example.test",
      enablePasswordReset: false,
      sendWelcomeEmail: false,
    });
    expect(requests[1].body.userName).toBe(
      `${requests[0].body.userName}@example.test`,
    );
  });

  test("fails closed on API errors without printing credentials", async () => {
    const fetcher = (async () =>
      Response.json({
        type: "error",
        code: "invalidToken",
        message: "Token not valid.",
      })) as unknown as typeof fetch;

    await expect(
      verifyPurelyMail("secret-api-key", "example.test", fetcher),
    ).rejects.toThrow(
      "PurelyMail createUser failed (invalidToken): Token not valid.",
    );
  });
});
