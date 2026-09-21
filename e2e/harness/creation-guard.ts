/**
 * THE CREATION GUARD — closing "a context or browser the harness was never
 * handed", at RUNTIME.
 *
 * WHAT THIS IS FOR. `e2e/harness/browser-errors.ts` guards the browser the
 * fixture is handed, by wrapping that instance's OWN `newContext` / `newPage`.
 * An independent verifier measured three routes that produce a context without
 * touching those own properties, each from a spec in `e2e/specs/` importing
 * only the harness `test`, each passing the COMPLETE gate on a page that 404s a
 * sub-resource and throws on every load (lint green, lane exit 0,
 * `20 passed, coverage floor: OK (10/9 10/9), harness stamp: OK (20 verified)`,
 * out-of-process check exit 0):
 *
 *     Object.getPrototypeOf(browser).newContext.call(browser)
 *     browser.browserType().launch()
 *     playwright.chromium.launchPersistentContext(dir)
 *
 * None imports a Playwright package, so `vizra/no-unguarded-playwright-import`
 * never saw them. AGENTS.md said, truthfully, "nothing catches these today".
 * This module is what makes that sentence obsolete.
 *
 * TWO DIFFERENT ANSWERS, BECAUSE THEY ARE TWO DIFFERENT PROBLEMS.
 *
 *   1. A CONTEXT ON A BROWSER THE HARNESS HOLDS — the prototype route — is
 *      GUARDED, not merely refused. The context is registered with the active
 *      guard the moment it is created, so its console, page errors, failed
 *      requests and >= 400 responses are recorded exactly as the default
 *      context's are. Guarding rather than refusing matters: a context created
 *      and CLOSED inside the test body would be gone by teardown, so a
 *      teardown-only check would never see it.
 *
 *   2. A BROWSER, OR A PERSISTENT CONTEXT, THAT THE HARNESS WAS NEVER HANDED is
 *      REFUSED. `browser.browserType().launch()` and
 *      `chromium.launchPersistentContext(dir)` produce objects on a second
 *      browser, which `browser.contexts()` cannot see by construction — a
 *      separately launched browser has its own contexts. So the call throws,
 *      AND the attempt is recorded, so that a spec which swallows the throw
 *      still fails in teardown.
 *
 *      There IS a sanctioned way to use your own browser: override the
 *      `browser` FIXTURE. Playwright then hands that browser to
 *      `vizraHarnessGuard`, which guards it — demonstration D13g. Worker and
 *      test fixtures are resolved before this guard is armed, so that route
 *      keeps working; only a launch DURING the test body is refused.
 *
 * WHY THE PROTOTYPE AND NOT THE INSTANCE. `launch`, `launchServer`,
 * `launchPersistentContext`, `connect` and `connectOverCDP` are prototype
 * methods on `BrowserType` — measured against the installed 1.63.0, not
 * assumed: none is an own property of `playwright.chromium`, and `chromium`,
 * `firefox`, `webkit` and `browser.browserType()` all share ONE prototype
 * object, whose own prototype (`ChannelOwner`) has none of those names. So
 * patching that prototype closes the method and there is no second hop to
 * escape to. `Object.getPrototypeOf(chromium).launch` IS the patched function.
 *
 * WHY MODULE LOAD, AND WHY A BROWSER CAN NEVER HAND OUT AN UNPATCHED PROTOTYPE.
 * The escape a wrapper always has is "capture the original before it is
 * wrapped". This module is evaluated when `e2e/harness/test.ts` is imported,
 * which `playwright.config.ts` does, which every worker evaluates BEFORE it
 * loads any test file (`WorkerMain.runTestGroup` calls `_loadIfNeeded()` before
 * `loadTestFile`). So no spec can observe an unpatched `BrowserType` method.
 *
 * `Browser.prototype` needs a Browser instance to reach, and there is none at
 * module load — playwright-core exports no `Browser` class. It is patched
 * instead at the only moment a Browser first exists: inside the already-patched
 * `launch` / `connect` / `connectOverCDP`, before the Browser is returned to
 * whoever asked for it, and again from the harness fixture as a belt. A spec
 * therefore cannot hold a Browser whose prototype is not already patched —
 * not from the `browser` fixture, not from an overridden one, not from
 * `beforeAll`.
 *
 * WHEN IT IS ARMED. `vizraHarnessGuard` arms it for the duration of one test
 * and disarms it in `finally`. Unarmed, every patch is a plain delegation with
 * no behaviour change at all — which is what lets the runner launch its own
 * worker browser through the same patched method.
 *
 * NOT CLOSED HERE, and stated rather than implied:
 *   - `e2e/harness/**` itself. This module can be edited; that is the reviewed
 *     directory `.github/CODEOWNERS` covers, and the canary's
 *     D12 pairs make neutering the listeners a named CI failure.
 *   - Playwright's private client internals (`playwright._connection`,
 *     `BrowserType.prototype._connect`, `browser._innerNewContext`). Reaching
 *     an underscore-prefixed client channel is not a spelling of an honest
 *     idiom; no automated control refuses it.
 *   - The `request` fixture (`APIRequestContext`). Out of the guard's scope by
 *     design — see `browser-errors.ts`.
 */

