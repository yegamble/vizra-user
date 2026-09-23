/**
 * The no-pixels runtime check's decision logic. The end-to-end halves live in
 * `scripts/e2e/demonstrate.sh` (D23): a spec's `test.use` red by name, and the
 * check switched off letting the pixels back.
 */
import { describe, expect, it } from "vitest";

import { LANE_A_RECORDERS, recorderMessage, recorderProblems } from "./recorders";

const shipped = {
  screenshot: "off",
  video: "off",
  trace: { mode: "retain-on-failure", sources: false, screenshots: false },
};

describe("recorderProblems: the resolved recorder options, checked by value", () => {
  it("accepts exactly what playwright.config.ts sets, whatever the key order (inverse control)", () => {
    expect(recorderProblems(shipped)).toEqual([]);
    expect(
      recorderProblems({ ...shipped, trace: { screenshots: false, mode: "retain-on-failure", sources: false } }),
    ).toEqual([]);
  });

  it("refuses the verifier's E6 values, naming all three", () => {
    expect(
      recorderProblems({
        screenshot: "on",
        video: "on",
        trace: { mode: "on", sources: false, screenshots: true },
      }),
    ).toEqual(["screenshot", "video", "trace"]);
  });

  it("refuses the old Lane A values, one by one", () => {
    expect(recorderProblems({ ...shipped, screenshot: "only-on-failure" })).toEqual(["screenshot"]);
    expect(recorderProblems({ ...shipped, video: "retain-on-failure" })).toEqual(["video"]);
    expect(recorderProblems({ ...shipped, trace: { mode: "retain-on-failure", sources: false } })).toEqual([
      "trace",
    ]);
  });

  it("refuses the object forms and extra keys, not only the string forms", () => {
    expect(recorderProblems({ ...shipped, screenshot: { mode: "off" } })).toEqual(["screenshot"]);
    expect(recorderProblems({ ...shipped, video: { mode: "off", size: { width: 1, height: 1 } } })).toEqual(["video"]);
    expect(
      recorderProblems({ ...shipped, trace: { ...shipped.trace, snapshots: true } }),
    ).toEqual(["trace"]);
    expect(recorderProblems({ ...shipped, trace: "retain-on-failure" })).toEqual(["trace"]);
  });

  it("the literals are frozen, so no module can widen them at runtime", () => {
    expect(Object.isFrozen(LANE_A_RECORDERS)).toBe(true);
    expect(Object.isFrozen(LANE_A_RECORDERS.trace)).toBe(true);
  });
});

describe("recorderMessage: names, never the resolved value", () => {
  it("names the option and what it must be, and echoes nothing the spec supplied", () => {
    const planted = "VZ_PLANTED_VALUE_7f3c";
    const message = recorderMessage(recorderProblems({ ...shipped, screenshot: planted }), "for this test");
    expect(message).toContain("`screenshot`");
    expect(message).toContain('must be "off"');
    expect(message).not.toContain(planted);
  });
});

describe("recorderProblems refuses values that disguise themselves (PR #10 re-verification, N1, N2)", () => {
  const liveTrace = { mode: "retain-on-failure", sources: false, screenshots: false };

  it("N1: a toJSON that reports the literals while .mode says on is refused, for all three", () => {
    const screenshot = { mode: "on", toJSON: () => "off" };
    const video = { mode: "on", toJSON: () => "off" };
    const trace = { mode: "on", sources: false, screenshots: true, toJSON: () => liveTrace };
    expect(recorderProblems({ screenshot, video, trace })).toEqual(["screenshot", "video", "trace"]);
  });

  it("N1 variant: a toJSON on an otherwise exact trace object is refused (extra key, and it is a function)", () => {
    expect(recorderProblems({ ...shipped, trace: { ...liveTrace, toJSON: () => liveTrace } })).toEqual(["trace"]);
  });

  it("N2: getters that answer the literals are refused, without calling them", () => {
    let calls = 0;
    const trace = {
      get mode() {
        calls += 1;
        return "retain-on-failure";
      },
      sources: false,
      get screenshots() {
        calls += 1;
        return false;
      },
    };
    expect(recorderProblems({ ...shipped, trace })).toEqual(["trace"]);
    expect(calls).toBe(0);
  });

  it("a Proxy that reports a plain object is refused", () => {
    const trace = new Proxy({ ...liveTrace }, {});
    expect(recorderProblems({ ...shipped, trace })).toEqual(["trace"]);
  });

  it("a class instance, a null-prototype object, a non-enumerable field and a symbol key are refused", () => {
    class Trace {
      mode = "retain-on-failure";
      sources = false;
      screenshots = false;
    }
    expect(recorderProblems({ ...shipped, trace: new Trace() })).toEqual(["trace"]);
    expect(recorderProblems({ ...shipped, trace: Object.assign(Object.create(null), liveTrace) })).toEqual(["trace"]);
    const hidden = { ...liveTrace };
    Object.defineProperty(hidden, "screenshots", { value: false, enumerable: false });
    expect(recorderProblems({ ...shipped, trace: hidden })).toEqual(["trace"]);
    expect(recorderProblems({ ...shipped, trace: { ...liveTrace, [Symbol("x")]: 1 } })).toEqual(["trace"]);
  });

  it("a String object is not the primitive \"off\"", () => {
    expect(recorderProblems({ ...shipped, screenshot: new String("off") })).toEqual(["screenshot"]);
  });

  it("the check does not use Array.prototype.filter, so patching it does not blind the check", () => {
    const original = Array.prototype.filter;
    try {
      Array.prototype.filter = function () {
        return [];
      } as typeof Array.prototype.filter;
      expect(recorderProblems({ ...shipped, video: "on" })).toEqual(["video"]);
    } finally {
      Array.prototype.filter = original;
    }
  });
});
