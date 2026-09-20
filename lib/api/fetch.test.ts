import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  cookie: undefined as { name: string; value: string } | undefined,
  cookiesCalls: 0,
}));

vi.mock("next/headers", () => ({
  cookies: async () => {
    state.cookiesCalls += 1;
    return {
      get: (name: string) =>
        state.cookie && state.cookie.name === name ? state.cookie : undefined,
    };
  },
}));

import { SESSION_COOKIE, publicFetch, viewerFetch } from "./fetch";

type Call = [string, RequestInit & { next?: { revalidate?: number } }];

function lastCall(fetchMock: ReturnType<typeof vi.fn>): Call {
  const call = fetchMock.mock.calls.at(-1);
  if (!call) throw new Error("fetch was not called");
  return call as unknown as Call;
}

function headerNames(init: RequestInit): string[] {
  return Object.keys((init.headers ?? {}) as Record<string, string>).map((h) =>
    h.toLowerCase(),
  );
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  state.cookie = undefined;
  state.cookiesCalls = 0;
  process.env.INTERNAL_API_BASE_URL = "http://api:8080";
  process.env.PUBLIC_ORIGIN = "https://photos.example.org";
  fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ hello: "world" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.INTERNAL_API_BASE_URL;
  delete process.env.PUBLIC_ORIGIN;
  delete process.env.API_TIMEOUT_MS;
});

/**
 * A fetch that never answers, but honours the abort signal the helper passed —
 * including one that is already aborted when the call is made, which is what
 * the platform fetch does.
 */
function neverAnswers() {
  return vi.fn(
    (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init.signal as AbortSignal | undefined;
        if (!signal) return; // an unbounded request: the test that catches it hangs, deliberately
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener("abort", () => reject(signal.reason));
      }),
  );
}

