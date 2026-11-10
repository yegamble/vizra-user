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

describe("recorderProblems: an unknown key standing in for a required one (sentinel F-5)", () => {
  it("a misspelt key whose value is undefined, with a required key missing, is refused", () => {
    // Same key COUNT as the literal, so only the unknown-key clause can refuse it. With
    // `screenshots` absent Playwright falls back to its default and records screencast frames.
    expect(
      recorderProblems({ ...shipped, trace: { mode: "retain-on-failure", sources: false, screenshotz: undefined } }),
    ).toEqual(["trace"]);
  });
});

describe("recorderProblems: the EFFECTIVE context options (war-room rule R7, sentinel F-2)", () => {
  const harPath = "test-results/zz/net.har";

  it("accepts Playwright's effective options for Lane A (inverse control)", () => {
    const effective = { viewport: { width: 1440, height: 900 }, locale: "en-US", baseURL: "http://127.0.0.1:3000" };
    expect(recorderProblems({ ...shipped, contextOptions: effective })).toEqual([]);
    expect(recorderProblems({ ...shipped, contextOptions: {} })).toEqual([]);
  });

  it("the worker fixture passes no context options, and that is not a refusal", () => {
    expect(recorderProblems(shipped)).toEqual([]);
  });

  it("refuses recordHar and recordVideo, whatever their value", () => {
    expect(recorderProblems({ ...shipped, contextOptions: { recordHar: { path: harPath, content: "embed" } } })).toEqual([
      "contextOptions",
    ]);
    expect(recorderProblems({ ...shipped, contextOptions: { recordVideo: { dir: "test-results/zz" } } })).toEqual([
      "contextOptions",
    ]);
    expect(recorderProblems({ ...shipped, contextOptions: { recordHar: undefined } })).toEqual(["contextOptions"]);
  });

  it("refuses a getter, a non-enumerable key, a Proxy, a class instance and a null prototype", () => {
    let reads = 0;
    const getter = {
      get recordHar() {
        reads += 1;
        return undefined;
      },
    };
    expect(recorderProblems({ ...shipped, contextOptions: getter })).toEqual(["contextOptions"]);
    expect(reads).toBe(0);
    const hidden = {};
    Object.defineProperty(hidden, "recordVideo", { value: { dir: "x" }, enumerable: false });
    expect(recorderProblems({ ...shipped, contextOptions: hidden })).toEqual(["contextOptions"]);
    expect(recorderProblems({ ...shipped, contextOptions: new Proxy({}, {}) })).toEqual(["contextOptions"]);
    class Options {}
    expect(recorderProblems({ ...shipped, contextOptions: new Options() })).toEqual(["contextOptions"]);
    expect(recorderProblems({ ...shipped, contextOptions: Object.create(null) })).toEqual(["contextOptions"]);
    expect(recorderProblems({ ...shipped, contextOptions: "recordHar" })).toEqual(["contextOptions"]);
  });

  it("refuses when Object.prototype carries recordHar, which a merged options object would inherit", () => {
    const proto = Object.prototype as Record<string, unknown>;
    try {
      proto.recordHar = { path: harPath };
      expect(recorderProblems({ ...shipped, contextOptions: {} })).toEqual(["contextOptions"]);
    } finally {
      delete proto.recordHar;
    }
    expect(recorderProblems({ ...shipped, contextOptions: {} })).toEqual([]);
  });

  it("names contextOptions and what it must be, and echoes nothing the spec supplied", () => {
    const message = recorderMessage(["contextOptions"], "for this test");
    expect(message).toContain("`contextOptions` must be a plain object with no `recordHar` and no `recordVideo`");
    expect(message).not.toContain(harPath);
  });
});
