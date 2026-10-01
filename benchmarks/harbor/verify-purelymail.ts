#!/usr/bin/env bun
import { randomBytes, randomUUID } from "node:crypto";

interface PurelyMailResponse {
  type?: string;
  code?: string;
  message?: string;
}

function env(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function request(
  fetcher: typeof fetch,
  apiKey: string,
  endpoint: string,
  body: Record<string, unknown>,
): Promise<PurelyMailResponse> {
  const response = await fetcher(`https://purelymail.com/api/v0/${endpoint}`, {
    method: "POST",
    headers: {
      "Purelymail-Api-Token": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`PurelyMail ${endpoint} returned HTTP ${response.status}`);
  }
  const result = (await response.json()) as PurelyMailResponse;
  if (!result || typeof result !== "object") {
    throw new Error(`PurelyMail ${endpoint} returned an invalid response`);
  }
  if (result.type === "error") {
    const code = result.code ? ` (${result.code})` : "";
    const message = result.message ? `: ${result.message}` : "";
    throw new Error(`PurelyMail ${endpoint} failed${code}${message}`);
  }
  return result;
}

export async function verifyPurelyMail(
  apiKey: string,
  domain: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const local = `cbpreflight${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const email = `${local}@${domain}`;
  const password = randomBytes(18).toString("base64url");
  let created = false;
  try {
    await request(fetcher, apiKey, "createUser", {
      userName: local,
      domainName: domain,
      password,
      enablePasswordReset: false,
      sendWelcomeEmail: false,
    });
    created = true;
  } finally {
    if (created) {
      await request(fetcher, apiKey, "deleteUser", { userName: email });
    }
  }
}

async function main(): Promise<void> {
  await verifyPurelyMail(env("PURELY_MAIL_API_KEY"), env("PURELY_MAIL_DOMAIN"));
  process.stdout.write("PurelyMail preflight passed\n");
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
