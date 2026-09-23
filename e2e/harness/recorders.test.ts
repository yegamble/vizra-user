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