import type { Browser, BrowserContext, Page } from "@playwright/test";
import { _android, _electron, chromium } from "@playwright/test";

/** One refused attempt to obtain a browser the harness was never handed. */
export type CreationViolation = {
  /** The API as a reader would name it, e.g. `chromium.launchPersistentContext`. */
  readonly api: string;
  /** The full message thrown at the call site, repeated in the teardown failure. */
  readonly detail: string;
};

/**
 * What an armed test exposes to the patches. Deliberately tiny: the patches
 * must not need to know anything about policies, allow-lists or Playwright's
 * test runner.
 */
export type CreationGuardSink = {
  /** Attach the browser-error listeners to a context created during the test. */
  registerContext(context: BrowserContext): void;
  /** Record a refused attempt, so a swallowed throw still fails the test. */
  recordViolation(violation: CreationViolation): void;
};

let active: CreationGuardSink | null = null;

/**
 * Arm the guard for one test. Returns the disarm function, which only clears
 * the slot if it is still ours — nesting cannot leave the guard armed for the
 * wrong test, and nothing here ever throws, because a control that can make the
 * lane flaky is not a control.
 */
export function armCreationGuard(sink: CreationGuardSink): () => void {
  const previous = active;
  active = sink;
  return () => {
    if (active === sink) active = previous;
  };
}

/** Test-only accessor: is a test currently armed? Used by the harness tests. */
export function isCreationGuardArmed(): boolean {
  return active !== null;
}

function refuse(api: string, advice: string): never {
  const detail =
    `vizra harness: \`${api}\` was called during a test, which would produce a browser or ` +
    "context the harness was never handed — and therefore one whose console errors, uncaught " +
    "exceptions, failed requests and HTTP >= 400 responses nothing is watching. " +
    `${advice} ` +
    "See e2e/harness/creation-guard.ts and AGENTS.md § Residuals.";
  active?.recordViolation({ api, detail });
  throw new Error(detail);
}

const OWN_BROWSER_ADVICE =
  "If a slice genuinely needs its own browser, the sanctioned route is an overridden `browser` " +
  "FIXTURE, which Playwright resolves BEFORE this guard is armed and then hands to " +
  "`vizraHarnessGuard`, which guards it (demonstration D13g). Write that fixture under " +
  "`e2e/harness/**`, not in the spec: `vizra/no-unguarded-playwright-import` refuses the method " +
  "names in `e2e/specs/**` and `e2e/demos/**`, and a second browser is a reviewed harness change " +
  "rather than a line in a test.";

const NO_ALTERNATIVE_ADVICE =
  "There is no sanctioned use of this API from a spec: the harness drives one application in " +
  "one browser.";

/* -------------------------------------------------------------------------- */
/* Browser.prototype — register, do not refuse                                 */
/* -------------------------------------------------------------------------- */

const patchedBrowserPrototypes = new WeakSet<object>();

type AnyFn = (...args: never[]) => unknown;

/**
 * Patch `Browser.prototype.newContext` / `newPage` so that a context created by
 * ANY route through them — the instance wrapper in `guardBrowser`, the
 * prototype method called directly, `newPage`'s internal `this.newContext` — is
 * registered with the armed test. Registration is idempotent, so the layers
 * cannot double-count.
 *
 * Called with the first Browser this process sees, from inside the patched
 * `launch` / `connect` / `connectOverCDP`, and again from the harness fixture.
 */
