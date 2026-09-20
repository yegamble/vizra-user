/**
 * The only two ways vizra-user talks to vizra-core from the server.
 *
 * ADR-003 ("SSR identity"): "`vizra-user` has exactly two fetch helpers:
 * `publicFetch`, which is anonymous by construction, cacheable and keyed on
 * visibility-versioned URLs, and `viewerFetch`, which forwards the session
 * cookie, always sets `cache: 'no-store'` and is never called inside a
 * revalidated cache. A lint rule forbids identity headers in revalidated
 * fetches."
 *
 * The separation is enforced three ways, because a comment is not a control:
 *
 *  1. TYPES. `publicFetch` has no `headers` option and no credential option at
 *     all, so there is no expression a caller can write that adds identity to
 *     a cacheable read. `viewerFetch` has no cache option, so there is no
 *     expression a caller can write that caches an identified read.
 *  2. RUNTIME, asserted by test. `viewerFetch` always sets `cache: "no-store"`
 *     and never `next`, over every method/body/upload combination, and reads
 *     `cookies()` on every path; `publicFetch` sends exactly
 *     `Accept: application/json` and never reads `cookies()`. These are pinned
 *     in `lib/api/fetch.test.ts`, not left to lint — lint reads syntax, and a
 *     refactor can change syntax without changing behaviour.
 *  3. LINT, as the cheapest layer rather than the last one.
 *     `eslint-rules/no-raw-fetch.mjs` keeps every other module out of global
 *     `fetch` and forbids aliasing the binding in EVERY file, this one
 *     included; `eslint-rules/no-identity-headers-in-cached-fetch.mjs` fails
 *     any fetch that pairs an identity header with a cached or revalidated
 *     request, and fails closed on any init it cannot read. Both rules'
 *     limits are written out in their own docblocks.
 *
 * Every request is bounded by `apiTimeoutMs()` — a default and a ceiling, so
 * no call site can wait forever on a core that accepts the connection and
 * never answers.
 *
 * Both are server-only, and that is enforced in two places for two different
 * moments. `import "server-only"` below makes a Client Component importing
 * either helper a `next build` FAILURE — the module never reaches a client
 * chunk. `assertServer` stays as defence in depth for the runtime, because a
 * bundler guarantee and a runtime guarantee fail in different ways and neither
 * subsumes the other. Before `server-only`, the only control was the runtime
 * throw: such an import built green and shipped, and failed in the visitor's
 * browser rather than in CI. (Security review FINDING 4.)
 */

import "server-only";

import { cookies } from "next/headers";

import { apiTimeoutMs, internalApiBaseUrl, publicOrigin } from "@/lib/config";

/** Session cookie name, fixed by ADR-003. `__Host-` prefix: host-locked, secure, path `/`. */
export const SESSION_COOKIE = "__Host-vizra_session";

/**
 * Outcome of one API read. A discriminated union rather than `T | null`:
 * a caller must decide what an error renders, and cannot mistake "absent" for
 * "empty". `reason` carries no message from the wire — an upstream error body
 * is not something to splice into a page.
 */
export type ApiResult<T> =
  | { readonly ok: true; readonly status: number; readonly data: T }
  | {
      readonly ok: false;
      readonly status: number;
      readonly reason: "http" | "network" | "timeout" | "decode";
    };

export type PublicFetchOptions = {
  /**
   * Cache posture for this anonymous read.
   *  - `"no-store"`: a fresh request per render.
   *  - `{ revalidateSeconds: n }`: served from the Next data cache for n
   *    seconds. Legal here **only** because the request carries no identity:
   *    one cached entry is correct for every anonymous viewer.
   *
   * Visibility-versioned URLs (ADR-003) are how a revalidated entry is
   * invalidated early: the version is part of `path`, so a visibility change
   * changes the cache key rather than needing the cache purged.
   */
  readonly freshness: "no-store" | { readonly revalidateSeconds: number };
  /**
   * Shorten this request's deadline. Omitted, `API_TIMEOUT_MS` applies; a
   * value longer than it is clamped to it, so no call site is unbounded.
   */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
};

export type ViewerFetchOptions = {
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** JSON request body. Sets `Content-Type: application/json`, which core's CSRF check requires. */
  readonly json?: unknown;
  /** Shorten this request's deadline; see `PublicFetchOptions.timeoutMs`. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /**
   * Extra header required by core for multipart upload steps (ADR-003:
   * "Multipart upload (chunk, finalize) … the origin check above **and**
   * `X-Vizra-Upload: 1`"). This is the only caller-supplied header either
   * helper accepts, it is a fixed literal, and it carries no identity.
   */
  readonly uploadIntent?: boolean;
};

function assertServer(helper: string): void {
  if (typeof window !== "undefined") {
    throw new Error(
      `${helper} is server-only; it must not be imported into a Client Component.`,
    );
  }
}

function url(path: string): string {
  if (!path.startsWith("/")) {
    throw new Error(`API path must start with "/", got ${JSON.stringify(path)}`);
  }
  return `${internalApiBaseUrl()}${path}`;
}