describe("publicFetch", () => {
  it("is anonymous even when a session cookie exists", async () => {
    state.cookie = { name: SESSION_COOKIE, value: "secret-session-id" };

    await publicFetch("/api/v1/instance", { freshness: { revalidateSeconds: 60 } });

    const [url, init] = lastCall(fetchMock);
    expect(url).toBe("http://api:8080/api/v1/instance");
    expect(headerNames(init)).toEqual(["accept"]);
    expect(JSON.stringify(init)).not.toContain("secret-session-id");
    expect(init.credentials).toBeUndefined();
  });

  it("revalidates on the requested window when asked to cache", async () => {
    await publicFetch("/api/v1/instance", { freshness: { revalidateSeconds: 60 } });

    const [, init] = lastCall(fetchMock);
    expect(init.next).toEqual({ revalidate: 60 });
    expect(init.cache).toBeUndefined();
  });

  it("bypasses the data cache when asked for no-store", async () => {
    await publicFetch("/api/v1/instance", { freshness: "no-store" });

    const [, init] = lastCall(fetchMock);
    expect(init.cache).toBe("no-store");
    expect(init.next).toBeUndefined();
  });

  it("reports a non-OK status as a failure rather than empty data", async () => {
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 503 }));

    const result = await publicFetch("/api/v1/instance", { freshness: "no-store" });

    expect(result).toEqual({ ok: false, status: 503, reason: "http" });
  });

  it("reports an unreachable API as a network failure, not a throw", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));

    const result = await publicFetch("/api/v1/instance", { freshness: "no-store" });

    expect(result).toEqual({ ok: false, status: 0, reason: "network" });
  });

  it("refuses a path that is not rooted, so a base URL cannot be swapped", async () => {
    await expect(
      publicFetch("https://evil.example/api", { freshness: "no-store" }),
    ).rejects.toThrow(/must start with/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("viewerFetch", () => {
  it("forwards only the session cookie, never the whole cookie jar", async () => {
    state.cookie = { name: SESSION_COOKIE, value: "secret-session-id" };

    await viewerFetch("/api/v1/me");

    const [, init] = lastCall(fetchMock);
    const headers = init.headers as Record<string, string>;
    expect(headers["cookie"]).toBe(`${SESSION_COOKIE}=secret-session-id`);
    expect(headerNames(init).sort()).toEqual(["accept", "cookie"]);
  });

  it("never caches, with no option to make it cache", async () => {
    state.cookie = { name: SESSION_COOKIE, value: "secret-session-id" };

    await viewerFetch("/api/v1/me");

    const [, init] = lastCall(fetchMock);
    expect(init.cache).toBe("no-store");
    expect(init.next).toBeUndefined();
  });

  it("sends the configured Origin and JSON content type on a mutation", async () => {
    state.cookie = { name: SESSION_COOKIE, value: "secret-session-id" };

    await viewerFetch("/api/v1/albums", { method: "POST", json: { name: "Trip" } });

    const [, init] = lastCall(fetchMock);
    const headers = init.headers as Record<string, string>;
    expect(init.method).toBe("POST");
    expect(headers["origin"]).toBe("https://photos.example.org");
    expect(headers["content-type"]).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ name: "Trip" }));
  });

  it("sends the upload intent header only when the caller asks for it", async () => {
    await viewerFetch("/api/v1/uploads/1/chunks", { method: "PUT", uploadIntent: true });
    expect(
      (lastCall(fetchMock)[1].headers as Record<string, string>)["x-vizra-upload"],
    ).toBe("1");

    await viewerFetch("/api/v1/me");
    expect(
      (lastCall(fetchMock)[1].headers as Record<string, string>)["x-vizra-upload"],
    ).toBeUndefined();
  });

  it("sends no Origin on a read, because core requires none", async () => {
    await viewerFetch("/api/v1/me");

    const headers = lastCall(fetchMock)[1].headers as Record<string, string>;
    expect(headers["origin"]).toBeUndefined();
  });

  it("still asks core when there is no session, instead of guessing 401", async () => {
    state.cookie = undefined;

    const result = await viewerFetch("/api/v1/me");

    const [, init] = lastCall(fetchMock);
    expect(headerNames(init)).toEqual(["accept"]);
    expect(result.ok).toBe(true);
  });

  it("fails loudly when the API base URL is unconfigured", async () => {
    delete process.env.INTERNAL_API_BASE_URL;

    await expect(viewerFetch("/api/v1/me")).rejects.toThrow(
      /INTERNAL_API_BASE_URL is not set/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/**
 * The runtime property, pinned directly.
 *
 * Two independent reviewers defeated the lint rule that was supposed to keep
 * `viewerFetch` uncached — one with the init hoisted into a variable, one with
 * an aliased `fetch`. Lint reads syntax, and syntax can be rearranged without
 * changing behaviour. These cases assert the behaviour itself, over every
 * combination of the options that change the request, so a refactor that keeps
 * lint green and drops `no-store` still fails here.
 */
describe("viewerFetch never caches, whatever it is asked to send", () => {
  const methods = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
  const bodies = [undefined, { name: "Trip" }] as const;
  const intents = [undefined, false, true] as const;

  for (const method of methods) {
    for (const json of bodies) {
      for (const uploadIntent of intents) {
        const label = `${method} json=${json === undefined ? "none" : "yes"} upload=${String(uploadIntent)}`;
        it(`is no-store with no revalidation: ${label}`, async () => {
          state.cookie = { name: SESSION_COOKIE, value: "secret-session-id" };

          await viewerFetch("/api/v1/thing", { method, json, uploadIntent });

          const [, init] = lastCall(fetchMock);
          expect(init.cache).toBe("no-store");
          expect(init.next).toBeUndefined();
          // No option spelling may reintroduce a cache key either.
          expect(JSON.stringify(init)).not.toContain("revalidate");
        });
      }
    }
  }

  it("consults cookies() on every path, session or not", async () => {
    // This is what keeps Next's own backstop armed: Next throws when cookies()
    // is reached inside a "use cache" / unstable_cache scope, so an
    // unconditional read turns "someone wrapped viewerFetch in a cache" into a
    // loud error. An optimisation that skipped the read when no session is
    // present would disarm it silently.
    state.cookie = undefined;
    await viewerFetch("/api/v1/me");
    expect(state.cookiesCalls).toBe(1);

    state.cookie = { name: SESSION_COOKIE, value: "secret-session-id" };
    await viewerFetch("/api/v1/me", { method: "POST", json: {} });
    expect(state.cookiesCalls).toBe(2);
  });

  it("publicFetch never consults cookies(), so it cannot become identified", async () => {
    state.cookie = { name: SESSION_COOKIE, value: "secret-session-id" };
    await publicFetch("/api/v1/instance", { freshness: { revalidateSeconds: 60 } });
    expect(state.cookiesCalls).toBe(0);
  });
});

/**
 * Bounded requests (meta AGENTS.md: "bound request, file, decoder, subprocess
 * and queue resources"). A core that accepts the connection and never answers
 * must not hold an SSR render open forever.
 */
describe("every request is bounded", () => {
  it("publicFetch times out at the configured default when given none", async () => {
    process.env.API_TIMEOUT_MS = "20";
    fetchMock = neverAnswers();
    vi.stubGlobal("fetch", fetchMock);

    const result = await publicFetch("/api/v1/instance", { freshness: "no-store" });

    expect(result).toEqual({ ok: false, status: 0, reason: "timeout" });
  });

  it("viewerFetch times out at the configured default when given none", async () => {
    process.env.API_TIMEOUT_MS = "20";
    fetchMock = neverAnswers();
    vi.stubGlobal("fetch", fetchMock);

    const result = await viewerFetch("/api/v1/me");

    expect(result).toEqual({ ok: false, status: 0, reason: "timeout" });
  });

  it("honours a shorter caller deadline", async () => {
    process.env.API_TIMEOUT_MS = "60000";
    fetchMock = neverAnswers();
    vi.stubGlobal("fetch", fetchMock);

    const started = Date.now();
    const result = await viewerFetch("/api/v1/me", { timeoutMs: 20 });

    expect(result).toEqual({ ok: false, status: 0, reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("clamps a caller deadline longer than the ceiling, so no call site is unbounded", async () => {
    process.env.API_TIMEOUT_MS = "20";
    fetchMock = neverAnswers();
    vi.stubGlobal("fetch", fetchMock);

    const result = await publicFetch("/api/v1/instance", {
      freshness: "no-store",
      timeoutMs: 600_000,
    });

    expect(result).toEqual({ ok: false, status: 0, reason: "timeout" });
  });

  it("lets the caller's own abort cancel the request, deadline or no deadline", async () => {
    process.env.API_TIMEOUT_MS = "60000";
    fetchMock = neverAnswers();
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    const pending = viewerFetch("/api/v1/me", { signal: controller.signal });
    controller.abort();

    // The deadline is composed with the caller's signal, not substituted for
    // it, so cancelling a render still cancels the request. A caller-initiated
    // abort is not a TimeoutError, so it is not reported as one.
    expect(await pending).toEqual({ ok: false, status: 0, reason: "network" });
  });

  it("always passes a signal, even with no options at all", async () => {
    await viewerFetch("/api/v1/me");
    expect(lastCall(fetchMock)[1].signal).toBeInstanceOf(AbortSignal);

    await publicFetch("/api/v1/instance", { freshness: "no-store" });
    expect(lastCall(fetchMock)[1].signal).toBeInstanceOf(AbortSignal);
  });
});
