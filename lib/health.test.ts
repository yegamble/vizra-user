import { describe, expect, it } from "vitest";

import { healthPayload } from "./health";

describe("healthPayload", () => {
  it("reports liveness of this process and nothing else", () => {
    expect(healthPayload()).toEqual({
      status: "ok",
      service: "vizra-user",
      scope: "liveness",
    });
  });

  it("claims no dependency readiness and no build metadata", () => {
    // Guard against a future edit quietly turning the liveness page into an
    // unearned "all systems ok" banner, or into a version disclosure.
    const keys = Object.keys(healthPayload()).sort();
    expect(keys).toEqual(["scope", "service", "status"]);
  });
});
