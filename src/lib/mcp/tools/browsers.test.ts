import assert from "node:assert/strict";
import test from "node:test";
import {
  compactTelemetryEvent,
  summarizeEmptyTelemetryResult,
} from "./browsers";

const source = { kind: "cdp" as const };
const ts = 1_750_000_000_000_000;

test("omits known high-volume telemetry fields", () => {
  const request = compactTelemetryEvent({
    seq: 1,
    event: {
      category: "network",
      type: "network_request",
      source,
      ts,
      data: {
        headers: { authorization: "secret" },
        post_data: "request body",
        method: "POST",
      },
    },
  });
  const response = compactTelemetryEvent({
    seq: 2,
    event: {
      category: "network",
      type: "network_response",
      source,
      ts,
      data: {
        body: "response body",
        headers: { "content-type": "text/plain" },
        status: 200,
      },
    },
  });
  const screenshot = compactTelemetryEvent({
    seq: 3,
    event: {
      category: "screenshot",
      type: "monitor_screenshot",
      source,
      ts,
      data: { png: "base64 image" },
    },
  });

  assert.deepEqual(request.data, { method: "POST" });
  assert.deepEqual(request.omitted_fields, ["headers", "post_data"]);
  assert.deepEqual(response.data, { status: 200 });
  assert.deepEqual(response.omitted_fields, ["body", "headers"]);
  assert.deepEqual(screenshot.data, {});
  assert.deepEqual(screenshot.omitted_fields, ["png"]);
});

test("keeps a page of screenshot events compact", () => {
  const png = "x".repeat(256 * 1024);
  const events = Array.from({ length: 100 }, (_, seq) =>
    compactTelemetryEvent({
      seq,
      event: {
        category: "screenshot",
        type: "monitor_screenshot",
        source,
        ts,
        data: { png },
      },
    }),
  );
  const serialized = JSON.stringify(events);

  assert.ok(Buffer.byteLength(serialized, "utf8") < 50 * 1024);
  assert.ok(events.every((event) => event.omitted_fields?.includes("png")));
});

test("omits oversized fields not on the known-field list", () => {
  const event = compactTelemetryEvent({
    seq: 1,
    event: {
      category: "console",
      type: "console_error",
      source,
      ts,
      data: { text: "x".repeat(9 * 1024), level: "error" },
    },
  });

  assert.deepEqual(event.data, { level: "error" });
  assert.deepEqual(event.omitted_fields, ["text"]);
});

test("preserves small telemetry fields", () => {
  const event = compactTelemetryEvent({
    seq: 1,
    event: {
      category: "console",
      type: "console_error",
      source,
      ts,
      data: { text: "boom", level: "error" },
    },
  });

  assert.deepEqual(event.data, { text: "boom", level: "error" });
  assert.equal(event.omitted_fields, undefined);
});

test("summarizes empty telemetry results without conflating query and capture state", () => {
  assert.deepEqual(
    summarizeEmptyTelemetryResult({
      hasMore: true,
      fullSessionRead: false,
      telemetryDisabled: true,
    }),
    {
      status: "ok",
      note: "No matching events on this page; continue with next_offset.",
    },
  );
  assert.deepEqual(
    summarizeEmptyTelemetryResult({
      hasMore: false,
      fullSessionRead: false,
      telemetryDisabled: false,
    }),
    { status: "no_events", note: "No events matched this query." },
  );
  assert.deepEqual(
    summarizeEmptyTelemetryResult({
      hasMore: false,
      fullSessionRead: true,
      telemetryDisabled: false,
    }),
    {
      status: "no_events",
      note: "No telemetry events are archived for this session.",
    },
  );
  assert.deepEqual(
    summarizeEmptyTelemetryResult({
      hasMore: false,
      fullSessionRead: true,
      telemetryDisabled: true,
    }),
    {
      status: "no_events",
      note: "No telemetry events are archived for this session. Telemetry is currently disabled.",
    },
  );
});
