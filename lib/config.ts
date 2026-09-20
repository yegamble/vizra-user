/**
 * Server-side runtime configuration.
 *
 * Every value is read lazily from the environment at call time, never frozen
 * into the build: one image serves any host (ADR-002 — the env file is boot
 * truth). Nothing here is `NEXT_PUBLIC_*`, so none of it reaches the browser
 * bundle.
 *
 * A missing value throws. A frontend that silently fell back to a default
 * origin would send a viewer's session cookie somewhere nobody configured.
 */

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(
      `${name} is not set. vizra-user needs it to reach vizra-core; see AGENTS.md.`,
    );
  }
  return value.trim();
}

/**
 * Base URL this process uses to reach vizra-core, server to server — inside the
 * compose network, not through the public hostname. No trailing slash.
 */
export function internalApiBaseUrl(): string {
  return required("INTERNAL_API_BASE_URL").replace(/\/+$/, "");
}

/**
 * The instance's public origin (scheme + host [+ port]), e.g.
 * `https://photos.example.org`. `viewerFetch` sends it as `Origin` on
 * state-changing requests, which is exactly what core's CSRF check compares
 * against (ADR-003, CSRF decision table).
 */
export function publicOrigin(): string {
  return required("PUBLIC_ORIGIN").replace(/\/+$/, "");
}

/** Fallback when `API_TIMEOUT_MS` is unset. Ten seconds. */
export const DEFAULT_API_TIMEOUT_MS = 10_000;

/**
 * Deadline for one request to vizra-core, in milliseconds: both the **default**
 * when a caller asks for none and the **ceiling** a caller cannot exceed.
 *
 * AGENTS.md requires bounded request resources. Without a deadline, a core
 * that accepts a connection and never answers holds an SSR render open
 * indefinitely: requests pile up on the Node process with no bound, and the
 * visitor waits forever instead of seeing the real failure state the helpers
 * are built to render. Undici has defaults of its own, but they are not this
 * repository's reviewed decision, and `ApiResult`'s `reason: "timeout"` exists
 * precisely because these helpers mean to own it.
 *
 * A caller may pass a SHORTER `timeoutMs` (a page that would rather degrade
 * than wait); a longer one is clamped to this ceiling, so no single call site
 * can opt out of the bound.
 *
 * Unset, empty, non-numeric, zero or negative all fall back to the default
 * rather than disabling the bound — "unbounded" must not be reachable by
 * typo.
 */
export function apiTimeoutMs(): number {
  const raw = process.env.API_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_API_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_API_TIMEOUT_MS;
  return Math.floor(parsed);
}