/**
 * Every request is bounded. `apiTimeoutMs()` is both the default when the
 * caller asks for nothing and the ceiling when it asks for too much, so no
 * call site can make an unbounded request (AGENTS.md: bound request
 * resources). A caller's own signal is composed with the deadline, never
 * replaced by it — cancelling a render must still cancel the request.
 */
function boundedSignal(
  timeoutMs: number | undefined,
  caller: AbortSignal | undefined,
): AbortSignal {
  const ceiling = apiTimeoutMs();
  const effective =
    timeoutMs === undefined ? ceiling : Math.max(1, Math.min(timeoutMs, ceiling));
  const deadline = AbortSignal.timeout(effective);
  return caller ? AbortSignal.any([caller, deadline]) : deadline;
}

async function decode<T>(res: Response): Promise<ApiResult<T>> {
  if (!res.ok) return { ok: false, status: res.status, reason: "http" };
  try {
    return { ok: true, status: res.status, data: (await res.json()) as T };
  } catch {
    return { ok: false, status: res.status, reason: "decode" };
  }
}

function failed<T>(error: unknown): ApiResult<T> {
  const timedOut =
    error instanceof DOMException && error.name === "TimeoutError";
  return { ok: false, status: 0, reason: timedOut ? "timeout" : "network" };
}

/**
 * Anonymous read of vizra-core. Sees exactly what a logged-out visitor sees.
 *
 * There is no way to attach a cookie, a bearer token or any other header: the
 * options type has no slot for one. That is the "anonymous by construction"
 * half of ADR-003 — a cached entry produced here can never contain one
 * viewer's private data served to another.
 */
export async function publicFetch<T>(
  path: string,
  options: PublicFetchOptions,
): Promise<ApiResult<T>> {
  assertServer("publicFetch");
  const freshness = options.freshness;
  // Resolved BEFORE the try: a missing INTERNAL_API_BASE_URL or a malformed
  // path is a configuration or programming error, and must not come back
  // disguised as `reason: "network"` — that is how a misconfigured instance
  // renders as an empty page instead of a loud failure.
  const target = url(path);
  const headers = { Accept: "application/json" };
  const signal = boundedSignal(options.timeoutMs, options.signal);
  try {
    // Two spellings of one request, written out rather than assembled with a
    // spread. `no-identity-headers-in-cached-fetch` fails closed on any init
    // it cannot read in full, and that is deliberate: the shape that hid a
    // revalidated, cookie-bearing request from the first version of the rule
    // was exactly an init the rule could not read. Keeping both inits literal
    // is the price of the rule being able to check this file at all.
    const res =
      freshness === "no-store"
        ? await fetch(target, { method: "GET", headers, cache: "no-store", signal })
        : await fetch(target, {
            method: "GET",
            headers,
            next: { revalidate: freshness.revalidateSeconds },
            signal,
          });
    return await decode<T>(res);
  } catch (error) {
    return failed<T>(error);
  }
}

/**
 * Read or write vizra-core as the current viewer.
 *
 * Forwards only the session cookie — not the whole `Cookie` header, so an
 * unrelated third-party cookie on the instance domain never leaves this
 * process — and is always `cache: "no-store"`. There is no freshness option:
 * an identified response must never enter a shared cache.
 *
 * With no session cookie present the request is still made, anonymously, so
 * core decides the outcome (401/403/404 per its own rules) rather than this
 * layer guessing. A browser-side role check is never authorization (AGENTS.md).
 */
export async function viewerFetch<T>(
  path: string,
  options: ViewerFetchOptions = {},
): Promise<ApiResult<T>> {
  assertServer("viewerFetch");
  const method = options.method ?? "GET";
  // See publicFetch: configuration errors throw, they are not folded into the
  // result union.
  const target = url(path);
  const headers: Record<string, string> = { Accept: "application/json" };

  // Read UNCONDITIONALLY, before any branch. Two reasons: the request must be
  // identical in shape whether or not a session exists, and calling `cookies()`
  // on every path is what keeps Next's own backstop armed — Next throws when
  // `cookies()` is reached inside a `"use cache"` / `unstable_cache` scope, so
  // this call is what makes wrapping viewerFetch in a cache a loud error
  // instead of a silent one. `lib/api/fetch.test.ts` locks that in.
  const jar = await cookies();
  const session = jar.get(SESSION_COOKIE);
  if (session) headers["cookie"] = `${SESSION_COOKIE}=${session.value}`;

  const stateChanging = method !== "GET";
  if (stateChanging) {
    // ADR-003 CSRF decision table: core allows a cookie-authenticated mutation
    // only when `Origin` equals the configured public origin (and the body is
    // JSON). A server-to-server fetch sends no Origin of its own.
    headers["origin"] = publicOrigin();
  }
  if (options.json !== undefined) headers["content-type"] = "application/json";
  if (options.uploadIntent) headers["x-vizra-upload"] = "1";

  try {
    const res = await fetch(target, {
      method,
      headers,
      body: options.json === undefined ? undefined : JSON.stringify(options.json),
      // NON-NEGOTIABLE: this request carries identity, so it must never be
      // cached or revalidated. The lint rule enforces the same thing for any
      // future call site.
      cache: "no-store",
      signal: boundedSignal(options.timeoutMs, options.signal),
    });
    return await decode<T>(res);
  } catch (error) {
    return failed<T>(error);
  }
}
