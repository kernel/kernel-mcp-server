import { describe, expect, it } from "bun:test";
import {
  CONNECTOR_TRIGGER_VALUES,
  DISCOVERY_SOURCE_VALUES,
  parseOAuthAttribution,
} from "./attribution";

describe("parseOAuthAttribution", () => {
  it("accepts a valid pair of answers", () => {
    expect(
      parseOAuthAttribution({
        firstDiscoverySource: DISCOVERY_SOURCE_VALUES[0],
        connectorTrigger: CONNECTOR_TRIGGER_VALUES[0],
      }),
    ).toEqual({
      firstDiscoverySource: DISCOVERY_SOURCE_VALUES[0],
      connectorTrigger: CONNECTOR_TRIGGER_VALUES[0],
      signupPath: "oauth_picker",
    });
  });

  it("rejects missing answers", () => {
    expect(
      parseOAuthAttribution({
        firstDiscoverySource: DISCOVERY_SOURCE_VALUES[0],
      }),
    ).toBeNull();
  });

  it("rejects values outside the allowed choices", () => {
    expect(
      parseOAuthAttribution({
        firstDiscoverySource: "unknown",
        connectorTrigger: CONNECTOR_TRIGGER_VALUES[0],
      }),
    ).toBeNull();
  });
});
