import { createHmac, timingSafeEqual } from "node:crypto";

export type AuthFlowCheckpoint =
  | {
      version: 1;
      connectionId: string;
      kind: "after";
      eventId: string | null;
    }
  | {
      version: 1;
      connectionId: string;
      kind: "event";
      eventId: string;
    };

function checkpointKey(): string {
  const key = process.env.CLERK_SECRET_KEY;
  if (!key) {
    throw new Error("CLERK_SECRET_KEY environment variable must be set");
  }
  return key;
}

function sign(payload: string): string {
  return createHmac("sha256", checkpointKey())
    .update(`managed-auth-checkpoint:${payload}`)
    .digest("base64url");
}

export function issueAuthFlowCheckpoint(
  checkpoint: AuthFlowCheckpoint,
): string {
  const payload = Buffer.from(JSON.stringify(checkpoint)).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function verifyAuthFlowCheckpoint(
  token: string,
): AuthFlowCheckpoint | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const expected = Buffer.from(sign(parts[0]));
  const actual = Buffer.from(parts[1]);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return null;
  }

  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== 1 ||
    typeof candidate.connectionId !== "string" ||
    !candidate.connectionId ||
    (candidate.kind !== "after" && candidate.kind !== "event")
  ) {
    return null;
  }
  if (
    candidate.kind === "event" &&
    (typeof candidate.eventId !== "string" || !candidate.eventId)
  ) {
    return null;
  }
  if (
    candidate.kind === "after" &&
    candidate.eventId !== null &&
    (typeof candidate.eventId !== "string" || !candidate.eventId)
  ) {
    return null;
  }
  return candidate as AuthFlowCheckpoint;
}