export function patchBrowserPrototype(browser: Browser): void {
  const proto: object | null = Object.getPrototypeOf(browser) as object | null;
  if (proto === null || patchedBrowserPrototypes.has(proto)) return;
  patchedBrowserPrototypes.add(proto);

  const holder = proto as unknown as Record<string, AnyFn>;

  const originalNewContext = holder.newContext;
  if (typeof originalNewContext === "function") {
    holder.newContext = async function patchedNewContext(
      this: unknown,
      ...args: never[]
    ): Promise<unknown> {
      const context = (await originalNewContext.apply(this, args)) as BrowserContext;
      active?.registerContext(context);
      return context;
    } as unknown as AnyFn;
  }

  const originalNewPage = holder.newPage;
  if (typeof originalNewPage === "function") {
    holder.newPage = async function patchedNewPage(
      this: unknown,
      ...args: never[]
    ): Promise<unknown> {
      const page = (await originalNewPage.apply(this, args)) as Page;
      active?.registerContext(page.context());
      return page;
    } as unknown as AnyFn;
  }
}

/* -------------------------------------------------------------------------- */
/* BrowserType.prototype, _electron, _android — refuse while armed             */
/* -------------------------------------------------------------------------- */

/**
 * `launchServer` is here with the rest: it hands back a `wsEndpoint`, and
 * `connect` would then turn that into a Browser. Refusing both ends is cheaper
 * than reasoning about which half is load-bearing.
 */
const REFUSED_BROWSER_TYPE_METHODS = [
  "launch",
  "launchPersistentContext",
  "launchServer",
  "connect",
  "connectOverCDP",
] as const;

/** Names by which a reader would recognise the object the method sits on. */
function browserTypeLabel(receiver: unknown, method: string): string {
  const name = (receiver as { name?: () => string } | null)?.name;
  const which = typeof name === "function" ? name.call(receiver) : "browserType";
  return `${which}.${method}`;
}

function patchRefusedMethods(
  holder: Record<string, AnyFn>,
  methods: readonly string[],
  label: (receiver: unknown, method: string) => string,
  advice: string,
  afterUnarmed?: (result: unknown) => void,
): void {
  for (const method of methods) {
    const original = holder[method];
    if (typeof original !== "function") continue;
    holder[method] = async function patchedRefusable(
      this: unknown,
      ...args: never[]
    ): Promise<unknown> {
      // Refuse BEFORE calling through, so nothing is launched and left behind
      // for the worker to trip over at exit.
      if (active !== null) refuse(label(this, method), advice);
      const result = await original.apply(this, args);
      afterUnarmed?.(result);
      return result;
    } as unknown as AnyFn;
  }
}

/**
 * The one-time install. Runs at module load — i.e. while `playwright.config.ts`
 * is being evaluated, before any test file exists in the worker.
 */
function install(): void {
  const browserTypeProto = Object.getPrototypeOf(chromium) as object | null;
  if (browserTypeProto !== null) {
    patchRefusedMethods(
      browserTypeProto as unknown as Record<string, AnyFn>,
      REFUSED_BROWSER_TYPE_METHODS,
      browserTypeLabel,
      OWN_BROWSER_ADVICE,
      // The Browser the RUNNER launches (or an overridden `browser` fixture
      // launches) comes back through here, unarmed. That is the earliest moment
      // a Browser exists in this process, and patching its prototype here is
      // what makes an unpatched `Browser.prototype` unreachable from a spec.
      (result) => {
        const browser = asBrowser(result);
        if (browser !== null) patchBrowserPrototype(browser);
      },
    );
  }

  // `_electron.launch()` yields an ElectronApplication with its own
  // BrowserContext; `_android` yields a device that can drive one. Neither is
  // installed or used here, and both are reachable from the built-in
  // `playwright` fixture with no import, so both are refused rather than left
  // as an unstated hole.
  const electronProto = Object.getPrototypeOf(_electron) as object | null;
  if (electronProto !== null) {
    patchRefusedMethods(
      electronProto as unknown as Record<string, AnyFn>,
      ["launch"],
      (_receiver, method) => `_electron.${method}`,
      NO_ALTERNATIVE_ADVICE,
    );
  }

  const androidProto = Object.getPrototypeOf(_android) as object | null;
  if (androidProto !== null) {
    patchRefusedMethods(
      androidProto as unknown as Record<string, AnyFn>,
      ["launchServer", "connect"],
      (_receiver, method) => `_android.${method}`,
      NO_ALTERNATIVE_ADVICE,
    );
  }
}

/** A Browser, a persistent BrowserContext's browser, or neither. */
function asBrowser(result: unknown): Browser | null {
  const candidate = result as
    | { contexts?: unknown; browser?: unknown }
    | null
    | undefined;
  if (candidate == null) return null;
  if (typeof candidate.contexts === "function") return result as Browser;
  if (typeof candidate.browser === "function") {
    const owner = (candidate as BrowserContext).browser();
    return owner ?? null;
  }
  return null;
}

install();
