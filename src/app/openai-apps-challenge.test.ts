import { describe, expect, test } from "bun:test";
import { GET } from "./.well-known/openai-apps-challenge/route";

describe("GET /.well-known/openai-apps-challenge", () => {
  test("returns only the OpenAI domain-verification token", async () => {
    const response = GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/plain; charset=utf-8",
    );
    expect(await response.text()).toBe(
      "5ufJ4BzJR-nDzwTWcxy5dpQ5pq-tZDvbkklG_6VKE-A",
    );
  });
});
