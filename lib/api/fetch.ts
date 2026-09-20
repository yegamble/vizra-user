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
 *  2. RUNTIME. `viewerFetch` always sets `cache: "no-store"`; `publicFetch`
 *     sends exactly `Accept: application/json` and never reads `cookies()`.
 *  3. LINT. `eslint-rules/no-raw-fetch.mjs` keeps every other module out of
 *     global `fetch`, and `eslint-rules/no-identity-headers-in-cached-fetch.mjs`
 *     fails any fetch that pairs an identity header with a cached or
 *     revalidated request — including the ones in this file, which pass only
 *     because `viewerFetch` is explicitly `no-store`.
 *
 * Both are server-only. Importing them into a Client Component would put the
 * internal base URL (and, for `viewerFetch`, a cookie read) in the browser
 * bundle, so both throw on a browser global rather than degrading quietly.
 */

import { cookies } from "next/headers";

import { internalApiBaseUrl, publicOrigin } from "@/lib/config";

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
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
};

export type ViewerFetchOptions = {
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** JSON request body. Sets `Content-Type: application/json`, which core's CSRF check requires. */
  readonly json?: unknown;
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

function timeoutSignal(
  timeoutMs: number | undefined,
  caller: AbortSignal | undefined,
): AbortSignal | undefined {
  if (timeoutMs === undefined) return caller;
  const deadline = AbortSignal.timeout(timeoutMs);
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
  try {
    const res = await fetch(target, {
      method: "GET",
      headers: { Accept: "application/json" },
      ...(freshness === "no-store"
        ? { cache: "no-store" as const }
        : { next: { revalidate: freshness.revalidateSeconds } }),
      signal: timeoutSignal(options.timeoutMs, options.signal),
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

  const session = (await cookies()).get(SESSION_COOKIE);
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
      signal: timeoutSignal(options.timeoutMs, options.signal),
    });
    return await decode<T>(res);
  } catch (error) {
    return failed<T>(error);
  }
}
