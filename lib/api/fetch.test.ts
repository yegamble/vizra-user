import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  cookie: undefined as { name: string; value: string } | undefined,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      state.cookie && state.cookie.name === name ? state.cookie : undefined,
  }),
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
});

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
