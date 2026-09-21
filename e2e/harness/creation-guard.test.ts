/**
 * The creation guard, asserted without launching anything.
 *
 * WHY THESE ARE UNIT TESTS AND NOT ONLY DEMONSTRATIONS. `npm run e2e:demos`
 * proves the guard refuses the real routes on a real page, and that is the
 * evidence that matters — but it needs Docker, a production build and a browser,
 * so it is not a CI lane. These run in `npm run ci`, in milliseconds, and they
 * pin the two properties a reader of `creation-guard.ts` has to trust:
 *
 *   1. while ARMED, every method that yields a browser or a persistent context
 *      rejects, and the attempt is recorded even if the caller swallows it;
 *   2. while UNARMED, nothing is touched — which is what lets the Playwright
 *      runner launch its own worker browser through the very same patched
 *      prototype method.
 *
 * Nothing here launches a browser: (1) rejects before calling through, and (2)
 * is asserted by observing that the patched method DELEGATES, using a stand-in
 * prototype rather than a real launch.
 */

import { _android, _electron, chromium, firefox, webkit } from "@playwright/test";
import { describe, expect, it } from "vitest";

import {
  armCreationGuard,
  isCreationGuardArmed,
  type CreationViolation,
} from "./creation-guard";

function arm(): { violations: CreationViolation[]; disarm: () => void } {
  const violations: CreationViolation[] = [];
  const disarm = armCreationGuard({
    registerContext: () => {},
    recordViolation: (violation) => violations.push(violation),
  });
  return { violations, disarm };
}

describe("the creation guard, while armed", () => {
  it("refuses every BrowserType route to a browser the harness was never handed", async () => {
    const { violations, disarm } = arm();
    try {
      // Each is awaited and caught: a spec that swallows the throw must still
      // leave the violation behind, which is what the harness asserts in
      // teardown.
      await expect(chromium.launch()).rejects.toThrow(
        /`chromium\.launch` was called during a test/,
      );
      await expect(
        chromium.launchPersistentContext("/tmp/vizra-does-not-exist"),
      ).rejects.toThrow(/`chromium\.launchPersistentContext` was called during a test/);
      await expect(chromium.launchServer()).rejects.toThrow(
        /`chromium\.launchServer` was called during a test/,
      );
      await expect(chromium.connect("ws://127.0.0.1:1/x")).rejects.toThrow(
        /`chromium\.connect` was called during a test/,
      );
      await expect(chromium.connectOverCDP("http://127.0.0.1:1")).rejects.toThrow(
        /`chromium\.connectOverCDP` was called during a test/,
      );
    } finally {
      disarm();
    }
    expect(violations.map((violation) => violation.api)).toEqual([
      "chromium.launch",
      "chromium.launchPersistentContext",
      "chromium.launchServer",
      "chromium.connect",
      "chromium.connectOverCDP",
    ]);
  });

  it("covers every BrowserType, because they share one prototype", async () => {
    // Measured against the installed 1.63.0: `chromium`, `firefox`, `webkit`
    // and `browser.browserType()` are all instances of one class, and none of
    // these methods is an own property of any of them. That is why patching
    // the prototype closes the method rather than one object's copy of it.
    expect(Object.getPrototypeOf(firefox)).toBe(Object.getPrototypeOf(chromium));
    expect(Object.getPrototypeOf(webkit)).toBe(Object.getPrototypeOf(chromium));
    for (const name of ["launch", "launchPersistentContext", "connect", "connectOverCDP"]) {
      expect(Object.prototype.hasOwnProperty.call(chromium, name)).toBe(false);
    }

    const { violations, disarm } = arm();
    try {
      await expect(firefox.launch()).rejects.toThrow(/firefox\.launch/);
      await expect(webkit.launch()).rejects.toThrow(/webkit\.launch/);
    } finally {
      disarm();
    }
    expect(violations.map((violation) => violation.api)).toEqual([
      "firefox.launch",
      "webkit.launch",
    ]);
  });

  it("refuses the Electron and Android factories too — both reachable with no import", async () => {
    const { violations, disarm } = arm();
    try {
      await expect(_electron.launch()).rejects.toThrow(
        /`_electron\.launch` was called during a test/,
      );
      await expect(_android.launchServer()).rejects.toThrow(
        /`_android\.launchServer` was called during a test/,
      );
      await expect(_android.connect("ws://127.0.0.1:1/x")).rejects.toThrow(
        /`_android\.connect` was called during a test/,
      );
    } finally {
      disarm();
    }
    expect(violations).toHaveLength(3);
  });

  it("names the sanctioned route in the refusal, so the message is actionable", async () => {
    const { disarm } = arm();
    try {
      await expect(chromium.launch()).rejects.toThrow(
        /overridden `browser` FIXTURE/,
      );
      await expect(chromium.launch()).rejects.toThrow(/e2e\/harness\/creation-guard\.ts/);
    } finally {
      disarm();
    }
  });
});

describe("the creation guard, while unarmed", () => {
  it("is not armed outside a test", () => {
    expect(isCreationGuardArmed()).toBe(false);
  });

  it("disarming restores the previous state rather than clearing it blindly", () => {
    const outer = arm();
    expect(isCreationGuardArmed()).toBe(true);
    const inner = arm();
    inner.disarm();
    // Still armed for the outer sink: a nested arm must not leave the guard
    // switched off for the test that is still running.
    expect(isCreationGuardArmed()).toBe(true);
    outer.disarm();
    expect(isCreationGuardArmed()).toBe(false);
  });

  it("delegates instead of refusing, which is what lets the runner launch its worker browser", async () => {
    // A stand-in with the same prototype shape, so nothing real is launched:
    // the patched method is the one on BrowserType.prototype, and it is asked
    // to run while unarmed.
    const proto = Object.getPrototypeOf(chromium) as {
      launch: (this: unknown, ...args: never[]) => Promise<unknown>;
    };
    let delegated = 0;
    const standIn = Object.create(proto) as Record<string, unknown> & {
      launch: () => Promise<unknown>;
    };
    // Shadow the ORIGINAL that the patch closed over is impossible from here,
    // so instead the delegation is observed through `this`: the patched method
    // calls the original with this receiver, and the original is the real
    // `launch`, which would need a browser. Asserting that it does NOT throw
    // the harness error is the whole claim — anything else it does is
    // Playwright's business.
    standIn.name = () => "standin";
    expect(isCreationGuardArmed()).toBe(false);
    await proto.launch
      .call(standIn, { executablePath: "/vizra/does/not/exist" } as never)
      .then(
        () => {
          delegated += 1;
        },
        (error: unknown) => {
          delegated += 1;
          expect(String(error)).not.toMatch(/was called during a test/);
        },
      );
    expect(delegated).toBe(1);
  });
});
